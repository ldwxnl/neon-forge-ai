'use strict';

/* ============================================================
 * lib/llm.js —— 与大模型通信的唯一入口。
 *
 * 提供：
 *   - callText(system, user, opts)  → 返回模型原始文本
 *   - callJSON(system, user, opts)  → 返回解析后的对象（模型被要求输出 JSON）
 *   - 多端点顺序 fallback + 单端点指数退避重试
 *
 * 本文件不包含任何「决策」：它只是把提示词送进模型、把文本取回来。
 * 兼容 OpenAI 风格 /chat/completions，也容错 Ollama 风格返回。
 * ============================================================ */

const axios = require('axios');
const cfg = require('../config');
const log = require('./log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 全局节流：串行化 + 最小调用间隔，避免触发 429 限流 ---- */
let _chain = Promise.resolve();
let _lastCallAt = 0;
function serialize(taskFn) {
  const run = _chain.then(taskFn, taskFn);
  _chain = run.catch(() => {});
  return run;
}
async function throttle() {
  const gap = Number(process.env.LLM_MIN_GAP_MS) || (cfg.llm && cfg.llm.minGapMs) || 1400;
  const wait = Math.max(0, _lastCallAt + gap - Date.now());
  if (wait > 0) await sleep(wait);
  _lastCallAt = Date.now();
}
function is429(err) { return !!(err && err.response && err.response.status === 429); }
function retryAfterMs(err) {
  const h = err && err.response && err.response.headers;
  const ra = h && (h['retry-after'] || h['Retry-After']);
  const sec = parseFloat(ra);
  return Number.isFinite(sec) ? sec * 1000 : 0;
}

/** 把 baseUrl 规范成 chat/completions 端点 */
function endpoint(baseUrl) {
  const b = String(baseUrl).replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  return b + '/chat/completions';
}

/** 可选：额外的请求体字段（按厂商要求禁用推理/思考，如 {"enable_thinking":false} 或 {"thinking":false} 或 {"reasoning_effort":"none"}） */
let _extraBody = null;
function extraBody() {
  if (_extraBody === null) {
    _extraBody = {};
    const raw = process.env.LLM_EXTRA_BODY;
    if (raw && raw.trim()) { try { _extraBody = JSON.parse(raw); } catch (_) { _extraBody = {}; } }
  }
  return _extraBody;
}

/** Ollama / 部分网关会把 content 写成数组：[{type:'text', text:'...'}] */
function normalizeContent(v) {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) {
    return v.map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p.text === 'string') return p.text;
      return '';
    }).join('').trim();
  }
  return '';
}

/**
 * 是否允许把 reasoning_content（模型的「思考过程」）当作正文兜底。
 * 默认关闭 —— 见 extractContent 的说明。
 */
const ALLOW_REASONING_FALLBACK =
  ['1', 'true', 'yes', 'on'].includes(String(process.env.LLM_REASONING_FALLBACK || '').trim().toLowerCase());

let _warnedReasoning = false;

/** 从各家返回结构里抽取文本 */
function extractContent(res) {
  const d = res && res.data;
  if (!d) return '';

  const choice = Array.isArray(d.choices) ? d.choices[0] : (d.choices ? d.choices[0] : null);
  if (choice) {
    const msg = (choice.message && typeof choice.message === 'object') ? choice.message : {};

    // ① 正常正文（含数组形态）
    const content = normalizeContent(msg.content);
    if (content) return content;

    // ② reasoning_content 是模型「先想一遍」的思考过程，**不是最终答案**。
    //    旧实现直接把它当正文返回，会让要求 JSON 的调用解析到思考里的花括号 → 产出垃圾决策。
    //    因此这里默认丢弃（上层会按「返回空内容」重试/换端点）；
    //    只有当网关确实把正文误塞进 reasoning_content 时，才用 LLM_REASONING_FALLBACK=true 显式开启。
    if (ALLOW_REASONING_FALLBACK) {
      const reasoning = normalizeContent(msg.reasoning_content);
      if (reasoning) return reasoning;
    } else if (normalizeContent(msg.reasoning_content) && !_warnedReasoning) {
      _warnedReasoning = true;
      log.warn('llm', '模型只回了 reasoning_content 而没有正文，已丢弃（避免把思考过程当答案）。'
        + '若你的网关把正文放在该字段，请设 LLM_REASONING_FALLBACK=true。');
    }

    // ③ 少数网关用 choice.text
    const legacy = normalizeContent(choice.text);
    if (legacy) return legacy;
  }

  // ④ 非标准返回结构（扁平字段）
  const flat = normalizeContent(d.content) || normalizeContent(d.response) || normalizeContent(d.output);
  return flat;
}

/** 调用单个端点（带指数退避重试） */
async function callOne(provider, system, user, retries, overrides) {
  const temperature = overrides.temperature != null ? overrides.temperature : provider.temperature;
  const maxTokens = overrides.maxTokens != null ? overrides.maxTokens : provider.maxTokens;
  const timeout = overrides.timeout != null ? overrides.timeout : provider.timeout;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle();
    try {
      const res = await axios.post(endpoint(provider.baseUrl), {
        model: provider.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature,
        max_tokens: maxTokens,
        stream: false,
        ...extraBody()
      }, {
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}
        ),
        timeout
      });
      const text = extractContent(res);
      if (!text) throw new Error('模型返回空内容');
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const backoff = is429(err)
          ? (retryAfterMs(err) || Math.min(60000, 5000 * Math.pow(2, attempt)))
          : 500 * Math.pow(2, attempt);
        log.warn('llm', `「${provider.model}」失败(${err.message})，${backoff}ms 后重试 ${attempt + 1}/${retries}`);
        await sleep(backoff);
      }
    }
  }
  throw lastErr || new Error('LLM 调用失败');
}

/**
 * 多端点 fallback 调用，返回原始文本。
 * @param {string} system  系统提示
 * @param {string} user    用户提示
 * @param {object} [opts]  { temperature, maxTokens, timeout, retries, label }
 */
async function callText(system, user, opts) {
  opts = opts || {};
  return serialize(() => _callTextInner(system, user, opts));
}

async function _callTextInner(system, user, opts) {
  const retries = opts.retries != null ? opts.retries : cfg.llm.retries;
  const providers = cfg.llm.providers;
  let lastErr;
  for (const p of providers) {
    try {
      const text = await callOne(p, system, user, retries, opts);
      if (opts.label) log.brain(`${opts.label} ← ${p.model}`);
      return { text, provider: p };
    } catch (err) {
      lastErr = err;
      log.warn('llm', `端点「${p.model}」不可用，尝试下一个`);
    }
  }
  throw lastErr || new Error('所有 LLM 端点均不可用');
}

/** 剥代码块、截取第一个 {...} 或 [...]、容错解析 JSON */
function extractJSON(raw) {
  if (!raw) return null;
  let text = String(raw).trim().replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const objS = text.indexOf('{');
  const objE = text.lastIndexOf('}');
  const arrS = text.indexOf('[');
  const arrE = text.lastIndexOf(']');
  let slice = null;
  if (objS !== -1 && objE > objS && (arrS === -1 || objS < arrS)) slice = text.slice(objS, objE + 1);
  else if (arrS !== -1 && arrE > arrS) slice = text.slice(arrS, arrE + 1);
  if (!slice) return null;
  try {
    return JSON.parse(slice);
  } catch (_) {
    try {
      const fixed = slice
        .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":') // 裸 key
        .replace(/,\s*([}\]])/g, '$1');                                 // 尾逗号
      return JSON.parse(fixed);
    } catch (_2) {
      return null;
    }
  }
}

/**
 * 要求模型输出 JSON，并把解析后的对象返回。
 * 解析失败会抛错（调用方可决定如何把「格式错误」反馈给模型）。
 */
async function callJSON(system, user, opts) {
  const { text } = await callText(system, user, opts);
  const obj = extractJSON(text);
  if (obj === null) {
    const err = new Error('模型未返回可解析的 JSON');
    err.raw = text;
    throw err;
  }
  return { obj, raw: text };
}

module.exports = { callText, callJSON, extractJSON, extractContent, sleep };
