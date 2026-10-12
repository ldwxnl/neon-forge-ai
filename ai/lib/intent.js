'use strict';

/* ============================================================
 * lib/intent.js —— 意图解析（语义落地）。
 *
 * 把决策层（L4）输出的自然语言，翻译成一个可执行的原语调用。
 *
 * 关键：这里**没有任何**「动词 → 函数」的硬编码映射，也不用正则去猜。
 * 落地完全交给 LLM：给它「可用原语子集 + 自然语言意图」，它来选择原语并填参数。
 * 落地失败时返回原因，由闭环把原因喂回模型重新决策（不 fallback 到硬编码动作）。
 *
 * 参数在落地之后还会过一道 **机械校验**：
 *   ① 必填（schema 里不带 ?）是否齐全；
 *   ② 类型是否符合 schema（number/string/boolean/array/object）；
 *   ③ 顺手做宽松强转（"10" → 10、"true" → true），因为模型常把数字写成字符串。
 * 校验只针对 schema 里声明过的键；未声明的键原样放行，交给 mod 端判定。
 * ============================================================ */

const { callJSON } = require('./llm');

/** 把参数 schema 渲染成 "x:number, y:number, block:string?" */
function paramsText(params) {
  if (!params || !Object.keys(params).length) return '';
  return Object.keys(params).map((k) => `${k}:${params[k]}`).join(', ');
}

/** 拆 "number?" → {type:'number', optional:true} */
function parseSpec(spec) {
  const raw = String(spec == null ? '' : spec).trim();
  const optional = raw.endsWith('?');
  const type = (optional ? raw.slice(0, -1) : raw).trim().toLowerCase();
  return { type, optional };
}

/** 宽松强转：只做「显然无损」的转换，失败就原样返回交给校验报错 */
function coerce(value, type) {
  if (type === 'number') {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return value;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    return value;
  }
  if (type === 'string') {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return value;
  }
  return value;
}

/** 类型判定；未知类型一律放行（不阻塞） */
function typeOk(value, type) {
  switch (type) {
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string' && value.trim() !== '';
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return !!value && typeof value === 'object' && !Array.isArray(value);
    default: return true;
  }
}

/**
 * 依据 schema 做机械校验（必填 + 类型），返回强转后的参数。
 * @returns {{ok:true, params:object} | {ok:false, reason:string}}
 */
function validate(params, schema) {
  const src = (params && typeof params === 'object' && !Array.isArray(params)) ? params : {};
  if (!schema) return { ok: true, params: Object.assign({}, src) };

  const out = Object.assign({}, src);
  for (const k of Object.keys(schema)) {
    const { type, optional } = parseSpec(schema[k]);
    let v = out[k];

    const missing = v === undefined || v === null || v === '';
    if (missing) {
      if (optional) { delete out[k]; continue; }
      return { ok: false, reason: `缺少必填参数 ${k}${type ? `（应为 ${type}）` : ''}` };
    }

    v = coerce(v, type);
    if (!typeOk(v, type)) {
      const actual = Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v);
      return { ok: false, reason: `参数 ${k} 类型不对：期望 ${type}，实际是 ${actual}` };
    }
    out[k] = v;
  }
  return { ok: true, params: out };
}

/**
 * 语义落地：自然语言决策 → { primitive, params }
 * @param {string} decision  L4 的自然语言决策
 * @param {Array}  subset    当前可用原语描述数组 [{name,type,params,desc}]
 * @returns {Promise<{ok:boolean, primitive?:string, params?:object, reason?:string}>}
 */
async function parse(decision, subset) {
  if (!subset || !subset.length) return { ok: false, reason: '当前没有任何可用原语' };

  const list = subset.map((p) => `- ${p.name}(${paramsText(p.params)})　${p.desc}`).join('\n');

  const sys = [
    '你是「意图落地器」。你的唯一职责：把一段自然语言意图，翻译成一个具体的原语调用。',
    '严禁发明列表之外的原语。严禁用同义词猜测别的工具名。'
  ].join('\n');

  const usr = [
    '当前可用的原语：',
    list,
    '',
    '需要落地的意图：',
    String(decision || '').slice(0, 800),
    '',
    '要求：',
    '1. 只能从上面列表里选**一个**原语名；',
    '2. 参数要尽量具体：坐标/名字/数量若是意图或常识能推出的就填上；',
    '3. 参数类型必须与括号里声明的一致（number 就给数字，不要写成 "10"）；',
    '4. 如果这个意图用给定原语无法落地（缺关键信息、或需要的能力不存在），',
    '   不要勉强，输出 unparsed 并说明原因（这句话会被喂回给决策者，让它换个方式）。',
    '',
    '只输出 JSON，二选一：',
    '{"primitive":"<原语名>","params":{...}}',
    '{"unparsed":true,"reason":"<为什么无法落地>"}'
  ].join('\n');

  let obj;
  try {
    ({ obj } = await callJSON(sys, usr, { temperature: 0.1, maxTokens: 400, label: '意图落地' }));
  } catch (e) {
    return { ok: false, reason: '落地器输出无法解析：' + e.message };
  }

  if (!obj || typeof obj !== 'object') return { ok: false, reason: '落地器返回的不是对象' };
  if (obj.unparsed) return { ok: false, reason: obj.reason || '无法理解该意图' };

  const name = obj.primitive;
  if (typeof name !== 'string' || !name.trim()) return { ok: false, reason: '落地器没有给出原语名' };

  const def = subset.find((p) => p.name === name);
  if (!def) return { ok: false, reason: `原语「${name}」不在当前可用列表里` };

  const check = validate(obj.params, def.params);
  if (!check.ok) return { ok: false, reason: check.reason };

  return { ok: true, primitive: name, params: check.params };
}

module.exports = { parse, paramsText, validate, parseSpec, coerce, typeOk };
