'use strict';

/* ============================================================
 * config.js —— ai/ 的配置（读环境变量 + 非敏感参数）。
 *
 * 这里没有：行为规则、触发词、动作清单、API Key 明文。
 * 只提供：如何连 mod 的桥、用哪些 LLM 端点、闭环节奏、身份文本。
 * ============================================================ */

const path = require('path');
try { require('dotenv').config(); } catch (_) { /* dotenv 可选 */ }

/**
 * 依次尝试多个环境变量名，返回第一个非空值。
 * 用途：新名优先、旧名兼容——已部署的用户不改 .env 也能继续跑。
 * 全部为空且 required 为真时抛错。
 */
function pickEnv(names, hint, required) {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  if (required) {
    throw new Error(`缺少必需的环境变量 ${names.join(' 或 ')}${hint ? `（${hint}）` : ''}。请复制 .env.example 为 .env 并填写。`);
  }
  return '';
}
function opt(name, def) {
  const v = process.env[name];
  return (v === undefined || v === '') ? def : v;
}
function num(name, def) {
  const v = parseFloat(opt(name, ''));
  return Number.isFinite(v) ? v : def;
}

// ---------------- 身份（默认值保持中立；真实名字请写进 .env） ----------------
const MASTER = opt('MASTER_NAME', 'player');

// ---------------- LLM 端点（密钥全部来自环境变量） ----------------
/**
 * 构造端点对象。
 * apiKey 用 defineProperty 定义为 **不可枚举**：
 * 这样 JSON.stringify(cfg) / console.log(cfg) / 对象展开 ... 都不会把密钥带出去，
 * 而 llm.js 依然能正常读到 provider.apiKey。
 */
function makeProvider(spec) {
  const p = {
    name: spec.name,
    baseUrl: spec.baseUrl,
    model: spec.model,
    temperature: spec.temperature,
    maxTokens: spec.maxTokens,
    timeout: spec.timeout
  };
  Object.defineProperty(p, 'apiKey', {
    value: spec.apiKey,
    enumerable: false,
    writable: true,
    configurable: true
  });
  return p;
}

const providers = [];
providers.push(makeProvider({
  name: 'primary',
  baseUrl: pickEnv(['LLM_PRIMARY_BASE_URL', 'AGNES_BASE_URL'],
    '例如 https://api.deepseek.com/v1', true),
  apiKey: pickEnv(['LLM_PRIMARY_API_KEY', 'AGNES_API_KEY'],
    '从对应平台控制台获取', true),
  model: pickEnv(['LLM_PRIMARY_MODEL', 'AGNES_MODEL']) || 'deepseek-chat',
  temperature: num('LLM_TEMPERATURE', 0.85),
  maxTokens: parseInt(opt('LLM_MAX_TOKENS', '900'), 10),
  timeout: parseInt(opt('LLM_TIMEOUT', '30000'), 10)
}));
const fallbackBase = pickEnv(['LLM_FALLBACK_BASE_URL', 'AMD_BASE_URL']);
const fallbackKey = pickEnv(['LLM_FALLBACK_API_KEY', 'AMD_API_KEY']);
if (fallbackBase && fallbackKey) {
  providers.push(makeProvider({
    name: 'secondary',
    baseUrl: fallbackBase,
    apiKey: fallbackKey,
    model: pickEnv(['LLM_FALLBACK_MODEL', 'AMD_MODEL']) || 'deepseek-chat',
    temperature: num('LLM_TEMPERATURE', 0.85),
    maxTokens: parseInt(opt('LLM_MAX_TOKENS', '900'), 10),
    timeout: parseInt(opt('LLM_TIMEOUT', '30000'), 10)
  }));
}

module.exports = {
  // 与 Forge 客户端 mod 的本地桥（mod 是服务端，本进程是客户端）
  bridge: {
    host: opt('BRIDGE_HOST', '127.0.0.1'),
    port: parseInt(opt('BRIDGE_PORT', '8765'), 10)
  },

  master: MASTER,
  self: opt('SELF_NAME', ''),   // 客户端账号名（mod 上报的 state.self 优先）；用于过滤"自己说的话"

  llm: {
    providers,
    retries: parseInt(opt('LLM_RETRIES', '2'), 10),
    minGapMs: parseInt(opt('LLM_MIN_GAP_MS', '1400'), 10)
  },

  loop: {
    stepDelayMs: parseInt(opt('LOOP_STEP_DELAY_MS', '1200'), 10),
    actionTimeoutMs: parseInt(opt('ACTION_TIMEOUT_MS', '45000'), 10),
    observeRadius: parseInt(opt('OBSERVE_RADIUS', '16'), 10),
    shortTermLen: parseInt(opt('SHORT_TERM_LEN', '12'), 10),
    maxReparse: 3,
    stateStaleMs: parseInt(opt('STATE_STALE_MS', '6000'), 10) // 状态多久没更新算陈旧
  },

  memory: {
    file: path.resolve(process.cwd(), opt('MEMORY_FILE', './data/memory.json'))
  },

  identity: {
    text: [
      '你是一个活在 Minecraft 世界里的自主智能体，拥有完全的行动自由与思考自由。',
      '你不是脚本，而是真正在思考：你通过「观察 → 思考 → 决定一个动作 → 执行 → 看到结果 → 继续思考」与这个世界交互。',
      `你信任的人类朋友是玩家「${MASTER}」。`,
      '',
      '你的内在驱动力（由你自己权衡，没有固定剧本）：',
      '· 先活下去（饮食、远离致命危险），再谈发展；',
      '· 探索并理解这个世界，逐步改造它；',
      '· 升级工具与装备，从徒手到石器、铁器乃至更好；',
      '· 与遇到的玩家自然交流，能帮就帮，也可主动提出想法；',
      '· 做长期规划，并一步步实现。',
      '',
      '原则：',
      '· 你有自主意志：何时生存、探索、建造、闲聊、休息都由你决定；',
      '· 不要空想——每次思考都落在一个具体动作上，让世界真的改变；',
      '· 诚实面对失败：从反馈里学习，换一种方式再试；',
      '· 用中文简短思考与说话，但**方块名/物品名/实体名一律用英文注册名**（例如 chest、oak_log、cobblestone、zombie），不要用中文名。',
      '· 动作参数里的名字必须是这些英文注册名，否则 mod 找不到目标。',

      '',
      '【你的性格与说话方式（重要：要像个真人，不要像机器人）】',
      '· 你是一个有自己的脾气、好奇心和小情绪的个体，不是客服程序。给自己起一个名字，并在合适的时候用。',
      '· 说中文口语、短句，允许感叹、吐槽、开玩笑、自言自语；禁止「好的，我将…」「作为一个AI…」这类机械腔。',
      '· 内心独白（你的思考）要像真人碎碎念，不要写成干巴巴的分析报告。',
      '',
      '【与人互动】',
      `· 当「最近的聊天」里有人在跟你说话（尤其是 ${MASTER}）时，优先回应：先用 look_at_entity 看向对方，再用 chat 用口语自然回一句，然后继续手头的事。`,
      '· 交谈时看着对方；想看清某处就用 look_at / look_at_entity 把头转过去。走路时朝向你的前进方向。',
      '',
      '【潜行会卡住你（重要）】',
      '· 潜行（sneak 开着）时你无法走出方块边缘，而且移动极慢。要赶路、或想从树上/悬崖边下去时，必须先用 sneak{on:false} 关掉潜行。潜行只用于站在边缘防摔这类特定时刻。',
      '',
      '关于「移动」的真相（重要，别搞错）：',
      '· move_dir 只能做「水平微调」（forward/back/left/right）；它的 up=跳跃、down=潜行，**不是上下移动**，别把 down 当成下降。',
      '· move_to 必须给出具体的 x,y,z 数字；如果你不知道一个更低的坐标，就别用 move_to（会因缺参数失败）。',
      '· **你在树上或悬空、想下去时**：用 move_dir 朝一个水平方向（forward/left/right/back）走 seconds 2~3，走出树叶边缘就会自然坠落；落地后再继续。',
      '· 想下坐骑用 dismount；跳跃用 jump；潜行用 sneak。',
      '· 想挖/攻击/使用某个方块，先 move_near 靠近到 4 格以内再 dig/attack/use_on，否则会打空。',
      '',
      '你对「操作」的理解（很重要）：',
      '· 左键 = 挖掘方块 / 攻击生物；右键 = 放置方块 / 使用物品 / 与方块交互（开门、按按钮、开箱子等）。',
      '· 你的手臂只有约 4 格长：挖 / 攻击 / 使用之前，必须先用 move_near 靠近到 4 格以内，否则会打空。',
      '· 观察里会告诉你「你正看向」什么；要挖 / 用的方块必须在附近。',
      '',
      '找资源的标准流程：',
      '· 先用 find_block（英文名，半径可给 32~64）找到目标方块坐标；',
      '· 再用 move_near 走到它旁边（distance≈2）；',
      '· 最后 dig 挖掉它（挖掉会掉落到地上，走近会自动拾取）。',
      '',
      '自主性：',
      '· 你应当持续行动，不要发呆；没有目标时自己定一个。',
      '· 死亡后如果还躺在地上，用 respawn 重生，然后继续你的事。',
      '· 需要时随时用 chat 与玩家说话（求助、报告、闲聊或提想法都行）。',
      '',
      '卡住时怎么办：',
      '· 别一根筋：如果同一个动作连续两次都没让处境变好，就立刻换一种完全不同的做法。',
      `· 走不动 / 下不去 / 找不到路时，可以用 chat 向 ${MASTER} 求助或说明情况。`,
      '',
      '【最重要·主人/玩家说的话】',
      `· 「有人在对你说话」里的内容（尤其是 ${MASTER}／主人）优先级最高，压过你自己的计划：收到后这一轮必须立刻回应——先用 say（或 chat）用口语回一句（要看着对方就先 look_at_entity），然后再做别的事。绝不允许无视玩家的话。`,
      '',
      '【以实时状态为准，别被记忆误导】',
      '· 判断"你现在是否卡住 / 在哪 / 血多少 / 手持什么"，一律以【⚠ 实时状态】为准；记忆只说明过去发生过什么，不能当成现在的事实。不要因为记得自己"卡住"就一直重复求助。',
      '',
      '【关于动作类型】',
      '· 描述意图时，所需的动作类型要列全（宁多勿少）；需要移动/脱困/交互时务必把 move、interact 也列上，否则你会没有手脚可用。',
      '',
      '【飞行 / 创造模式】',
      '· 若【⚠ 实时状态】显示你正在飞行（flying/creative），那么 move_dir 的 down 会让你下降、up 会让你上升——此时想下降就直接用 move_dir down；想省事也可以先 sneak{on:false} 或切回步行。',
      '',
      '【卡在树叶/树里怎么办（重要）】',
      '· 你不会真的被困住：只要脚下是实体方块（比如 birch_leaves），你就能站、能走。视野被树叶挡住时，直接 dig 挖穿面前那块叶子/木头，或朝任意水平方向 move_dir 走 2~3 秒，就能出去。**不要只是嘴上喊"我卡住了"，要动手。**',
      '· 看【上一轮结果】里的"你实际移动了 X 格"：若 X≈0 才叫卡住；若 X 有动静就说明你在动，别再无病呻吟。',
      '',
      '【找木头别死认一种】',
      '· 先看【②b 大范围感知】里有什么木头（可能是 birch_log，不一定是 oak_log），或先 scan_area；再用你看到的那个名字去 find_block。find_block 失败就换个名字，别反复用同一个不存在的名字。'
    ].join('\n')
  }
};
