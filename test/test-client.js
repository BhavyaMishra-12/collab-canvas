'use strict';
// Quick-and-dirty raw WebSocket client for integration testing server.js
// without any npm dependency (mirrors the handshake/framing in ws-lite.js).
const net = require('net');
const crypto = require('crypto');

function connect({ host, port, path }, onMessage) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '', '',
      ].join('\r\n');
      socket.write(req);
    });

    let handshakeDone = false;
    let buffer = Buffer.alloc(0);

    function send(obj) {
      const payload = Buffer.from(JSON.stringify(obj), 'utf8');
      const maskKey = crypto.randomBytes(4);
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ maskKey[i % 4];

      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[1] = 0x80 | payload.length;
      } else {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      }
      header[0] = 0x81;
      socket.write(Buffer.concat([header, maskKey, masked]));
    }

    function parseFrames() {
      while (true) {
        if (buffer.length < 2) return;
        const byte1 = buffer[1];
        let len = byte1 & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (buffer.length < offset + len) return;
        const payload = buffer.slice(offset, offset + len);
        buffer = buffer.slice(offset + len);
        try {
          onMessage(JSON.parse(payload.toString('utf8')));
        } catch (e) { /* ignore control frames etc */ }
      }
    }

    socket.on('data', (chunk) => {
      if (!handshakeDone) {
        const str = chunk.toString('utf8');
        if (str.includes('\r\n\r\n')) {
          handshakeDone = true;
          const rest = str.split('\r\n\r\n').slice(1).join('\r\n\r\n');
          if (rest) {
            buffer = Buffer.concat([buffer, Buffer.from(rest, 'utf8')]);
            parseFrames();
          }
          resolve({ send, socket });
        }
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      parseFrames();
    });

    socket.on('error', reject);
  });
}

async function main() {
  const messagesA = [];
  const messagesB = [];

  const a = await connect({ host: 'localhost', port: 3000, path: '/?room=testroom' }, (m) => messagesA.push(m));
  await new Promise((r) => setTimeout(r, 100));
  const b = await connect({ host: 'localhost', port: 3000, path: '/?room=testroom' }, (m) => messagesB.push(m));
  await new Promise((r) => setTimeout(r, 200));

  console.log('--- A received on join (should include init, user-joined for B) ---');
  console.log(messagesA.map((m) => m.type));
  console.log('--- B received on join (should include init only) ---');
  console.log(messagesB.map((m) => m.type));

  const initA = messagesA.find((m) => m.type === 'init');
  console.log('A userId:', initA.userId, 'color:', initA.color);

  // A draws a stroke
  const opId1 = 'test-op-1';
  a.send({ type: 'stroke-start', opId: opId1, tool: 'brush', width: 5, point: { x: 10, y: 10 } });
  a.send({ type: 'stroke-point', opId: opId1, points: [{ x: 20, y: 20 }, { x: 30, y: 30 }] });
  a.send({ type: 'stroke-end', opId: opId1, tool: 'brush', width: 5, points: [{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }] });

  await new Promise((r) => setTimeout(r, 200));

  console.log('\n--- B should have received stroke-start/point/end for A\'s stroke ---');
  console.log(messagesB.map((m) => m.type));

  // Note: msg.opId (used for stroke-start/point/end correlation) is the
  // CLIENT-generated id for the live-stroke; the committed log entry
  // (msg.op) gets its own SERVER-generated opId used for undo/redo. These
  // are intentionally different identifiers for different purposes.
  const strokeEndB = messagesB.find((m) => m.type === 'stroke-end' && m.opId === opId1);
  console.log('B saw committed op with sequence:', strokeEndB && strokeEndB.op && strokeEndB.op.sequence);
  const committedOpId = strokeEndB && strokeEndB.op && strokeEndB.op.opId;

  const strokeEndA = messagesA.find((m) => m.type === 'stroke-end' && m.opId === opId1);
  console.log('A (sender) also received its own committed op back:', !!strokeEndA);

  // B triggers undo — should affect A's stroke (GLOBAL undo)
  messagesA.length = 0;
  messagesB.length = 0;
  b.send({ type: 'undo' });
  await new Promise((r) => setTimeout(r, 150));
  console.log('\n--- After B undoes A\'s stroke ---');
  console.log('A received:', messagesA.map((m) => m.type));
  console.log('B received:', messagesB.map((m) => m.type));
  const undoneMsg = messagesA.find((m) => m.type === 'op-undone');
  console.log('Undone opId matches committed op:', undoneMsg && undoneMsg.opId === committedOpId);

  // A redoes
  messagesA.length = 0;
  messagesB.length = 0;
  a.send({ type: 'redo' });
  await new Promise((r) => setTimeout(r, 150));
  const redoneMsg = messagesB.find((m) => m.type === 'op-redone');
  console.log('\nAfter A redoes, B sees op-redone for correct op:', redoneMsg && redoneMsg.opId === committedOpId);

  // Test malformed message handling doesn't crash server
  a.socket.write(Buffer.from([0x81, 0x83, 0,0,0,0, 0x7b, 0x22, 0x62])); // truncated/garbage masked frame
  await new Promise((r) => setTimeout(r, 200));

  // Verify server still alive by sending a valid ping
  messagesA.length = 0;
  a.send({ type: '__ping' });
  await new Promise((r) => setTimeout(r, 150));
  console.log('\nServer survived malformed frame, still responds:', messagesA.some((m) => m.type === '__pong'));

  // Disconnect B, confirm A gets user-left
  messagesA.length = 0;
  b.socket.end();
  await new Promise((r) => setTimeout(r, 500));
  console.log('A received user-left after B disconnects:', messagesA.some((m) => m.type === 'user-left'));

  a.socket.end();
  console.log('\nAll integration checks complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
