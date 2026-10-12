'use strict';

/* ============================================================
 * lib/memory.js —— 三层记忆 + 持久化 + 语义检索。
 *
 * 三层：
 *   episodic 情景记忆：谁/何时/何地/做了什么/结果如何
 *   semantic 语义记忆：总结出的规律（"夜里会出现僵尸"）
 *   goals    目标记忆：self 定下的长期目标与进度
 *
 * 持久化为本地 JSON（默认 data/memory.json），重启不丢。
 * 检索用 LLM（不是关键词匹配）：把当前处境 + 记忆目录交给模型挑选相关条目。
 *
 * 两个安全/稳定性设计：
 *   · 落盘前脱敏（scrub）：记忆是「玩家聊天 + 模型输出」的混合体，
 *     其中可能夹带密钥/令牌/含用户名的路径；写盘前统一打码。
 *   · 写入节流：每轮闭环会调用多次 save()，节流后合并成一次落盘。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { callJSON } = require('./llm');
const log = require('./log');

const scrub = log.scrub;

/** 写盘节流窗口（毫秒）；设为 0 表示每次立即写盘 */
const SAVE_THROTTLE_MS = (() => {
  const v = parseInt(process.env.MEMORY_SAVE_THROTTLE_MS || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 2000;
})();

const EMPTY = () => ({
  episodic: [],   // {t, text}
  semantic: [],   // {t, text}
  goals: { current: null, history: [] }
});

/** 把对象里的字符串字段逐个脱敏（目标记忆用） */
function scrubObject(o) {
  if (!o || typeof o !== 'object') return o;
  const out = Array.isArray(o) ? [] : {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    out[k] = typeof v === 'string' ? scrub(v).slice(0, 500) : v;
  }
  return out;
}

class Memory {
  constructor(file) {
    this.file = file;
    this.data = this._load();
    this._dirty = false;
    this._timer = null;
  }

  _load() {
    const base = EMPTY();
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!d || typeof d !== 'object') return base;
      const goals = (d.goals && typeof d.goals === 'object') ? d.goals : {};
      return {
        episodic: Array.isArray(d.episodic) ? d.episodic : base.episodic,
        semantic: Array.isArray(d.semantic) ? d.semantic : base.semantic,
        goals: {
          current: goals.current || null,
          history: Array.isArray(goals.history) ? goals.history : []
        }
      };
    } catch (_) {
      return base;   // 文件不存在 / 损坏：从空记忆开始，不崩
    }
  }

  /**
   * 标记需要落盘（节流）。
   * 真正的写盘由 flush() 完成；进程退出前请显式调用 flush()。
   */
  save() {
    this._dirty = true;
    if (SAVE_THROTTLE_MS === 0) { this.flush(); return; }
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, SAVE_THROTTLE_MS);
  }

  /** 立即落盘（幂等；无改动则什么都不做） */
  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._dirty) return;
    this._dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      this._dirty = true;   // 写失败：保持脏标记
      log.warn('mem', '记忆写入失败：' + e.message);
      // 兜底重试：SAVE_THROTTLE_MS=0 时 save() 是直调 flush() 的，
      // 若不在这里重挂 timer，脏数据要等下一次 save() 才可能落盘（可能积压很久）。
      if (!this._timer) {
        this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 3000);
      }
    }
  }

  // ---------------- 写入 ----------------
  addEpisodic(text) {
    if (!text) return;
    this.data.episodic.push({ t: Date.now(), text: scrub(String(text)).slice(0, 300) });
    if (this.data.episodic.length > 300) this.data.episodic = this.data.episodic.slice(-300);
    this.save();
  }

  addSemantic(text) {
    if (!text) return;
    const t = scrub(String(text)).slice(0, 300);
    if (!this.data.semantic.some((s) => s.text === t)) {
      this.data.semantic.push({ t: Date.now(), text: t });
      if (this.data.semantic.length > 200) this.data.semantic = this.data.semantic.slice(-200);
      this.save();
    }
  }

  // ---------------- 目标记忆 ----------------
  get goal() { return this.data.goals.current; }

  setGoal(goal) {
    if (this.data.goals.current) {
      this.data.goals.history.push(Object.assign({ closedAt: Date.now() }, scrubObject(this.data.goals.current)));
      if (this.data.goals.history.length > 100) this.data.goals.history = this.data.goals.history.slice(-100);
    }
    this.data.goals.current = goal ? scrubObject(goal) : null;
    this.save();
  }

  updateGoal(patch) {
    if (!this.data.goals.current) return;
    Object.assign(this.data.goals.current, scrubObject(patch));
    this.save();
  }

  closeGoal(reason) {
    if (this.data.goals.current) {
      this.data.goals.history.push(Object.assign(
        { closedAt: Date.now(), reason: scrub(String(reason || '')).slice(0, 200) },
        scrubObject(this.data.goals.current)
      ));
      if (this.data.goals.history.length > 100) this.data.goals.history = this.data.goals.history.slice(-100);
    }
    this.data.goals.current = null;
    this.save();
  }

  // ---------------- 检索（LLM 语义挑选，非关键词） ----------------
  /** 生成带 id 的记忆目录 */
  catalog() {
    const items = [];
    let id = 0;
    for (const s of this.data.semantic) items.push({ id: 'S' + (id++), kind: '规律', text: s.text });
    for (const e of this.data.episodic.slice(-40)) items.push({ id: 'E' + (id++), kind: '往事', text: e.text });
    for (const g of this.data.goals.history.slice(-10)) items.push({ id: 'G' + (id++), kind: '旧目标', text: `${g.text}（${g.progress || ''}）` });
    return items;
  }

  /**
   * 用 LLM 从记忆目录里挑出「与当前处境相关」的条目。
   * @returns {Promise<string[]>} 相关记忆的文本
   */
  async retrieve(situation, observationText) {
    const items = this.catalog();
    if (!items.length) return [];
    const list = items.map((i) => `${i.id} [${i.kind}] ${i.text}`).join('\n');

    const sys = '你是一个记忆检索器。只做一件事：从记忆目录里挑出与当前处境真正相关的条目。';
    const usr = [
      '当前处境：' + situation,
      '',
      '最近的观察（供你判断处境）：',
      (observationText || '').slice(0, 1200),
      '',
      '记忆目录：',
      list,
      '',
      '请挑选真正有助于当前处境判断的条目（最多 8 条；宁缺毋滥）。',
      '只输出 JSON：{"relevant":["S0","E3"]}。若都不相关，输出 {"relevant":[]}。'
    ].join('\n');

    try {
      const { obj } = await callJSON(sys, usr, { temperature: 0.2, maxTokens: 800, label: 'L0记忆检索' });
      const ids = Array.isArray(obj.relevant) ? obj.relevant.map(String) : [];
      const picked = items.filter((i) => ids.includes(i.id)).map((i) => `[${i.kind}] ${i.text}`);
      return picked;
    } catch (e) {
      log.warn('mem', '记忆检索失败（本轮忽略长期记忆）：' + e.message);
      return [];
    }
  }

  /** 供观察层使用的统计信息 */
  stats() {
    return {
      episodic: this.data.episodic.length,
      semantic: this.data.semantic.length,
      goalHistory: this.data.goals.history.length
    };
  }
}

module.exports = { Memory };
