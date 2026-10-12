'use strict';

/* ============================================================
 * lib/primitives.js —— 原语层（Node 侧「手脚」的声明与执行）。
 *
 * 这里的每个原语都不直接操作游戏，而是把动作**发给客户端 mod**
 * （通过 ctx.bridge.act），由 mod 在主线程执行后返回结果。
 * 原语按 type 分组，供闭环 L3 机械筛选。
 *
 * 本文件不含决策：名字/参数与 forge-bot/PROTOCOL.md 的 v1 动作清单一一对应。
 * 若客户端 mod 未实现某个动作，它应返回 ok:false + 原因——本层如实回传。
 * ============================================================ */

const TYPE_GROUPS = {
  move: '位移：走到某点、靠近某物、朝某方向移动、跳跃、疾跑、潜行、停止',
  view: '视角：看向坐标/实体、转头',
  interact: '交互（鼠标左右键）：挖方块=左键、攻击=左键、放置方块=右键、使用/交互=右键、拾取、丢弃、装备、进食',
  inventory: '物品栏：切换选中槽位、交换槽位、读取背包',
  social: '社交：聊天、私聊、跟随、停止跟随',
  sense: '感知：扫描周围、找方块、找实体',
  world: '世界：睡觉、开门关门、按按钮、上/下坐骑',
  container: '容器：打开/关闭箱子、从箱子取出、放入箱子',
  craft: '合成：合成物品、熔炼物品',
  misc: '其他：等待、静止、重生'
};

// name: [type, params, desc]
const DEFS = {
  /* move */
  move_to:        ['move', { x: 'number', y: 'number', z: 'number' }, '走到指定坐标 (x,y,z)'],
  move_near:      ['move', { target: 'string', name: 'string?', distance: 'number?' }, '靠近目标：target ∈ block/entity/player，name 名称'],
  move_dir:       ['move', { direction: 'string', seconds: 'number?' }, '朝某方向移动一小段（forward/back/left/right/up/down）'],
  jump:           ['move', {}, '原地跳一下'],
  sprint:         ['move', { on: 'boolean?' }, '开启/关闭疾跑'],
  sneak:          ['move', { on: 'boolean?' }, '开启/关闭潜行（潜行可防坠落、悄悄移动）'],
  stop:           ['move', {}, '停止当前移动'],

  /* view */
  look_at:        ['view', { x: 'number', y: 'number', z: 'number' }, '看向坐标'],
  look_at_entity: ['view', { target: 'string' }, '看向某实体/玩家（名字；nearest 为最近）'],
  turn:           ['view', { yaw: 'number', pitch: 'number?' }, '把视角转到绝对角度 yaw/pitch（度）'],

  /* interact */
  dig:            ['interact', { x: 'number', y: 'number', z: 'number' }, '挖掉坐标处的方块'],
  place:          ['interact', { x: 'number', y: 'number', z: 'number', block: 'string?' }, '在坐标处放置方块'],
  use_item:       ['interact', {}, '使用当前手持物品'],
  use_on:         ['interact', { x: 'number', y: 'number', z: 'number' }, '对着坐标处的方块使用'],
  attack:         ['interact', { target: 'string', times: 'number?' }, '攻击某实体（名字；nearest；times 次数）'],
  pickup:         ['interact', {}, '走过去拾取附近掉落物'],
  drop:           ['interact', { item: 'string', count: 'number?' }, '丢弃背包物品'],
  equip:          ['interact', { item: 'string', destination: 'string?' }, '装备物品到 hand/head/torso/legs/feet/off-hand'],
  eat:            ['interact', {}, '进食：吃下当前手持的食物（也可用 use_item）'],
  drop_all:       ['interact', { item: 'string?' }, '丢弃物品：给 item 名则丢弃所有该物品，留空则尽量清空快捷栏'],

  /* inventory */
  swap_slots:     ['inventory', { a: 'number', b: 'number' }, '交换两个槽位'],
  get_inventory:  ['inventory', {}, '读取背包'],
  select_slot:    ['inventory', { slot: 'number' }, '切换手持槽位（0~8，对应快捷栏第 1~9 格）'],
  sort_inventory: ['inventory', {}, '按名称整理主背包（尽力而为）'],

  /* social */
  chat:           ['social', { message: 'string' }, '公屏说一句话'],
  whisper:        ['social', { player: 'string', message: 'string' }, '私聊某玩家'],
  follow:         ['social', { target: 'string', distance: 'number?' }, '持续跟随某实体/玩家'],
  stop_follow:    ['social', {}, '停止跟随'],

  /* sense */
  scan_area:      ['sense', { radius: 'number?' }, '扫描周围（返回方块/实体概览）'],
  find_block:     ['sense', { name: 'string', radius: 'number?' }, '找最近的某方块'],
  find_entity:    ['sense', { name: 'string?', radius: 'number?' }, '找最近的某实体'],
  get_health:     ['sense', {}, '读取当前生命/饥饿/氧气/经验等级'],

  /* world */
  sleep_in_bed:   ['world', {}, '找床睡觉'],
  open_door:      ['world', { x: 'number?', y: 'number?', z: 'number?' }, '开门'],
  close_door:     ['world', { x: 'number?', y: 'number?', z: 'number?' }, '关门'],
  press_button:   ['world', { x: 'number', y: 'number', z: 'number' }, '按按钮'],
  mount:          ['world', { target: 'string?' }, '骑上最近的坐骑/载具（船/矿车/马等）'],
  dismount:       ['world', {}, '从坐骑上下来'],

  /* container */
  open_container:      ['container', { x: 'number?', y: 'number?', z: 'number?', name: 'string?' }, '打开容器（给坐标，或方块名如 chest/crafting_table/furnace）'],
  close_container:     ['container', {}, '关闭当前打开的容器'],
  take_from_container: ['container', { item: 'string', count: 'number?' }, '从打开的容器里取出物品'],
  put_to_container:    ['container', { item: 'string', count: 'number?' }, '把背包里的物品放进打开的容器'],

  /* craft */
  craft:          ['craft', { item: 'string', count: 'number?' }, '合成物品（就地合成；3x3 配方需先用 open_container 打开 crafting_table）'],
  smelt:          ['craft', { item: 'string', count: 'number?' }, '在熔炉里熔炼物品（需先用 open_container 打开 furnace，并备好燃料）'],

  /* misc */
  wait:           ['misc', { seconds: 'number?' }, '等待若干秒'],
  idle:           ['misc', {}, '什么都不做（自己的选择）'],
  respawn:        ['misc', {}, '死亡后重生（回到出生点）']
};

const PRIMITIVES = {};
for (const name of Object.keys(DEFS)) {
  const [type, params, desc] = DEFS[name];
  PRIMITIVES[name] = {
    type, params, desc,
    async exec(ctx, args) {
      return ctx.bridge.act(name, args || {}, ctx.config.loop.actionTimeoutMs);
    }
  };
}

function allTypes() { return Object.keys(TYPE_GROUPS); }

/** 按类型机械筛选原语描述（纯过滤） */
function byTypes(types) {
  const set = new Set(types);
  return Object.keys(PRIMITIVES)
    .filter((n) => set.has(PRIMITIVES[n].type))
    .map((n) => ({ name: n, type: PRIMITIVES[n].type, params: PRIMITIVES[n].params, desc: PRIMITIVES[n].desc }));
}

/** 执行一个原语（发指令给 mod 并等回执） */
async function execute(name, args, ctx) {
  const def = PRIMITIVES[name];
  if (!def) return { ok: false, detail: `未知原语 ${name}` };
  return def.exec(ctx, args);
}

module.exports = { PRIMITIVES, TYPE_GROUPS, allTypes, byTypes, execute };
