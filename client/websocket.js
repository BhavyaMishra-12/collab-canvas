'use strict';
/**
 * websocket.js
 * ------------
 * Thin wrapper around the browser's native WebSocket that:
 *   - parses/serializes JSON messages
 *   - exposes a tiny pub/sub API (`.on(type, handler)`) keyed off `msg.type`
 *   - automatically reconnects with exponential backoff on drop
 *   - tracks round-trip latency via an app-level ping/pong for the debug overlay
 *
 * Deliberately has ZERO knowledge of canvas/drawing concepts — this file
 * only knows about "connect, send JSON, receive JSON, reconnect". Keeping
 * network plumbing separate from rendering/state logic is what lets
 * canvas.js be tested and reasoned about independently.
 */

class WSClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = new Map();
    this.reconnectDelay = 800;
    this.maxReconnectDelay = 12000;
    this.shouldReconnect = true;
    this.connected = false;

    this._pingSentAt = 0;
    this.lastLatencyMs = null;

    this._connect();
    this._startAppLevelPing();
  }

  _connect() {
    this._emit('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      this.reconnectDelay = 800;
      this._emit('open');
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        console.warn('Received malformed message from server, ignoring.', err);
        return;
      }
      if (msg && msg.type === '__pong') {
        this.lastLatencyMs = Date.now() - this._pingSentAt;
        return;
      }
      this._emit('message', msg);
      if (msg && msg.type) this._emit(msg.type, msg);
    });

    ws.addEventListener('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) this._emit('disconnected');
      this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // The 'close' event always follows an 'error' for browser WebSockets,
      // so reconnect scheduling happens there — nothing to duplicate here.
    });
  }

  _scheduleReconnect() {
    if (!this.shouldReconnect) return;
    this._emit('reconnecting', { delayMs: this.reconnectDelay });
    setTimeout(() => this._connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.7, this.maxReconnectDelay);
  }

  // App-level ping distinct from the WS protocol ping/pong (which is
  // handled transparently by the browser) — this one round-trips through
  // our own message handler so we can measure and display latency.
  _startAppLevelPing() {
    setInterval(() => {
      if (!this.connected) return;
      this._pingSentAt = Date.now();
      this.send({ type: '__ping' });
    }, 4000);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false; // caller decides whether/how to handle a dropped send
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    const list = this.handlers.get(type);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  _emit(type, payload) {
    const list = this.handlers.get(type);
    if (!list) return;
    for (const fn of list.slice()) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`Error in handler for "${type}"`, err);
      }
    }
  }

  destroy() {
    this.shouldReconnect = false;
    if (this.ws) this.ws.close();
  }
}
