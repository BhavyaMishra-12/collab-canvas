'use strict';
/**
 * drawing-state.js
 * ----------------
 * The single source of truth for a room's canvas contents.
 *
 * Data model
 * ----------
 * The canvas is never mutated directly. Instead it's derived from an
 * append-only, ordered log of "operations" (a completed stroke or eraser
 * pass). Each operation looks like:
 *
 *   {
 *     opId: "uuid",
 *     userId: "user-123",
 *     type: "stroke" | "erase",
 *     color: "#ff5470",
 *     width: 4,
 *     points: [{x,y}, ...],   // already-smoothed path
 *     sequence: 47,            // server-assigned, monotonically increasing
 *     undone: false,
 *   }
 *
 * Global undo/redo
 * ----------------
 * Undo/redo is modeled as *toggling visibility of an operation in the
 * shared log*, not as inverse-editing the canvas. That reframing is what
 * makes multi-user undo tractable:
 *
 *   - `undo()` finds the most recently added operation (by sequence) that
 *     is currently visible, across ALL users, and marks it undone. It is
 *     pushed onto a shared `redoStack`.
 *   - `redo()` pops the most recently undone op off `redoStack` and marks
 *     it visible again.
 *   - Any brand-new operation clears the redo stack (standard undo/redo
 *     semantics — "doing something new" invalidates the old redo branch).
 *
 * Because any new operation clears the redo stack, `redoStack` is always
 * a strict, contiguous suffix of the sequence — i.e. undo/redo only ever
 * operate on the tail of the log. This is what lets the client optimize:
 * undo requires a full repaint (removing an op from the middle of a
 * composited raster isn't invertible in place), but redo can just replay
 * that one operation on top of the existing raster. See ARCHITECTURE.md.
 *
 * Global vs. per-user undo — the tradeoff
 * ----------------------------------------
 * This app deliberately implements GLOBAL undo: any user's Ctrl+Z can
 * undo ANY user's most recent stroke, not just their own. This matches
 * the spec ("synchronized global undo/redo") and keeps the model simple
 * (one stack, one source of truth). The tradeoff: in a busy room, user A
 * might undo user B's stroke, which can feel surprising ("I didn't draw
 * that, why did undo remove it?"). We accept this because per-user undo
 * stacks reintroduce the exact ordering ambiguity ("whose stroke is
 * logically 'last' when two people finish at the same instant?") that
 * server-assigned sequencing was meant to eliminate. This tradeoff is
 * documented again in ARCHITECTURE.md.
 */

let opIdCounter = 0;
function nextOpId() {
  opIdCounter += 1;
  return `op-${Date.now()}-${opIdCounter}`;
}

class DrawingState {
  constructor() {
    this.ops = [];       // full ordered log, append-only
    this.redoStack = [];  // opIds, most-recently-undone last
    this._sequence = 0;
  }

  /** Commit a finished stroke/erase operation. Returns the stored op (with assigned sequence). */
  commitOp({ userId, type, color, width, points }) {
    this._sequence += 1;
    const op = {
      opId: nextOpId(),
      userId,
      type,
      color,
      width,
      points,
      sequence: this._sequence,
      undone: false,
    };
    this.ops.push(op);
    // A new operation always invalidates the old redo branch.
    this.redoStack = [];
    return op;
  }

  /** Marks the most recent visible op as undone. Returns the op, or null if nothing to undo. */
  undo() {
    for (let i = this.ops.length - 1; i >= 0; i--) {
      if (!this.ops[i].undone) {
        this.ops[i].undone = true;
        this.redoStack.push(this.ops[i].opId);
        return this.ops[i];
      }
    }
    return null;
  }

  /** Restores the most recently undone op. Returns the op, or null if nothing to redo. */
  redo() {
    const opId = this.redoStack.pop();
    if (!opId) return null;
    const op = this.ops.find((o) => o.opId === opId);
    if (!op) return null;
    op.undone = false;
    return op;
  }

  /** All currently-visible ops, in sequence order — enough to fully reconstruct the canvas. */
  visibleOps() {
    return this.ops.filter((o) => !o.undone);
  }

  /** Full snapshot for a newly-joining client. */
  snapshot() {
    return {
      ops: this.ops,
      canUndo: this.ops.some((o) => !o.undone),
      canRedo: this.redoStack.length > 0,
    };
  }
}

module.exports = { DrawingState };
