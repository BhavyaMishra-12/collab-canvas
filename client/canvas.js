'use strict';
/**
 * canvas.js
 * ---------
 * All canvas rendering and drawing-state logic lives here. This module
 * knows nothing about WebSockets — it exposes plain methods that
 * main.js calls in response to network events, and plain methods that
 * main.js calls in response to local input. That separation is what
 * keeps rendering, networking, and state each independently readable.
 *
 * Layering strategy (perf decision — see ARCHITECTURE.md "Redraw strategy")
 * ---------------------------------------------------------------------
 * Two stacked canvases:
 *   - #base-canvas: committed, authoritative history. Appending a new
 *     op is O(1) (just draw it on top). Undo requires a full repaint
 *     (O(n) in visible ops) because removing a layer from the middle of
 *     a composited raster — especially with an eraser's
 *     destination-out blending — isn't invertible in place. Redo is
 *     O(1) again, because the redo stack is always a contiguous tail
 *     (see drawing-state.js for why).
 *   - #live-canvas: repainted every animation frame from scratch. Holds
 *     only ephemeral things: strokes that haven't committed yet (local
 *     and remote), plus remote cursor indicators. Clearing+redrawing
 *     this layer every frame is cheap because it only ever holds a
 *     handful of short, in-progress paths, never the full history.
 *
 * Fixed logical coordinate space
 * -------------------------------
 * The canvas has a fixed logical resolution (LOGICAL_W x LOGICAL_H)
 * regardless of each user's actual window size or device pixel ratio.
 * All drawing coordinates sent over the wire are in this logical space.
 * The DOM element is then scaled via CSS to fit each user's viewport.
 * This is what keeps two users' strokes aligned to the same canvas
 * region even when their browser windows are different sizes — without
 * it, "draw at (400, 300)" would mean a different physical spot for
 * each participant.
 */

const LOGICAL_W = 1600;
const LOGICAL_H = 900;

function drawPathToContext(ctx, points, { tool, color, width }) {
  if (!points || points.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (points.length === 1) {
    // A single point (click without drag) renders as a dot so it's still visible.
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Smoothing: quadratic curves through successive midpoints. This is the
  // standard "midpoint smoothing" trick — instead of straight segments
  // between raw sampled points (which look faceted/jagged), each curve's
  // control point is an actual sampled point and its endpoints are the
  // midpoints of adjacent segments, producing a continuously smooth path
  // through jittery mouse/touch input without needing a heavier spline library.
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
  ctx.restore();
}

class CanvasEngine {
  constructor(baseCanvas, liveCanvas, stageEl) {
    this.baseCanvas = baseCanvas;
    this.liveCanvas = liveCanvas;
    this.stageEl = stageEl;
    this.baseCtx = baseCanvas.getContext('2d');
    this.liveCtx = liveCanvas.getContext('2d');

    // Authoritative mirror of the server's op log (see drawing-state.js).
    this.ops = [];
    this.opIndex = new Map();

    // In-progress strokes not yet committed, keyed by opId.
    this.remoteLiveStrokes = new Map(); // opId -> { userId, tool, color, width, points }
    this.localLiveStroke = null;        // { opId, tool, color, width, points } | null

    // Remote cursor indicators, keyed by userId.
    this.remoteCursors = new Map(); // userId -> { x, y, color, name, lastSeen }

    this._resize();
    window.addEventListener('resize', () => this._resize());

    this._rafHandle = null;
    this._startRenderLoop();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    for (const canvas of [this.baseCanvas, this.liveCanvas]) {
      canvas.width = LOGICAL_W * dpr;
      canvas.height = LOGICAL_H * dpr;
    }
    this.baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // A resize invalidates nothing about logical coordinates (they're
    // fixed), but the backing store was just cleared, so repaint base.
    this._repaintBase();
  }

  /** Converts a pointer/mouse event's client coordinates into logical canvas coordinates. */
  toLogicalPoint(clientX, clientY) {
    const rect = this.stageEl.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * LOGICAL_W,
      y: ((clientY - rect.top) / rect.height) * LOGICAL_H,
    };
  }

  // ---------------------------------------------------------------
  // Authoritative op log (driven by server messages)
  // ---------------------------------------------------------------

  /** Full snapshot on join/reconnect. */
  loadSnapshot(ops) {
    this.ops = ops.slice().sort((a, b) => a.sequence - b.sequence);
    this.opIndex = new Map(this.ops.map((op) => [op.opId, op]));
    this._repaintBase();
  }

  /** A brand-new committed op arrived (always appended at the tail). */
  addCommittedOp(op) {
    this.ops.push(op);
    this.opIndex.set(op.opId, op);
    // New ops are always visible and always at the tail — a cheap
    // incremental draw on top of the existing raster is correct here.
    drawPathToContext(this.baseCtx, op.points, op);
  }

  /** An op was toggled hidden. Requires a full repaint (see class docstring). */
  markUndone(opId) {
    const op = this.opIndex.get(opId);
    if (!op) return;
    op.undone = true;
    this._repaintBase();
  }

  /** An op was toggled visible again. Always the tail, so an incremental draw suffices. */
  markRedone(opId, opFromServer) {
    let op = this.opIndex.get(opId);
    if (!op && opFromServer) {
      // Shouldn't normally happen (redo only ever affects ops we've already
      // seen) but fall back to trusting the server's copy defensively.
      op = opFromServer;
      this.ops.push(op);
      this.opIndex.set(op.opId, op);
    }
    if (!op) return;
    op.undone = false;
    drawPathToContext(this.baseCtx, op.points, op);
  }

  _repaintBase() {
    this.baseCtx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
    for (const op of this.ops) {
      if (!op.undone) drawPathToContext(this.baseCtx, op.points, op);
    }
  }

  // ---------------------------------------------------------------
  // Local drawing (the user of THIS client actively dragging)
  // ---------------------------------------------------------------

  beginLocalStroke(opId, tool, color, width, point) {
    this.localLiveStroke = { opId, tool, color, width, points: [point] };
  }

  addLocalPoint(point) {
    if (!this.localLiveStroke) return;
    this.localLiveStroke.points.push(point);
  }

  /** Returns the full point list and clears the live-preview slot (called once the server confirms). */
  endLocalStroke() {
    const stroke = this.localLiveStroke;
    return stroke;
  }

  /** Called once the server has echoed back our own committed op — stop drawing it as a "live" preview. */
  clearLocalStroke(opId) {
    if (this.localLiveStroke && this.localLiveStroke.opId === opId) {
      this.localLiveStroke = null;
    }
  }

  // ---------------------------------------------------------------
  // Remote in-progress strokes (other users actively dragging)
  // ---------------------------------------------------------------

  beginRemoteStroke(opId, { userId, tool, color, width, point }) {
    this.remoteLiveStrokes.set(opId, { userId, tool, color, width, points: [point] });
  }

  addRemoteStrokePoints(opId, points) {
    const stroke = this.remoteLiveStrokes.get(opId);
    if (!stroke) return; // late points for a stroke we never saw start (e.g. joined mid-stroke) — safe to ignore
    for (const p of points) stroke.points.push(p);
  }

  endRemoteStroke(opId) {
    this.remoteLiveStrokes.delete(opId);
  }

  // ---------------------------------------------------------------
  // Remote cursors
  // ---------------------------------------------------------------

  updateRemoteCursor(userId, x, y, color, name) {
    this.remoteCursors.set(userId, { x, y, color, name, lastSeen: performance.now() });
  }

  removeRemoteCursor(userId) {
    this.remoteCursors.delete(userId);
  }

  // ---------------------------------------------------------------
  // Live layer render loop
  // ---------------------------------------------------------------

  _startRenderLoop() {
    const loop = () => {
      this._renderLiveFrame();
      this._rafHandle = requestAnimationFrame(loop);
    };
    this._rafHandle = requestAnimationFrame(loop);
  }

  _renderLiveFrame() {
    const ctx = this.liveCtx;
    ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);

    // Drop cursors we haven't heard from in a while (user likely left the canvas area).
    const now = performance.now();
    for (const [userId, cursor] of this.remoteCursors) {
      if (now - cursor.lastSeen > 8000) this.remoteCursors.delete(userId);
    }

    for (const stroke of this.remoteLiveStrokes.values()) {
      drawPathToContext(ctx, stroke.points, stroke);
    }
    if (this.localLiveStroke) {
      drawPathToContext(ctx, this.localLiveStroke.points, this.localLiveStroke);
    }

    for (const cursor of this.remoteCursors.values()) {
      this._drawCursor(ctx, cursor);
    }
  }

  _drawCursor(ctx, cursor) {
    ctx.save();
    ctx.fillStyle = cursor.color;
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = '12px -apple-system, sans-serif';
    const label = cursor.name || '';
    const paddingX = 6;
    const textWidth = ctx.measureText(label).width;
    const boxX = cursor.x + 10;
    const boxY = cursor.y - 10;

    ctx.fillStyle = 'rgba(20, 24, 30, 0.78)';
    ctx.beginPath();
    ctx.roundRect(boxX, boxY - 14, textWidth + paddingX * 2, 20, 5);
    ctx.fill();

    ctx.fillStyle = 'white';
    ctx.fillText(label, boxX + paddingX, boxY);
    ctx.restore();
  }

  destroy() {
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
  }
}
