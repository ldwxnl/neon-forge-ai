'use strict';

/* ============================================================
 * lib/log.js —— 统一彩色日志（带脱敏 + 级别过滤）。
 *
 * 它做三件事：
 *   1) 带时间戳 / 标签的彩色输出；
 *   2) scrub()：把密钥、令牌、邮箱、含用户名的绝对路径替换成 ***，
 *      避免「把日志贴到 issue / 截图求助」时泄漏敏感信息；
 *   3) LOG_LEVEL：error < warn < info < verbose < debug（默认 info）。
 *
 * 约定：所有输出都会先过 scrub()。需要原样输出请直接用 console.log。
 * ============================================================ */

const util = require('util');
const chalk = require('chalk');

/* ------------------------------------------------------------
 * 一、脱敏
 * 顺序敏感：先吃掉「带厂商前缀的长令牌」，再处理 key=value 形式。
 * ---------------------------------------------------------- */
const RULES = [
  // sk-xxx / rc-xxx / ghp_xxx / hf_xxx / glpat-xxx 等常见密钥前缀
  [/\b(sk|rk|pk|rc|ak|gh[pousr]|hf|glpat)[-_][A-Za-z0-9_\-]{12,}/g, '$1-***'],
  // Authorization: Bearer xxx
  [/\bBearer\s+[A-Za-z0-9._\-]{8,}/gi, 'Bearer ***'],
  // apiKey / token / secret / password 等「键: 值」形态
  [/((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|pwd|token)\s*["']?\s*[:=]\s*["']?)([^\s"',;}\]]{6,})/gi, '$1***'],
  // 邮箱
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '***@***'],
  // Windows 绝对路径里的用户名：C:\Users\xxx\... / D:\xxx\...
  [/\b([A-Za-z]):\\Users\\[^\\\s"']+/g, '$1:\\Users\\***'],
  // Unix 家目录：/home/xxx/... | /Users/xxx/...
  [/(\/(?:home|Users)\/)[^/\s"']+/g, '$1***']
];

/**
 * 把任意值转成「可安全写进日志」的字符串。
 * 字符串原样处理；Error 取 stack；对象用 util.inspect。
 * @param {*} input
 * @returns {*}
 */
function scrub(input) {
  if (input === null || input === undefined) return input;
  let s;
  if (typeof input === 'string') {
    s = input;
  } else if (input instanceof Error) {
    s = input.stack || input.message || String(input);
  } else if (typeof input === 'object') {
    try { s = util.inspect(input, { depth: 3, breakLength: 120 }); }
    catch (_) { s = String(input); }
  } else {
    s = String(input);
  }
  for (let i = 0; i < RULES.length; i++) s = s.replace(RULES[i][0], RULES[i][1]);
  return s;
}

/* ------------------------------------------------------------
 * 二、级别过滤
 * ---------------------------------------------------------- */
const NAMES = ['error', 'warn', 'info', 'verbose', 'debug'];

/** 每个输出通道属于哪一级 */
const BY_LABEL = {
  error: 'error',
  warn: 'warn',
  info: 'info', ok: 'info', plain: 'info',
  brain: 'verbose', act: 'verbose', mem: 'verbose', net: 'verbose', llm: 'verbose',
  debug: 'debug'
};

function resolveLevel(v) {
  if (v === undefined || v === null || String(v).trim() === '') return 2; // 默认 info
  const s = String(v).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Math.max(0, Math.min(NAMES.length - 1, parseInt(s, 10)));
  const i = NAMES.indexOf(s);
  return i >= 0 ? i : 2;
}

let LEVEL = resolveLevel(process.env.LOG_LEVEL);
const enabled = (label) => NAMES.indexOf(BY_LABEL[label] || 'info') <= LEVEL;

/* ------------------------------------------------------------
 * 三、输出
 * ---------------------------------------------------------- */
const stamp = () => new Date().toTimeString().slice(0, 8);
const tag = (label, color) => chalk[color](`[${label}]`);

function emit(label, color, levelLabel, args) {
  if (!enabled(levelLabel)) return;
  console.log(chalk.gray(stamp()), tag(label, color), ...args.map(scrub));
}

module.exports = {
  scrub,

  /** 运行时调整级别（'error'|'warn'|'info'|'verbose'|'debug' 或 0-4） */
  setLevel: (v) => { LEVEL = resolveLevel(v); },
  /** 当前级别名 */
  getLevel: () => NAMES[LEVEL],

  info:  (...a) => emit('info ', 'cyan',       'info',  a),
  ok:    (...a) => emit(' ok  ', 'green',      'ok',    a),
  warn:  (...a) => emit('warn ', 'yellow',     'warn',  a),
  error: (...a) => emit('err  ', 'red',        'error', a),
  brain: (...a) => emit('brain', 'magenta',    'brain', a),
  act:   (...a) => emit('act  ', 'blue',       'act',   a),
  mem:   (...a) => emit('mem  ', 'cyanBright', 'mem',   a),
  net:   (...a) => emit('net  ', 'gray',       'net',   a),
  debug: (...a) => emit('debug', 'gray',       'debug', a),

  /** 无前缀输出（仍然脱敏，级别按 info） */
  plain: (...a) => { if (enabled('plain')) console.log(...a.map(scrub)); }
};
