'use strict';

/* ============================================================
 * ai/bot.js —— Node AI 端入口（含终端对话）。
 *
 * 它不直接连 Minecraft：通过 TCP 连接「真实 Forge 客户端里的 neonbridge mod」，
 * mod 负责所有游戏操作（手脚），Node 负责每轮真实调用 LLM 思考（大脑）。
 *
 * 运行：node bot.js   （需 .env，见 .env.example）
 * 终端：直接打字 = 以「master」的身份对 AI 说话；MC 里的聊天会回显到终端。
 * ============================================================ */

const readline = require('readline');
const cfg = require('./config');
const log = require('./lib/log');
const { Bridge } = require('./lib/bridge');
const { Memory } = require('./lib/memory');
const { Goals } = require('./lib/goals');
const { Loop } = require('./lib/loop');

// log.error 内部会走 log.scrub()，所以堆栈里的密钥/路径同样会被打码，
// 这里保留 stack 只是为了排查时能看到调用链。
process.on('unhandledRejection', (r) => {
  const detail = (r && r.stack) ? r.stack : (r && r.message ? r.message : String(r));
  log.error('proc', '未处理的 Promise 拒绝：' + detail);
});
process.on('uncaughtException', (e) => {
  const detail = (e && e.stack) ? e.stack : (e && e.message ? e.message : String(e));
  log.error('proc', '未捕获异常：' + detail);
});

const bridge = new Bridge(cfg.bridge.host, cfg.bridge.port);
const memory = new Memory(cfg.memory.file);
const goals = new Goals(memory);

const ctx = { bridge, config: cfg, master: cfg.master };
const loop = new Loop(ctx, memory, goals);

// 挂到 global，供冒烟脚本（examples/smoke.js）结束时优雅收尾：停循环、停桥、冲刷记忆。
// 仅测试便利性，不影响生产逻辑。
global.__loop = loop;
global.__bridge = bridge;
global.__memory = memory;

log.info('ai', `连接客户端 mod ${cfg.bridge.host}:${cfg.bridge.port}`);
bridge.start();
bridge.on('connected', () => log.ok('ai', '已连上客户端 mod，开始自主思考闭环。'));
bridge.on('disconnected', () => log.warn('ai', '与客户端 mod 断开，等待重连…'));

loop.start();

/* ============================================================
 *  终端对话
 *  - 你（master）在终端打字 → 注入为「你在对 AI 说话」
 *  - MC 聊天（含玩家发言）会回显到终端，顺便验证 mod 是否真的收到了聊天
 * ============================================================ */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function safePrompt() { try { rl.prompt(); } catch (_) {} }

rl.on('line', (line) => {
  const text = (line || '').trim();
  if (text) {
    console.log('\x1b[32m[你对 AI 说]\x1b[0m ' + text);
    try {
      if (typeof loop.injectUserMsg === 'function') loop.injectUserMsg(text, cfg.master);
      else log.warn('cli', 'loop.injectUserMsg 不存在，无法注入');
    } catch (e) {
      log.warn('cli', '注入消息失败：' + e.message);
    }
  }
  safePrompt();
});

// MC 聊天回显到终端
let _lastChatSig = '';
setInterval(() => {
  let st = null;
  try { st = bridge.getState && bridge.getState(); } catch (_) {}
  if (!st || !Array.isArray(st.chat) || !st.chat.length) return;
  const lines = st.chat.slice(-6)
    .map((c) => `${c.user ? c.user + ': ' : ''}${c.msg || ''}`.trim())
    .filter(Boolean);
  const sig = lines.join('\n');
  if (sig === _lastChatSig) return;
  _lastChatSig = sig;
  for (const l of lines.slice(-3)) console.log('\x1b[36m[聊天]\x1b[0m ' + l);
  safePrompt();
}, 700);

console.log('\n──────────────────────────────────────────────');
console.log(' 终端对话已开启：直接输入文字 = 以「' + cfg.master + '」的身份对 AI 说话');
console.log(' MC 里的聊天会回显到本终端（[聊天] 前缀）');
console.log('──────────────────────────────────────────────\n');
setTimeout(safePrompt, 400);

process.on('SIGINT', () => {
  log.warn('proc', '收到 SIGINT，正在退出…');
  try { rl.close(); } catch (_) {}
  loop.stop();
  bridge.stop();
  // 记忆是节流落盘的：退出前必须显式冲刷，否则最后几轮记忆会丢
  try { memory.flush(); } catch (_) {}
  setTimeout(() => process.exit(0), 200);
});
