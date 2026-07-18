'use strict';
/**
 * main.js
 * -------
 * Bootstraps the app: creates the WSClient and CanvasEngine, and wires
 * DOM/pointer events <-> network messages <-> canvas rendering. This file
 * intentionally contains no low-level canvas math (that's canvas.js) and
 * no WebSocket framing/reconnect logic (that's websocket.js) — it's just
 * the glue, which is what makes each of those independently testable.
 */

(function () {
  const baseCanvas = document.getElementById('base-canvas');
  const liveCanvas = document.getElementById('live-canvas');
  const stage = document.getElementById('canvas-stage');
  const engine = new CanvasEngine(baseCanvas, liveCanvas, stage);

  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const room = new URLSearchParams(location.search).get('room') || 'default';
  const ws = new WSClient(`${wsProtocol}//${location.host}/?room=${encodeURIComponent(room)}`);

  // ---------------------------------------------------------------
  // Local UI state
  // ---------------------------------------------------------------
  let myUserId = null;
  let myColor = '#1d3557';
  let myName = '';
  const users = new Map(); // userId -> { color, name }

  let currentTool = 'brush';
  let currentColor = document.getElementById('color-picker').value;
  let currentWidth = Number(document.getElementById('width-slider').value);

  let canUndo = false;
  let canRedo = false;

  // Points accumulated since the last animation frame, flushed as a
  // single batched 'stroke-point' message per frame (see ARCHITECTURE.md
  // "Batching") instead of firing a network message per raw pointer event.
  let pendingPoints = [];
  let activeOpId = null;
  let lastCursorSentAt = 0;

  // ---------------------------------------------------------------
  // Toolbar wiring
  // ---------------------------------------------------------------
  const toolButtons = document.querySelectorAll('.tool-btn');
  toolButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      toolButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = btn.dataset.tool;
    });
  });

  document.getElementById('color-picker').addEventListener('input', (e) => {
    currentColor = e.target.value;
  });

  const widthSlider = document.getElementById('width-slider');
  const widthValue = document.getElementById('width-value');
  widthSlider.addEventListener('input', (e) => {
    currentWidth = Number(e.target.value);
    widthValue.textContent = `${currentWidth}px`;
  });

  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  undoBtn.addEventListener('click', () => ws.send({ type: 'undo' }));
  redoBtn.addEventListener('click', () => ws.send({ type: 'redo' }));

  window.addEventListener('keydown', (e) => {
    const meta = e.ctrlKey || e.metaKey;
    if (!meta) return;
    if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      ws.send({ type: 'undo' });
    } else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
      e.preventDefault();
      ws.send({ type: 'redo' });
    }
  });

  function updateUndoRedoButtons() {
    undoBtn.disabled = !canUndo;
    redoBtn.disabled = !canRedo;
  }

  // ---------------------------------------------------------------
  // Presence panel
  // ---------------------------------------------------------------
  function renderPresence() {
    const list = document.getElementById('presence-list');
    list.innerHTML = '';
    for (const [userId, u] of users) {
      const li = document.createElement('li');
      li.className = 'presence-item' + (userId === myUserId ? ' is-you' : '');
      const dot = document.createElement('span');
      dot.className = 'presence-dot';
      dot.style.background = u.color;
      const label = document.createElement('span');
      label.textContent = u.name + (userId === myUserId ? ' (you)' : '');
      li.appendChild(dot);
      li.appendChild(label);
      list.appendChild(li);
    }
    document.getElementById('debug-users').textContent = String(users.size);
  }

  // ---------------------------------------------------------------
  // Connection status pill
  // ---------------------------------------------------------------
  const statusPill = document.getElementById('connection-status');
  function setStatus(text, cls) {
    statusPill.textContent = text;
    statusPill.className = `status-pill ${cls}`;
  }
  ws.on('connecting', () => setStatus('connecting…', 'status-connecting'));
  ws.on('open', () => setStatus('connected', 'status-connected'));
  ws.on('disconnected', () => setStatus('disconnected — retrying…', 'status-disconnected'));
  ws.on('reconnecting', () => setStatus('reconnecting…', 'status-connecting'));

  // ---------------------------------------------------------------
  // Server -> client message handling
  // ---------------------------------------------------------------
  ws.on('init', (msg) => {
    myUserId = msg.userId;
    myColor = msg.color;
    myName = msg.name;
    document.getElementById('color-picker').value = currentColor; // keep user's own tool choice
    users.clear();
    for (const u of msg.users) users.set(u.userId, { color: u.color, name: u.name });
    users.set(myUserId, { color: myColor, name: myName });
    renderPresence();

    engine.loadSnapshot(msg.ops);
    canUndo = msg.canUndo;
    canRedo = msg.canRedo;
    updateUndoRedoButtons();
    document.getElementById('debug-ops').textContent = String(msg.ops.length);
  });

  ws.on('user-joined', (msg) => {
    users.set(msg.userId, { color: msg.color, name: msg.name });
    renderPresence();
  });

  ws.on('user-left', (msg) => {
    users.delete(msg.userId);
    engine.removeRemoteCursor(msg.userId);
    renderPresence();
  });

  ws.on('stroke-start', (msg) => {
    engine.beginRemoteStroke(msg.opId, {
      userId: msg.userId,
      tool: msg.tool,
      color: msg.color,
      width: msg.width,
      point: msg.point,
    });
  });

  ws.on('stroke-point', (msg) => {
    engine.addRemoteStrokePoints(msg.opId, msg.points);
  });

  ws.on('stroke-end', (msg) => {
    if (msg.userId === myUserId) {
      // Our own stroke, now confirmed authoritative by the server:
      // stop rendering it as a local live-preview...
      engine.clearLocalStroke(msg.opId);
    } else {
      engine.endRemoteStroke(msg.opId);
    }
    if (msg.op) {
      // ...and (for both local and remote) commit it to the base layer.
      engine.addCommittedOp(msg.op);
      canUndo = true;
      canRedo = false; // a fresh op always invalidates the redo branch (mirrors server state)
      updateUndoRedoButtons();
      document.getElementById('debug-ops').textContent = String(engine.ops.length);
    }
  });

  ws.on('cursor', (msg) => {
    const u = users.get(msg.userId);
    engine.updateRemoteCursor(msg.userId, msg.x, msg.y, u ? u.color : '#888', u ? u.name : '');
  });

  ws.on('op-undone', (msg) => {
    engine.markUndone(msg.opId);
    canUndo = engine.ops.some((o) => !o.undone);
    canRedo = true;
    updateUndoRedoButtons();
  });

  ws.on('op-redone', (msg) => {
    engine.markRedone(msg.opId, msg.op);
    canUndo = true;
    canRedo = engine.ops.some((o) => o.undone); // best-effort local mirror of server's redo stack size
    updateUndoRedoButtons();
  });

  ws.on('error', (msg) => {
    console.warn('Server reported an error:', msg.message);
  });

  // ---------------------------------------------------------------
  // Local pointer input -> drawing + batched network sends
  // ---------------------------------------------------------------
  function genOpId() {
    return `${myUserId || 'anon'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  let isDrawing = false;

  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    isDrawing = true;
    const point = engine.toLogicalPoint(e.clientX, e.clientY);
    activeOpId = genOpId();
    pendingPoints = [];
    engine.beginLocalStroke(activeOpId, currentTool, currentColor, currentWidth, point);
    ws.send({
      type: 'stroke-start',
      opId: activeOpId,
      tool: currentTool,
      width: currentWidth,
      point,
    });
  });

  stage.addEventListener('pointermove', (e) => {
    const point = engine.toLogicalPoint(e.clientX, e.clientY);

    // Cursor broadcast — throttled to ~20/sec regardless of native pointermove rate.
    const now = performance.now();
    if (now - lastCursorSentAt > 50) {
      lastCursorSentAt = now;
      ws.send({ type: 'cursor', x: point.x, y: point.y });
    }

    if (!isDrawing) return;
    engine.addLocalPoint(point);
    pendingPoints.push(point);
  });

  function endStroke() {
    if (!isDrawing) return;
    isDrawing = false;
    const stroke = engine.endLocalStroke();
    ws.send({
      type: 'stroke-end',
      opId: activeOpId,
      tool: currentTool,
      width: currentWidth,
      points: stroke ? stroke.points : [],
    });
    activeOpId = null;
    pendingPoints = [];
  }

  stage.addEventListener('pointerup', endStroke);
  stage.addEventListener('pointercancel', endStroke);
  stage.addEventListener('pointerleave', (e) => {
    // Only end the stroke if no buttons are pressed anymore (pointerleave
    // can fire while still drawing if the pointer briefly leaves bounds
    // under fast motion with pointer capture — guard against ending early).
    if (isDrawing && e.buttons === 0) endStroke();
  });

  // Flush batched in-progress points once per animation frame — this is
  // the "batch points per animation frame" design decision from the
  // spec: sending a network message per raw pointermove event would
  // flood the socket at 100+ Hz on a fast mouse/tablet; batching to the
  // display's own refresh rate is both smooth and bandwidth-sane.
  function flushPendingPoints() {
    if (isDrawing && pendingPoints.length > 0 && activeOpId) {
      ws.send({ type: 'stroke-point', opId: activeOpId, points: pendingPoints });
      pendingPoints = [];
    }
    requestAnimationFrame(flushPendingPoints);
  }
  requestAnimationFrame(flushPendingPoints);

  // ---------------------------------------------------------------
  // Debug overlay (stretch goal: FPS / latency)
  // ---------------------------------------------------------------
  const debugOverlay = document.getElementById('debug-overlay');
  document.getElementById('debug-toggle').addEventListener('click', () => {
    debugOverlay.classList.toggle('hidden');
  });

  let frameCount = 0;
  let lastFpsSample = performance.now();
  function debugLoop() {
    frameCount += 1;
    const now = performance.now();
    if (now - lastFpsSample >= 500) {
      const fps = Math.round((frameCount * 1000) / (now - lastFpsSample));
      document.getElementById('debug-fps').textContent = String(fps);
      frameCount = 0;
      lastFpsSample = now;
      document.getElementById('debug-ping').textContent =
        ws.lastLatencyMs != null ? String(ws.lastLatencyMs) : '--';
    }
    requestAnimationFrame(debugLoop);
  }
  requestAnimationFrame(debugLoop);
})();
