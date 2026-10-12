'use strict';

/* ============================================================
 * lib/bridge.js —— 与 Forge 客户端 mod 的 TCP 桥（Node 侧客户端）。
 *
 * 协议（见 PROTOCOL.md）：
 *   TCP 127.0.0.1:8765，UTF-8，换行分隔 JSON。
 *   Node → mod : {"t":"action","id":N,"name":"...","args":{...}}
 *   mod → Node : {"t":"result","id":N,"ok":true,"detail":"..."}
 *   mod → Node : {"t":"state","data":{...}}   (~5Hz)
 *   Node → mod : {"t":"ping"}    mod → Node : {"t":"pong"}
 *
 * 本文件只做「通信」：连接、收发、请求-回执配对、缓存最新状态、心跳探活。
 * 不做任何决策。
 * ============================================================ */

const net = require('net');
const { EventEmitter } = require('events');
const log = require('./log');

const envInt = (name, def) => {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

class Bridge extends EventEmitter {
  constructor(host, port) {
    super();
    this.host = host;
    this.port = port;
    this.sock = null;
    this._buf = '';
    this._nextId = 1;
    this._pending = new Map();   // id -> { resolve, timer }
    this.state = null;           // 最新一帧 state.data
    this.stateAt = 0;
    this.connected = false;
    this._stopped = false;
    this._backoff = 1000;
    this._reconnectTimer = null;

    // 心跳：主动 ping + 空闲超时判定（用来发现「半开连接」）
    this._pingMs = envInt('BRIDGE_PING_INTERVAL_MS', 10000);
    this._idleTimeoutMs = envInt('BRIDGE_IDLE_TIMEOUT_MS', 25000);
    this._hbTimer = null;
    this._lastAliveAt = 0;
  }

  start() {
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._stopHeartbeat();
    this._failAll('桥已停止');
    if (this.sock) { try { this.sock.destroy(); } catch (_) {} }
    this.sock = null;
    this.connected = false;
  }

  _connect() {
    const s = net.connect({ host: this.host, port: this.port });
    this.sock = s;
    s.setEncoding('utf8');

    s.on('connect', () => {
      this.connected = true;
      this._backoff = 1000;
      this._lastAliveAt = Date.now();
      log.ok('bridge', `已连接客户端 mod @ ${this.host}:${this.port}`);
      this._startHeartbeat();
      this.emit('connected');
    });

    // 任何来包（state/result/pong/垃圾数据）都算「对面还活着」
    s.on('data', (d) => { this._lastAliveAt = Date.now(); this._onData(d); });

    s.on('error', (e) => log.warn('bridge', 'socket 错误：' + e.message));

    s.on('close', () => {
      this.connected = false;
      this._stopHeartbeat();
      this._failAll('与 mod 的连接已断开');
      if (this.sock === s) this.sock = null;
      this.emit('disconnected');
      if (!this._stopped) this._scheduleReconnect();
    });
  }

  /* ---------------- 心跳 ---------------- */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._hbTimer = setInterval(() => {
      if (!this.connected) return;
      // 半开连接：对面进程已经死了，但本机没收到 FIN，socket 不会触发 close，
      // 请求会一直挂到超时才失败。只能靠「一段时间完全没有任何来包」判定，
      // 然后主动 destroy 掉，让 close 分支去走重连。
      if (this._lastAliveAt && (Date.now() - this._lastAliveAt) > this._idleTimeoutMs) {
        log.warn('bridge', `心跳超时（${Math.round(this._idleTimeoutMs / 1000)}s 无任何来包），判定连接已死，主动断开重连`);
        try { this.sock.destroy(); } catch (_) {}
        return;
      }
      this._send({ t: 'ping' });
    }, this._pingMs);
    if (this._hbTimer.unref) this._hbTimer.unref();
  }

  _stopHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    const t = this._backoff;
    this._backoff = Math.min(Math.round(this._backoff * 1.5), 15000);
    log.warn('bridge', `${Math.round(t / 1000)}s 后重连 mod…`);
    this._reconnectTimer = setTimeout(() => { if (!this._stopped) this._connect(); }, t);
  }

  _onData(d) {
    this._buf += d;
    let i;
    while ((i = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, i).trim();
      this._buf = this._buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch (_) { continue; }
      this._onMsg(m);
    }
    // 防御：对面要是一直不发换行，缓冲区会无限增长
    if (this._buf.length > 4 * 1024 * 1024) this._buf = this._buf.slice(-1024 * 1024);
  }

  _onMsg(m) {
    this._lastAliveAt = Date.now();
    if (m.t === 'state') {
      this.state = m.data || {};
      this.stateAt = Date.now();
      this.emit('state', this.state);
    } else if (m.t === 'result') {
      const p = this._pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        this._pending.delete(m.id);
        p.resolve({ ok: !!m.ok, detail: m.detail != null ? String(m.detail) : '' });
      }
    } else if (m.t === 'ping') {
      this._send({ t: 'pong' });
    } else if (m.t === 'pong') {
      // 收到即算存活，_lastAliveAt 已在函数开头更新
    }
  }

  _send(obj) {
    if (this.sock && this.connected) {
      try { this.sock.write(JSON.stringify(obj) + '\n'); } catch (_) {}
    }
  }

  /** 最新状态（可能为 null） */
  getState() { return this.state; }

  /** 状态是否新鲜 */
  isFresh(maxAgeMs) {
    return this.state != null && (Date.now() - this.stateAt) <= (maxAgeMs || 6000);
  }

  /**
   * 发一个动作给 mod，等待 result。
   * @returns {Promise<{ok:boolean, detail:string}>}
   */
  act(name, args, timeoutMs) {
    return new Promise((resolve) => {
      if (!this.connected) { resolve({ ok: false, detail: '尚未连接客户端 mod（桥未就绪）' }); return; }
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve({ ok: false, detail: '动作超时（mod 未在时限内回执）' });
      }, timeoutMs || 30000);
      this._pending.set(id, { resolve, timer });
      this._send({ t: 'action', id, name, args: args || {} });
    });
  }

  _failAll(reason) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, detail: reason });
    }
    this._pending.clear();
  }
}

module.exports = { Bridge };
