'use strict';
/**
 * ws-lite.js
 * ----------
 * A minimal, dependency-free WebSocket server implementation (RFC 6455)
 * built directly on Node's `http` and `net`/`crypto` modules.
 *
 * Why hand-roll this instead of `npm install ws`?
 *   - It keeps the project at zero runtime dependencies, so `npm install`
 *     is instant and never depends on registry/network availability.
 *   - The wire protocol needed for this app is small (text frames, ping/pong,
 *     close) so the RFC surface we need is manageable to implement correctly.
 *   - It doubles as a fully worked example of what `ws` does under the hood.
 *
 * This is NOT meant to be a production-grade replacement for `ws` in general
 * (no permessage-deflate, no strict UTF-8 validation, no extension
 * negotiation) but it implements enough of RFC 6455 to be robust for this
 * app: masked-frame parsing, fragmented-frame reassembly across TCP packets,
 * ping/pong keepalive, and clean close handshakes.
 */

const crypto = require('crypto');
const EventEmitter = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODES = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

function acceptKeyFor(clientKey) {
  return crypto.createHash('sha1').update(clientKey + GUID).digest('base64');
}

/** Encode a UTF-8 string as an unmasked WebSocket text frame (server->client frames are never masked). */
function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | OPCODES.TEXT; // FIN=1, opcode=text
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | OPCODES.TEXT;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | OPCODES.TEXT;
    header[1] = 127;
    // JS-safe for payloads well under 2^53; ample for our use case.
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeControlFrame(opcode, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(2);
  header[0] = 0x80 | opcode;
  header[1] = payload.length; // control frames are always small (<126) per spec
  return Buffer.concat([header, payload]);
}

/**
 * Incremental frame parser. Client->server frames are always masked.
 * Handles frames split across multiple `data` events, and multiple
 * frames arriving in a single `data` event.
 */
class FrameParser extends EventEmitter {
  constructor() {
    super();
    this._buffer = Buffer.alloc(0);
    this._fragments = []; // for reassembling fragmented messages
    this._fragmentOpcode = null;
  }

  push(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    this._drain();
  }

  _drain() {
    // Keep parsing complete frames out of the buffer until we can't.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const frame = this._tryParseOne();
      if (!frame) return;
    }
  }

  _tryParseOne() {
    const buf = this._buffer;
    if (buf.length < 2) return null;

    const byte0 = buf[0];
    const byte1 = buf[1];
    const fin = (byte0 & 0x80) !== 0;
    const opcode = byte0 & 0x0f;
    const masked = (byte1 & 0x80) !== 0;
    let payloadLen = byte1 & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buf.length < offset + 2) return null;
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      payloadLen = Number(big); // fine for realistic drawing payloads
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.slice(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + payloadLen) return null; // wait for more data

    let payload = buf.slice(offset, offset + payloadLen);
    if (masked) {
      const unmasked = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = payload[i] ^ maskKey[i % 4];
      }
      payload = unmasked;
    }

    // Consume this frame from the buffer.
    this._buffer = buf.slice(offset + payloadLen);

    this._handleFrame({ fin, opcode, payload });
    return true;
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === OPCODES.PING) {
      this.emit('ping', payload);
      return;
    }
    if (opcode === OPCODES.PONG) {
      this.emit('pong', payload);
      return;
    }
    if (opcode === OPCODES.CLOSE) {
      this.emit('close-frame', payload);
      return;
    }

    // Text/binary/continuation — handle fragmentation.
    if (opcode !== OPCODES.CONTINUATION) {
      this._fragmentOpcode = opcode;
      this._fragments = [payload];
    } else {
      this._fragments.push(payload);
    }

    if (fin) {
      const full = Buffer.concat(this._fragments);
      this._fragments = [];
      const opcode2 = this._fragmentOpcode;
      this._fragmentOpcode = null;
      if (opcode2 === OPCODES.TEXT) {
        this.emit('message', full.toString('utf8'));
      } else {
        this.emit('binary', full);
      }
    }
  }
}

/**
 * Thin wrapper around a raw upgraded socket that mimics the small subset
 * of the `ws` client API this app relies on: .send(), .close(), .on('message'/'close'/'error'),
 * plus keepalive ping/pong.
 */
class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.isAlive = true;
    this._parser = new FrameParser();
    this._closed = false;

    this._parser.on('message', (str) => this.emit('message', str));
    this._parser.on('ping', (payload) => {
      this._writeSafe(encodeControlFrame(OPCODES.PONG, payload));
    });
    this._parser.on('pong', () => {
      this.isAlive = true;
    });
    this._parser.on('close-frame', () => this.close());

    socket.on('data', (chunk) => {
      try {
        this._parser.push(chunk);
      } catch (err) {
        // Malformed frame from a misbehaving/hostile client — don't crash the server.
        this.emit('error', err);
        this.close();
      }
    });
    socket.on('error', () => this._teardown());
    socket.on('close', () => this._teardown());
    // A client that disconnects abruptly (closes the tab, loses network,
    // drops the phone screen mid-draw) sends a TCP FIN, which surfaces
    // here as 'end' — sometimes well before 'close', since 'close' only
    // fires once the socket is fully torn down on both sides. We treat
    // 'end' as the authoritative disconnect signal so a user disappearing
    // doesn't leave a stale entry in the presence list, and proactively
    // finish the TCP close on our side instead of leaving it half-open.
    socket.on('end', () => {
      this._teardown();
      try {
        socket.end();
      } catch (err) {
        /* already closing */
      }
    });
  }

  send(str) {
    if (this._closed) return;
    this._writeSafe(encodeTextFrame(str));
  }

  ping() {
    if (this._closed) return;
    this._writeSafe(encodeControlFrame(OPCODES.PING));
  }

  _writeSafe(buf) {
    try {
      this.socket.write(buf);
    } catch (err) {
      this._teardown();
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      this.socket.end(encodeControlFrame(OPCODES.CLOSE));
    } catch (err) {
      /* socket may already be gone */
    }
    this.emit('close');
  }

  _teardown() {
    if (this._closed) return;
    this._closed = true;
    this.emit('close');
  }
}

/**
 * Attaches a WebSocket upgrade handler to an existing http.Server.
 * Calls `onConnection(WSConnection, request)` for each successful handshake.
 */
function attachWebSocketServer(httpServer, { onConnection }) {
  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const upgradeHeader = (req.headers['upgrade'] || '').toLowerCase();

    if (upgradeHeader !== 'websocket' || !key) {
      socket.destroy();
      return;
    }

    const acceptKey = acceptKeyFor(key);
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      '',
    ].join('\r\n');

    socket.write(responseHeaders);
    socket.setNoDelay(true);

    const conn = new WSConnection(socket);
    onConnection(conn, req);
  });
}

module.exports = { attachWebSocketServer };
