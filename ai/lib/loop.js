'use strict';

/* ============================================================
 * lib/loop.js —— 闭环调度（forge 版）。
 *
 * 每轮只有 4 次 LLM 调用（提速、省 token）：
 *   ① L0 记忆检索（一次调用，挑相关记忆）
 *   ② 处境&意图（合并层）：一次调用 → {understanding, intent, types[]}
 *   ③ 决策&落地（合并层）：一次调用 → {thought, say?, primitive, params}
 *   ④ L5 反思（更新三层记忆 + 目标）
 *
 * 之后按 types 机械筛选原语子集（子集过小则放宽为全部类型）→ 通过 bridge 发给 mod 执行。
 *
 * 关键设计：
 * · 主人/玩家说的话 = 最高优先级，且本轮必须回应（先 say 再做事）。
 * · 判断"是否卡住"一律以实时状态为准（记忆只描述过去）。
 * · 做不到就把失败原因喂回重想；绝不 fallback 到硬编码动作。
 * ============================================================ */

const cfg = require('../config');
const log = require('./log');
const { callJSON, sleep } = require('./llm');
const observe = require('./observe');
const intent = require('./intent');
const pr = require('./primitives');

const trunc = (s, n) => (s == null ? '' : String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

function renderPrimitives(list) {
  return list.map((p) => {
    const ps = p.params && Object.keys(p.params).length
      ? '(' + Object.keys(p.params).map((k) => `${k}:${p.params[k]}`).join(', ') + ')'
      : '()';
    return `· ${p.name}${ps}　${p.desc}`;
  }).join('\n');
}

function renderTypes() {
  return pr.allTypes().map((t) => `· ${t}：${pr.TYPE_GROUPS[t]}`).join('\n');
}

class Loop {
  constructor(ctx, memory, goals) {
    this.ctx = ctx;              // { bridge, config, master }
    this.mem = memory;
    this.goals = goals;
    this.running = false;
    this.n = 0;
    this.shortTerm = [];
    this.lastResult = null;
    this.failureHint = '';
    this.failStreak = new Map();
    this.attempts = [];       // 最近「行动→结果」台账
    this.analysisEvery = 5;   // 每 N 轮自我分析
    this.userNudge = '';      // 终端里「你」对 AI 说的话
  }

  async start() { this.running = true; log.ok('loop', '闭环启动：每一轮都会真实调用 LLM 思考。'); this._run(); }
  stop() { this.running = false; }

  async _run() {
    while (this.running) {
      try { await this.tick(); } catch (e) { log.error('loop', '本轮异常：' + e.message); }
      await sleep(this.ctx.config.loop.stepDelayMs);
    }
  }

  async tick() {
    const state = this.ctx.bridge.getState();
    if (!state) { log.warn('loop', '尚未收到客户端 mod 状态，等待…'); return; }
    if (!this._loggedKeys) { this._loggedKeys = true; log.info('loop', '已收到客户端状态，字段：' + Object.keys(state).join(', ')); }
    if (!state.pos) { log.warn('loop', '客户端状态缺少位置（玩家可能未进入世界），等待…'); return; }
    if (!this.ctx.bridge.isFresh(this.ctx.config.loop.stateStaleMs)) {
      log.warn('loop', '客户端 mod 状态已过期（可能卡顿/断连），本轮跳过'); return;
    }

    this.n++;
    const rounds = this.n;

    if (this.n > 1 && this.n % this.analysisEvery === 0) {
      await this._selfAnalyze().catch((e) => log.warn('mem', '自分析失败：' + e.message));
    }

    // ---- 聊天：过滤掉"自己说的话"，并把玩家/主人的话单列为最高优先级 ----
    // 位移量反馈：上一轮到现在到底移动了多少格（治「以为自己卡住却其实在动/其实没动」）
    let movedText = null;
    if (this.prevPos && state.pos) {
      const dx = state.pos.x - this.prevPos.x, dy = state.pos.y - this.prevPos.y, dz = state.pos.z - this.prevPos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      movedText = `上一轮到现在，你实际移动了约 ${d.toFixed(1)} 格（Δx=${dx.toFixed(1)} Δy=${dy.toFixed(1)} Δz=${dz.toFixed(1)}）。`;
      if (d < 0.5) movedText += ' —— 你几乎没有移动！如果这就是你说的"卡住"，立刻换做法：用 dig 挖穿挡路的方块，或朝任意水平方向 move_dir 走 2~3 秒。';
    }
    this.prevPos = state.pos ? { x: state.pos.x, y: state.pos.y, z: state.pos.z } : this.prevPos;
    const self = String(state.self || this.ctx.config.self || '').trim();
    const rawChat = Array.isArray(state.chat) ? state.chat : [];
    const notMine = rawChat.filter((c) => !(self && String(c.user || '') === self));
    const chat = notMine.slice(-10).map((c) => `${c.user ? c.user + '：' : ''}${c.msg}`);
    const userTalk = notMine.filter((c) => String(c.user || '').trim()).slice(-6).map((c) => `${c.user}：${c.msg}`);
    if (this.userNudge) userTalk.unshift(this.userNudge);
    const hasUserMsg = userTalk.length > 0;

    let obs = observe.buildObservation(this.ctx, {
      shortTerm: this.shortTerm,
      longTerm: ['<<LONGTERM>>'],
      lastResult: this.lastResult,
      goal: this.goals.current,
      chat,
      userTalk,
      attempts: this.attempts,
      events: [],
      failureHint: this.failureHint,
      moved: movedText
    });
    // L0 记忆检索：不是每轮都做（省一次调用、提速）——开局 + 每 3 轮一次
    let longTerm = [];
    if (this.n === 1 || this.n % 3 === 0) {
      longTerm = await this.mem.retrieve(observe.situationLine(this.ctx), obs).catch(() => []);
    }
    obs = obs.replace('<<LONGTERM>>', longTerm.length ? longTerm.join('\n') : '（本轮未检索长期记忆）');

    log.brain(`── 第 ${rounds} 轮 ──`);

    // ---- 合并层①：处境理解 + 意图（一次调用） ----
    const ui = await this._understandIntent(obs, hasUserMsg);
    log.brain('处境：' + trunc(ui.understanding, 150));
    log.brain('意图：' + trunc(ui.intent, 140) + '　[类型 ' + (ui.types.join('/') || '无') + ']');

    // ---- L3 机械筛选（子集过小则放宽菜单） ----
    let subset = pr.byTypes(ui.types);
    if (subset.length < 6) {
      subset = pr.byTypes(pr.allTypes());
      log.warn('loop', '可用原语过少，本轮放宽为全部类型（只放宽菜单，不替它决策）');
    }
    log.brain('可用原语：' + subset.map((p) => p.name).join(', '));

    // ---- 合并层②：规划（一次调用，输出 1~5 步计划，之后连续执行不再调 LLM） ----
    const plan = await this._plan(ui.understanding, ui.intent, subset, hasUserMsg);
    if (!plan.ok) {
      log.warn('act', '规划失败，未执行任何动作：' + plan.reason);
      this.shortTerm.push(`#${rounds} 想行动但没能规划出步骤（${plan.reason}）`);
      this._capShortTerm();
      this.lastResult = { action: '（未规划）', attempt: plan.rawDecision || '', ok: false, detail: plan.reason };
      this.failureHint = '你上一轮想把意图变成动作，但失败了：' + plan.reason +
        '。请检查参数是否完整（例如 move_to 必须给出 x,y,z 三个数字；名字要用英文注册名），或换一条能执行的路子。';
      this._pushAttempt({ r: rounds, action: '（未规划）', params: { intent: plan.rawDecision || '' }, ok: false, detail: plan.reason });
      return;
    }

    if (plan.say) {
      try { await pr.execute('chat', { message: plan.say }, this.ctx); log.act('说：' + trunc(plan.say, 120)); log.plain('\x1b[35m[AI 对游戏说]\x1b[0m ' + plan.say); } catch (_) {}
      this.userNudge = '';
    }

    // ---- 连续执行计划里的每一步（中间不再调用 LLM） ----
    let result = null, stepIdx = 0;
    for (const step of plan.steps) {
      stepIdx++;
      log.act(`执行(${stepIdx}/${plan.steps.length}) ${step.primitive} ${JSON.stringify(step.params)}`);
      try { result = await pr.execute(step.primitive, step.params, this.ctx); }
      catch (e) { result = { ok: false, detail: '执行抛异常：' + e.message }; }
      log.act(`结果：${result.ok ? '✓ 成功' : '✗ 失败'} — ${result.detail}`);
      this.shortTerm.push(`#${rounds}.${stepIdx} ${step.primitive}(${JSON.stringify(step.params)}) → ${result.ok ? '成功' : '失败'}：${trunc(result.detail, 100)}`);
      this._pushAttempt({ r: rounds, action: step.primitive, params: step.params, ok: result.ok, detail: result.detail });
      this._trackFailures(step.primitive, step.params, result);
      if (step.primitive === 'chat' || step.primitive === 'whisper') this.userNudge = '';
      if (!result.ok) break;   // 某步失败 → 停止计划，交给下一轮重新规划
    }
    this._capShortTerm();
    const lastStep = plan.steps[Math.max(0, stepIdx - 1)] || { primitive: '?', params: {} };
    const finalResult = result || { ok: false, detail: '计划为空' };
    this.lastResult = { action: lastStep.primitive, attempt: plan.thought, params: lastStep.params, ok: finalResult.ok, detail: finalResult.detail };

    await this._reflect(lastStep.primitive, lastStep.params, finalResult).catch((e) => log.warn('mem', '反思失败：' + e.message));
  }

  _capShortTerm() {
    const n = this.ctx.config.loop.shortTermLen;
    if (this.shortTerm.length > n) this.shortTerm = this.shortTerm.slice(-n);
  }

  _trackFailures(primitive, params, result) {
    const sig = `${primitive} ${JSON.stringify(params)}`;
    if (result.ok) { this.failStreak.delete(sig); this.failureHint = ''; return; }
    const c = (this.failStreak.get(sig) || 0) + 1;
    this.failStreak.set(sig, c);
    if (c >= 3) {
      this.failureHint = `你已经连续 ${c} 次尝试「${sig}」失败。不要再重复它了，换一种完全不同的做法。`;
      // 这是**具体案例**（含坐标/参数），不是可迁移的规律 → 写进情景记忆。
      // 语义记忆只由 L5 反思层写入「它自己总结的规律」，不由代码硬塞。
      this.mem.addEpisodic(`连续 ${c} 次尝试「${sig}」失败（${trunc(result.detail, 80)}）。`);
      this.failStreak.delete(sig);
    } else {
      this.failureHint = '';
    }
  }

  _pushAttempt(rec) {
    this.attempts.push(rec);
    if (this.attempts.length > 6) this.attempts = this.attempts.slice(-6);
  }

  /** 从终端注入一条「你对 AI 说的话」（最高优先级，下一轮必须回应） */
  injectUserMsg(text, who) {
    const from = who || this.ctx.config.master || '玩家';
    this.userNudge = `【主人·${from}】${String(text).slice(0, 300)}`;
    log.info('cli', `已注入你对 AI 的话：${String(text).slice(0, 120)}`);
  }

  /** 自我分析（蜕变） */
  async _selfAnalyze() {
    if (!this.attempts.length) return;
    const list = this.attempts
      .map((a) => `- 第${a.r}轮 ${a.action} ${JSON.stringify(a.params)} → ${a.ok ? '成功' : '失败'}：${trunc(a.detail, 100)}`)
      .join('\n');
    const usr = [
      '这是你最近若干轮「行动 → 结果」的真实记录：', list, '',
      '请做一次自我分析：找出你反复失败或低效的模式，总结成 1~3 条**下次遇到类似处境可直接照做的规律**。',
      '只输出 JSON：{"lessons":["规律1","规律2"],"note":"一句话自我评价"}'
    ].join('\n');
    const { obj } = await callJSON(
      this._sys('当前角色：自我分析层。你从自己的历史里学习，提炼出能真正改变你以后行为的规律。'),
      usr, { temperature: 0.4, maxTokens: 800, label: '自分析' });
    if (Array.isArray(obj.lessons)) for (const s of obj.lessons) if (s) this.mem.addSemantic('（经验）' + s);
    if (obj.note) log.mem('自分析：' + trunc(obj.note, 160));
  }

  _sys(role) {
    return [cfg.identity.text, '', '你现在通过「分层思考」运作：先理解处境，再形成意图，最后落到一个具体动作。', role].join('\n');
  }

  /** 合并层①：处境理解 + 意图 + 需要的动作类型 */
  async _understandIntent(obs, hasUserMsg) {
    const usr = [
      '这是你此刻的观察（含实时状态、环境、记忆、上一轮结果、目标）：', obs, '',
      hasUserMsg ? '⚠ 注意：上面【有人在对你说话】里有玩家/主人的话——本轮你必须先处理它：理解它、并打算回应它。\n' : '',
      '可用动作类型（只能用这些类型名，宁多勿少——把达成意图所需的所有类型都列上）：', renderTypes(), '',
      '请输出 JSON：',
      '{"understanding":"你此刻的真实处境与最想做的事（2~4句）",',
      ' "intent":"这一轮你具体想达成什么",',
      ' "types":["move","interact"]}'
    ].join('\n');
    try {
      const { obj } = await callJSON(
        this._sys('当前角色：处境理解 + 意图层。你必须以【实时状态】为准判断自己现在的处境（记忆只描述过去，不能当作现状）。'),
        usr, { temperature: 0.5, maxTokens: 500, label: '处境&意图' });
      const valid = pr.allTypes();
      const types = Array.isArray(obj.types) ? obj.types.filter((t) => valid.includes(t)) : [];
      return { understanding: String(obj.understanding || '').trim(), intent: String(obj.intent || '').trim(), types };
    } catch (e) {
      log.warn('loop', '处境&意图解析失败：' + e.message);
      return { understanding: '', intent: '', types: [] };
    }
  }

  /** 规划层：一次产出 1~5 步可执行计划（含可选回话） */
  async _plan(understanding, userIntent, subset, hasUserMsg) {
    const maxReparse = this.ctx.config.loop.maxReparse;
    let feedback = '';
    let rawDecision = '';
    for (let attempt = 1; attempt <= maxReparse; attempt++) {
      const usr = [
        '你的处境理解：', understanding,
        '你的意图：', userIntent, '',
        hasUserMsg ? '⚠ 有玩家/主人在跟你说话：本轮你**必须**在 say 字段里给出你的回应（口语、简短、像真人）。\n' : '',
        '当前可用的原语（steps 里的 primitive 必须是其中之一）：', renderPrimitives(subset), '',
        feedback ? ('上一次没能落地，原因：' + feedback + '\n请换一种可行、参数完整的方式。\n') : '',
        '请把意图拆成 1~5 个**有序、可直接执行**的步骤（能一口气做完的连贯动作），不要只写一步就停。',
        '只输出 JSON：',
        '{',
        '  "thought": "一句话你的决定",',
        hasUserMsg ? '  "say": "你要对玩家说的话（本轮必填）",' : '  "say": "想顺便说的话，没有就留空",',
        '  "steps": [ { "primitive": "原语名", "params": { } } ]',
        '}'
      ].join('\n');
      try {
        const { obj } = await callJSON(
          this._sys('当前角色：规划层。把意图拆成 1~5 个有序的原子动作，参数要完整（英文注册名 + 数字坐标）。'),
          usr, { temperature: 0.35, maxTokens: 700, label: '规划' });
        rawDecision = JSON.stringify(obj).slice(0, 300);
        const say = obj.say ? String(obj.say).slice(0, 200) : '';
        if (hasUserMsg && !say) { feedback = '有玩家/主人在对你说话，你必须在 say 字段里回答他一句（口语）。'; log.warn('act', feedback); continue; }
        let steps = Array.isArray(obj.steps) ? obj.steps : [];
        if (!steps.length && obj.primitive) steps = [{ primitive: obj.primitive, params: obj.params || {} }];
        const valid = [];
        let bad = '';
        for (const s of steps) {
          const def = subset.find((p) => p.name === s.primitive);
          if (!def) { bad = `原语「${s.primitive}」不在可用列表里`; break; }
          const params = (s.params && typeof s.params === 'object') ? s.params : {};
          const check = intent.validate(params, def.params);
          if (!check.ok) { bad = `步骤 ${s.primitive}：${check.reason}`; break; }
          valid.push({ primitive: s.primitive, params });
          if (valid.length >= 5) break;
        }
        if (bad) { feedback = bad; log.warn('act', '规划失败：' + feedback); continue; }
        if (!valid.length) { feedback = 'steps 为空，请给出至少一步具体动作'; log.warn('act', feedback); continue; }
        return { ok: true, steps: valid, thought: obj.thought || valid[0].primitive, say };
      } catch (e) {
        feedback = '输出无法解析为 JSON：' + e.message;
        log.warn('act', '规划失败：' + feedback);
      }
    }
    return { ok: false, reason: feedback || '多次尝试仍无法把意图落地', rawDecision };
  }

  /**
   * L5 反思层。
   * 只吃「刚才做了什么 + 结果 + 当前目标」——完整观察对反思没有增量信息，
   * 传进来只会白烧几千 token。
   */
  async _reflect(primitive, params, result) {
    const usr = [
      `刚才的动作：${primitive}(${JSON.stringify(params)})`,
      `结果：${result.ok ? '成功' : '失败'} — ${result.detail}`,
      `当前目标：${this.goals.describe()}`, '',
      '请反思并输出 JSON：',
      '{',
      '  "assessment": "一句话评估这一步",',
      '  "episodic": "记入情景记忆的一句话（谁/何时/何地/做了什么/结果）",',
      '  "semantic": ["可选的规律，0~2 条：如果总结出了通用规律就写，否则空数组"],',
      '  "goalDecision": { "kind": "continue|progress|complete|abandon|new", "progress": "", "newGoal": { "text": "", "term": "短期|长期" }, "reason": "" }',
      '}'
    ].join('\n');

    const { obj } = await callJSON(
      this._sys('当前角色：反思层。评估刚才这一步，更新记忆与目标。没有目标或目标已不适用时，要主动提出新目标。'),
      usr, { temperature: 0.5, maxTokens: 600, label: 'L5反思' });

    if (obj.episodic) this.mem.addEpisodic(obj.episodic);
    if (Array.isArray(obj.semantic)) for (const s of obj.semantic) if (s) this.mem.addSemantic(s);
    const changed = this.goals.applyReflection(obj);
    if (changed) log.mem('目标变化：' + changed);
    if (obj.assessment) log.brain('L5 评估：' + trunc(obj.assessment, 160));
  }
}

module.exports = { Loop };
