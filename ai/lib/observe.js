'use strict';

/* ============================================================
 * lib/observe.js —— 把客户端 mod 推来的 state 写成分层自然语言观察。
 *
 * 七层（同 mc-no-llm-bot 的设计）：
 *   ① 自身状态  ② 环境感知  ③ 短期记忆  ④ 长期相关记忆
 *   ⑤ 上一轮结果 ⑥ 时间与情境  ⑦ 当前目标
 *
 * 数据来源：ctx.bridge.getState()（见 forge-bot/PROTOCOL.md 的 state.data 字段）。
 * 本文件不含任何决策。
 * ============================================================ */

const d1 = (n) => Math.round(n * 10) / 10;
const fmtPos = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

/** yaw 单位容错：mod 若给度就用度，若给弧度（|yaw|≤2π）就用弧度 */
function yawRad(yaw) {
  if (yaw == null) return 0;
  return Math.abs(yaw) > 6.5 ? yaw * Math.PI / 180 : yaw;
}

function bearing(dx, dz) {
  const a = Math.atan2(dx, -dz); // -Z=北
  let idx = Math.round((a / (Math.PI / 2)) % 4);
  if (idx < 0) idx += 4;
  return ['北', '东', '南', '西'][idx];
}

function relDir(yr, dx, dz) {
  const fx = -Math.sin(yr), fz = -Math.cos(yr);
  const rx = Math.cos(yr), rz = -Math.sin(yr);
  const ang = Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz) * 180 / Math.PI;
  if (Math.abs(ang) <= 30) return '正前方';
  if (ang > 30 && ang <= 75) return '右前方';
  if (ang < -30 && ang >= -75) return '左前方';
  if (ang > 75 && ang <= 120) return '右侧';
  if (ang < -75 && ang >= -120) return '左侧';
  if (Math.abs(ang) > 150) return '正后方';
  return ang > 0 ? '右后方' : '左后方';
}

/** 「距离 + 世界方位 + 相对朝向」 */
function where(st, o) {
  if (!st || !st.pos || !o || o.x == null || o.y == null || o.z == null) return '位置未知';
  const self = st.pos;
  const yr = yawRad(st.yaw);
  const dx = o.x - self.x, dz = o.z - self.z;
  const dist = Math.sqrt(dx * dx + (o.y - self.y) * (o.y - self.y) + dz * dz);
  return `${d1(dist)}格外，世界方位${bearing(dx, dz)}，在你${relDir(yr, dx, dz)}`;
}

// ---------------- ① 自身状态 ----------------
function senseSelf(st) {
  const lines = [];
  lines.push(`位置 (${fmtPos(st.pos)})，朝向 yaw=${st.yaw != null ? Math.round(st.yaw) : '?'} pitch=${st.pitch != null ? Math.round(st.pitch) : '?'}。`);
  const s = [];
  if (st.health != null) s.push(`血量 ${Math.round(st.health)}/20`);
  if (st.food != null) s.push(`饥饿 ${Math.round(st.food)}/20`);
  if (st.oxygen != null && st.oxygen < 20) s.push(`氧气 ${st.oxygen}/20（在水下）`);
  if (st.xpLevel != null) s.push(`经验等级 ${st.xpLevel}`);
  if (st.onFire) s.push('你正在着火！');
  if (st.inWater) s.push('你正泡在水里');
  lines.push(s.join('，') + '。');

  const held = st.held ? `${st.held.name}×${st.held.count}` : '空手';
  lines.push(`手持：${held}。`);

  const inv = Array.isArray(st.inventory) ? st.inventory : [];
  lines.push('背包：' + (inv.length ? inv.map((i) => `${i.name}×${i.count}[槽${i.slot}]`).join('，') : '空') + '。');

  const la = st.lookingAt;
  if (la && la.type && la.type !== 'none' && la.name) {
    lines.push(`你正看向：${la.name}（${la.type === 'block' ? '方块' : '实体'}，坐标 ${la.x},${la.y},${la.z}）——对准它左键可挖/攻击、右键可使用/交互。`);
  } else {
    lines.push('你正看向：前方没有对准任何方块或实体（可以先 look_at 或转身）。');
  }
  lines.push(`脚下：${st.feet || '?'}${st.under ? '，再往下 ' + st.under : ''}；生物群系 ${st.biome || '?'}；光照 ${st.light != null ? st.light : '?'}。`);

  const armor = st.armor ? Object.entries(st.armor).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('，') : '';
  lines.push('装备：' + (armor || '无护甲') + (st.vehicle ? `；正在乘坐 ${st.vehicle}` : '') + (st.sneaking ? '；正在潜行' : '') + (st.sprinting ? '；正在疾跑' : '') + '。');
  if (Array.isArray(st.effects) && st.effects.length) {
    lines.push('状态效果：' + st.effects.map((e) => `${e.name}(等级${(e.amplifier || 0) + 1}, ${Math.round((e.duration || 0) / 20)}秒)`).join('，') + '。');
  }
  if (st.dead) lines.push('⚠ 你已经死亡，躺在地上——用 respawn 可以重生。');
  if (st.screen && st.screen !== 'null') lines.push(`当前打开的界面：${st.screen}。`);
  return lines.join('\n');
}

// ---------------- ② 环境感知 ----------------
function senseEnv(ctx, st) {
  const R = (ctx.config.loop.observeRadius) || 16;
  const players = (st.players || []).filter((p) => p.dist == null || p.dist <= R);
  const ents = (st.entities || []).filter((e) => e.dist == null || e.dist <= R);
  const blocks = (st.blocks || []).filter((b) => b.dist == null || b.dist <= R);
  const lines = [];
  lines.push(players.length ? '玩家：' + players.map((p) => `${p.name}（${where(st, p)}）`).join('；') : '附近没有其他玩家。');
  lines.push(ents.length ? '实体：' + ents.map((e) => `${e.name}（${e.type || '?'}，${where(st, e)}）`).join('；') : '附近没有实体。');
  if (blocks.length) lines.push('附近方块：' + blocks.map((b) => `${b.name}（${where(st, b)}）`).join('；'));
  return lines.join('\n');
}

// ---------------- ⑥ 时间与情境 ----------------
function senseTime(st) {
  const tod = st.timeOfDay != null ? st.timeOfDay : 0;
  const isDay = tod < 12000;
  const weather = st.thundering ? '雷雨' : (st.raining ? '下雨' : '晴');
  return `现在是 ${isDay ? '白天' : '夜晚'}（世界时 ${Math.floor(tod / 1000)} 时），天气${weather}，维度 ${st.dimension || '?'}。`;
}

function describeGoal(goal) {
  if (!goal) return '（无）';
  const prog = goal.progress ? `　进度：${goal.progress}` : '';
  return `目标：${goal.text}（${goal.term || '短期'}）${prog}`;
}

/**
 * 生成完整观察文本。
 * @param {object} ctx  { bridge, config, master }
 * @param {object} s    { shortTerm:[], longTerm:[], lastResult, goal, chat:[], events:[], failureHint }
 */
function buildObservation(ctx, s) {
  s = s || {};
  const st = ctx.bridge && ctx.bridge.getState();
  if (!st) return '【系统】还没有收到客户端 mod 的状态（桥可能未连接或客户端未运行）。请等待，或先确认 mod 已加载、桥已连通。';
  if (!st.pos) return '【系统】已收到客户端状态，但缺少位置信息（玩家可能还没进入世界）。请先进入世界，稍等片刻。';

  const parts = [];
  // 【一眼看清】开头高信息密度摘要（你 + 周围）
  try {
    const sc = st.scan || {};
    const bl = Array.isArray(sc.blocks) ? sc.blocks.slice(0, 6).map((b) => `${b.name}×${b.count}`).join('，') : '';
    const mb = (Array.isArray(sc.mobs) && sc.mobs.length)
      ? sc.mobs.slice(0, 6).map((m) => `${m.name}(${Math.round(m.dist)}格)`).join('，') : '没有';
    parts.push([
      '【一眼看清（你 + 周围）】',
      `你是 ${st.self || '未知账号'}；位置 (${fmtPos(st.pos)})；站在 ${st.feet || '?'} 上${st.onGround ? '' : '（悬空/下落中）'}；生命 ${Math.round(st.health)} 饥饿 ${Math.round(st.food)}；${(st.timeOfDay != null && st.timeOfDay < 12000) ? '白天' : '夜晚'}；手持 ${st.held ? st.held.name : '空手'}。`,
      `周围方块（≈48格）：${bl || '（暂未扫描到）'}`,
      `周围生物：${mb}`,
      (st.lookingAt && st.lookingAt.name) ? `你正看向：${st.lookingAt.name}` : '你正看向：前方没有瞄准任何东西',
      (() => { const t = []; if (sc.lava > 0) t.push('⚠附近有岩浆（危险）'); if (sc.water > 0) t.push('附近有水（下水小心）'); if (sc.containers > 0) t.push(`附近有 ${sc.containers} 个可交互方块（箱子/熔炉/工作台等）`); return t.length ? ('环境：' + t.join('；')) : '环境：暂无明显特征'; })()
    ].join('\n'));
  } catch (_) {}
  // 【实时状态·地面真值】——治「凭记忆以为自己卡住」：判断"现在是否卡住"一律以此为准
  const gt = [];
  gt.push('【⚠ 实时状态（来自客户端 mod 的实时数据，不是记忆；判断"你现在是否卡住/在哪"一律以此为准）】');
  gt.push(`位置 (${fmtPos(st.pos)})；onGround=${st.onGround === true ? 'true（脚踩在实体方块上）' : 'false（悬空或下落中）'}；脚下方块=${st.feet || '?'}；再往下=${st.under || '?'}。`);
  if (st.onGround === true && st.feet && st.feet !== 'air' && st.feet !== 'water' && st.feet !== 'lava') {
    gt.push(`客观事实：你现在**正站在 ${st.feet} 上**，并没有悬空，也不是卡在半空。不要把记忆里"我卡住了"当成现在的事实。`);
  } else if (st.onGround !== true) {
    gt.push('客观事实：你现在**脚下没有实地**（悬空/下落中）。想落地就用水平方向的 move_dir 走出边缘自然坠落，或在飞行/创造模式下用 move_dir down。');
  }
  if (st.sleeping) gt.push('你正在睡觉。');
  if (st.dead) gt.push('你已经死亡——用 respawn 重生。');
  if (s.moved) gt.push(s.moved);
  if (st.feet && (String(st.feet).includes('leaves') || String(st.feet).includes('_log') || String(st.feet).includes('wood'))) {
    gt.push(`你脚下是 ${st.feet}（这是实体方块，你站得稳、也能走）。如果视野被树叶挡住，直接 dig 挖穿面前的方块，或朝任意水平方向 move_dir 走 2~3 秒就能出去——你不会被困住，别只嘴上喊"卡住了"，要动手。`);
  }
  parts.push(gt.join('\n'));
  parts.push('【① 自身状态】\n' + senseSelf(st));
  parts.push('【② 环境感知】\n' + senseEnv(ctx, st));

  // ②b 大范围感知（mod 侧粗扫 ~48 格 ≈ 12 区块）
  if (st.scan) {
    const bl = (st.scan.blocks || []).map((b) => `${b.name}×${b.count}`).join('，');
    const mobs = st.scan.mobs || [];
    const mobText = mobs.length
      ? mobs.map((m) => `${m.name}(${m.type}，${m.dist}格)`).join('，')
      : '没有发现动物或怪物';
    parts.push('【②b 大范围感知（约 ' + (st.scan.radius || 48) + ' 格内，≈12 区块）】\n' +
      '方块分布：' + (bl || '（无）') + '\n' +
      '生物：' + mobText);
  }

  const chat = (s.chat && s.chat.length) ? s.chat : (st.chat || []).slice(-8).map((c) => `${c.user}：${c.msg}`);
  if (chat && chat.length) parts.push('【最近的聊天】\n' + chat.slice(-8).join('\n'));
  if (s.userTalk && s.userTalk.length) {
    parts.push('【📢 有人在对你说话（优先回应：先 look_at_entity 看向对方，再用 chat 口语回一句，然后继续做事）】\n' + s.userTalk.join('\n'));
  }

  parts.push('【⑥ 时间与情境】\n' + senseTime(st));

  if (s.events && s.events.length) {
    parts.push('【最近发生的事（短期记忆）】\n' + s.events.slice(-(ctx.config.loop.shortTermLen)).join('\n'));
  }
  parts.push('【③ 短期记忆（最近几轮）】\n' + ((s.shortTerm && s.shortTerm.length) ? s.shortTerm.join('\n') : '（还没有）'));

  if (Array.isArray(s.attempts) && s.attempts.length) {
    parts.push('【最近尝试记录（动作→结果，供你分析、避免重复无效做法）】\n' +
      s.attempts.map((a) => `第${a.r}轮 ${a.action} ${JSON.stringify(a.params)} → ${a.ok ? '成功' : '失败'}：${a.detail}`).join('\n'));
  }
  parts.push('【④ 与此刻相关的长期记忆】\n' + ((s.longTerm && s.longTerm.length) ? s.longTerm.join('\n') : '（没有检索到相关的历史）'));

  if (s.lastResult) {
    const r = s.lastResult;
    parts.push('【⑤ 上一轮结果】\n' + `你刚才尝试：${r.attempt || r.action}。结果：${r.ok ? '成功' : '失败'}——${r.detail}`);
  } else {
    parts.push('【⑤ 上一轮结果】\n（这是第一轮，还没有动作记录）');
  }

  if (s.failureHint) parts.push('【自我修正提示】\n' + s.failureHint);

  parts.push('【⑦ 当前目标】\n' + (s.goal ? describeGoal(s.goal) : '（你目前还没有明确目标——请自己决定接下来要做什么，可以给自己定一个目标）'));

  return parts.join('\n\n');
}

/** 给记忆检索用的一句处境摘要 */
function situationLine(ctx) {
  const st = ctx.bridge && ctx.bridge.getState();
  if (!st || !st.pos) return '（尚未收到客户端位置/状态）';
  const tod = st.timeOfDay != null ? st.timeOfDay : 0;
  const held = st.held ? st.held.name : '空手';
  return `位置(${fmtPos(st.pos)}) ${tod < 12000 ? '白天' : '夜晚'} 血${Math.round(st.health)} 饥${Math.round(st.food)} 手持${held}`;
}

module.exports = { buildObservation, situationLine, describeGoal, where, fmtPos };
