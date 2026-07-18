'use strict';
/**
 * server.js
 * ---------
 * HTTP server (serves the static /client files) + WebSocket server
 * (drives real-time collaboration). See ARCHITECTURE.md for the full
 * message protocol and design rationale.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { attachWebSocketServer } = require('./ws-lite');
const { RoomManager } = require('./rooms');

const PORT = process.env.PORT || 3000;
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const DEFAULT_ROOM = 'default';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------
// Static file serving (no framework — this is intentionally simple: the
// deliverable is a real-time canvas app, not a web server showcase).
// ---------------------------------------------------------------------
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.normalize(path.join(CLIENT_DIR, urlPath));
  // Guard against path traversal outside the client directory.
  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const httpServer = http.createServer(serveStatic);
const rooms = new RoomManager();

// ---------------------------------------------------------------------
// WebSocket wiring
// ---------------------------------------------------------------------
attachWebSocketServer(httpServer, {
  onConnection(conn, req) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const roomId = (url.searchParams.get('room') || DEFAULT_ROOM).slice(0, 64) || DEFAULT_ROOM;

    const room = rooms.getOrCreate(roomId);
    const userId = crypto.randomUUID();
    const user = room.addUser(userId, conn);

    // Track in-progress (uncommitted) strokes we've relayed for this
    // connection, so a mid-draw disconnect can be cleanly announced to
    // other clients instead of leaving a dangling live stroke on screen.
    const openStrokes = new Set();

    // ---- send initial state snapshot to the newly joined client ----
    const snapshot = room.state.snapshot();
    conn.send(JSON.stringify({
      type: 'init',
      userId,
      color: user.color,
      name: user.name,
      users: room.presenceList(),
      ops: snapshot.ops,
      canUndo: snapshot.canUndo,
      canRedo: snapshot.canRedo,
    }));

    // ---- tell everyone else someone joined ----
    room.broadcast({
      type: 'user-joined',
      userId,
      color: user.color,
      name: user.name,
    }, userId);

    conn.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (err) {
        // Malformed message from client — ignore, don't crash the room for everyone else.
        conn.send(JSON.stringify({ type: 'error', message: 'Malformed message: expected JSON' }));
        return;
      }
      if (!msg || typeof msg.type !== 'string') {
        conn.send(JSON.stringify({ type: 'error', message: 'Malformed message: missing type' }));
        return;
      }

      try {
        handleMessage(msg);
      } catch (err) {
        // A single bad message should never take the server down.
        console.error('Error handling message', msg && msg.type, err);
        conn.send(JSON.stringify({ type: 'error', message: 'Server error handling message' }));
      }
    });

    conn.on('close', () => {
      // Clean up any strokes this user left mid-draw so other clients
      // don't keep a ghost in-progress stroke rendered forever.
      for (const opId of openStrokes) {
        room.broadcast({ type: 'stroke-end', opId, userId, aborted: true }, userId);
      }
      room.removeUser(userId);
      room.broadcast({ type: 'user-left', userId });
      rooms.maybeCleanup(roomId);
    });

    conn.on('error', () => {
      /* 'close' will also fire; nothing extra to do here */
    });

    function handleMessage(msg) {
      switch (msg.type) {
        case 'stroke-start': {
          if (!msg.opId || !msg.point) return;
          openStrokes.add(msg.opId);
          room.broadcast({
            type: 'stroke-start',
            opId: msg.opId,
            userId,
            tool: msg.tool === 'eraser' ? 'eraser' : 'brush',
            color: user.color,
            width: typeof msg.width === 'number' ? msg.width : 4,
            point: msg.point,
          }, userId);
          break;
        }

        case 'stroke-point': {
          if (!msg.opId || !Array.isArray(msg.points)) return;
          // Only relay points for strokes we know are open, to ignore
          // stray/late points after a stroke has already ended.
          if (!openStrokes.has(msg.opId)) return;
          room.broadcast({
            type: 'stroke-point',
            opId: msg.opId,
            userId,
            points: msg.points,
          }, userId);
          break;
        }

        case 'stroke-end': {
          if (!msg.opId) return;
          openStrokes.delete(msg.opId);
          if (!Array.isArray(msg.points) || msg.points.length === 0) {
            // Nothing to commit (e.g. a click with no movement) — just
            // relay the end so other clients drop their live-preview.
            room.broadcast({ type: 'stroke-end', opId: msg.opId, userId, empty: true }, userId);
            return;
          }
          const op = room.state.commitOp({
            userId,
            type: msg.tool === 'eraser' ? 'erase' : 'stroke',
            color: user.color,
            width: typeof msg.width === 'number' ? msg.width : 4,
            points: msg.points,
          });
          // Broadcast to EVERYONE (including sender) so the sender also
          // switches from its local live-preview to the authoritative,
          // sequenced op — keeping every client's canvas derived from
          // the same source of truth.
          room.broadcast({ type: 'stroke-end', opId: msg.opId, userId, op });
          break;
        }

        case 'cursor': {
          if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
          room.broadcast({ type: 'cursor', userId, x: msg.x, y: msg.y }, userId);
          break;
        }

        case 'undo': {
          const op = room.state.undo();
          if (op) {
            room.broadcast({ type: 'op-undone', opId: op.opId, byUserId: userId });
          }
          break;
        }

        case 'redo': {
          const op = room.state.redo();
          if (op) {
            room.broadcast({ type: 'op-redone', opId: op.opId, byUserId: userId, op });
          }
          break;
        }

        case '__ping': {
          // App-level latency probe (distinct from WS protocol ping/pong) — echoed straight back.
          conn.send(JSON.stringify({ type: '__pong' }));
          break;
        }

        default:
          conn.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
      }
    }
  },
});

// ---------------------------------------------------------------------
// Keepalive: ping every connection periodically; if we haven't seen a
// pong (or any traffic) since the last ping, the connection is dead —
// tear it down so the room's presence list stays accurate.
// ---------------------------------------------------------------------
const HEARTBEAT_MS = 30000;
setInterval(() => {
  for (const room of rooms.rooms.values()) {
    for (const [userId, user] of room.users) {
      if (user.conn.isAlive === false) {
        user.conn.close();
        continue;
      }
      user.conn.isAlive = false;
      user.conn.ping();
    }
  }
}, HEARTBEAT_MS).unref();

httpServer.listen(PORT, () => {
  console.log(`Collaborative canvas server listening on http://localhost:${PORT}`);
});
