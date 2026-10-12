'use strict';
/* 冒烟测试：起一个「假 mod」TCP 服务器（8765）+ 启动 Node AI，验证整条闭环。 */
const net = require('net');

const state = {
  ready: true,
  pos: { x: 10, y: 64, z: 10 }, yaw: 0, pitch: 0,
  health: 20, food: 20, oxygen: 20, xpLevel: 0,
  onGround: true, inWater: false, onFire: false,
  dimension: 'minecraft:overworld', timeOfDay: 6000,
  raining: false, thundering: false,
  held: null, inventory: [],
  players: [], entities: [],
  blocks: [{ name: 'oak_log', x: 12, y: 64, z: 10, dist: 2 }],
  chat: []
};

const srv = net.createServer((sock) => {
  console.log('[mock] client connected');
  const push = () => { try { sock.write(JSON.stringify({ t: 'state', data: state }) + '\n'); } catch (_) {} };
  const iv = setInterval(push, 400); push();
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.t === 'ping') { try { sock.write(JSON.stringify({ t: 'pong' }) + '\n'); } catch (_) {} }
      else if (m.t === 'action') {
        console.log('[mock] ACTION', m.id, m.name, JSON.stringify(m.args));
        try { sock.write(JSON.stringify({ t: 'result', id: m.id, ok: true, detail: 'mock 已执行 ' + m.name }) + '\n'); } catch (_) {}
      }
    }
  });
  sock.on('close', () => { clearInterval(iv); console.log('[mock] client closed'); });
});
srv.listen(8765, '127.0.0.1', () => console.log('[mock] listening 127.0.0.1:8765'));

setTimeout(() => {
  console.log('--- smoke end ---');
  try {
    // 优雅退出：停循环、停桥、冲刷记忆（bot.js 已把它们挂到 global 上）
    if (global.__loop) global.__loop.stop();
    if (global.__bridge) global.__bridge.stop();
    if (global.__memory) global.__memory.flush();
  } catch (_) {}
  setTimeout(() => process.exit(0), 300);
}, 90000);
require('../bot.js');
