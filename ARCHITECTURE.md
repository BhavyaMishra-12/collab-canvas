# Architecture

## 1. Data flow: user → canvas → server → other clients

```
 User A's browser                    Server (per room)                 User B's browser
 ─────────────────                   ──────────────────                ─────────────────
 pointerdown/move/up
        │
        ▼
 CanvasEngine draws          stroke-start
 immediately to the   ─────────────────────▶   Room.broadcast()  ─────────────────▶  CanvasEngine draws
 LIVE layer (zero            stroke-point                                            A's in-progress
 local latency)       ─────────────────────▶   (relay to everyone                    stroke on ITS
        │                    (batched per rAF)   else in the room)                    live layer, live,
        │                                                                             while A is still
        ▼                                                                             dragging
 on pointerup:
 full point list
 sent as stroke-end   ─────────────────────▶   DrawingState.commitOp()
                                                 - assigns `sequence`
                                                 - appends to op log
                                                 - clears redo stack
                                                        │
                              stroke-end (with the              stroke-end (with the
                              committed op + sequence)           committed op + sequence)
                       ◀─────────────────────  broadcast to  ─────────────────────▶
                              ALL clients,                          same as A
                              including A itself
        │                                                                    │
        ▼                                                                    ▼
 A moves the stroke                                                   B commits the op to
 from its live layer                                                  its BASE layer (this
 to its base layer                                                    is the first time B's
 (reconciliation —                                                    canvas becomes
 see §4)                                                               authoritative-consistent
                                                                        with A's)
```

Cursors follow the same shape as strokes but skip the server's op log
entirely — they're pure ephemeral broadcast, never persisted, never part
of undo/redo.

Undo/redo flow is symmetric but user-agnostic: **any** client can send
`{type: 'undo'}` with no payload; the server decides *what* gets undone
(the global log's current tail) and broadcasts the result to everyone,
including the client that didn't ask for it.

## 2. WebSocket message protocol

All messages are JSON objects with a `type` field, sent over a single
persistent connection per client (`ws://host/?room=<roomId>`).

### Client → Server

| type | payload | purpose |
|---|---|---|
| `stroke-start` | `{opId, tool, width, point: {x,y}}` | Begin a new stroke. `opId` is client-generated (used only to correlate `stroke-point`/`stroke-end` for this in-progress stroke — it is **not** the eventual op's permanent id, see §3). |
| `stroke-point` | `{opId, points: [{x,y}, ...]}` | One batch of additional points for an in-progress stroke, flushed once per animation frame (see §5). |
| `stroke-end` | `{opId, tool, width, points: [{x,y}, ...]}` | Finish a stroke and send the **full** point list for authoritative commit. Sending the full list (rather than relying on the server to have buffered every `stroke-point`) makes the server's commit self-contained and robust to any dropped/out-of-order `stroke-point` message. |
| `cursor` | `{x, y}` | Live pointer position, throttled client-side to ~20/sec. |
| `undo` | *(none)* | Request a global undo. |
| `redo` | *(none)* | Request a global redo. |
| `__ping` | *(none)* | App-level latency probe (distinct from the WS-protocol ping/pong, which `ws-lite.js` answers transparently) — used only to drive the debug overlay's ms readout. |

### Server → Client

| type | payload | purpose |
|---|---|---|
| `init` | `{userId, color, name, users: [...], ops: [...], canUndo, canRedo}` | Sent once, immediately on connect. Full state needed to render the room from scratch. |
| `user-joined` | `{userId, color, name}` | Presence: someone else connected. |
| `user-left` | `{userId}` | Presence: someone else disconnected (clean or abrupt — see §6). |
| `stroke-start` | `{opId, userId, tool, color, width, point}` | Relayed from another client's `stroke-start`. `color`/`width` are the *server's* record of that user/stroke, not trusted from elsewhere. |
| `stroke-point` | `{opId, userId, points}` | Relayed batch of points for someone else's in-progress stroke. |
| `stroke-end` | `{opId, userId, op?}` | The stroke finished. If `op` is present, it's the authoritative committed operation (with server-assigned `opId`/`sequence`) — see §3 for why this is a *different* id than the `opId` used above. If `points` was empty (a click with no drag), `empty: true` is set instead and there's nothing to commit. |
| `op-undone` | `{opId, byUserId}` | A committed op (identified by its own log id) was hidden. |
| `op-redone` | `{opId, byUserId, op}` | A previously-hidden op is visible again. |
| `error` | `{message}` | The server rejected or couldn't parse something the client sent — the client logs it and carries on. |
| `__pong` | *(none)* | Reply to `__ping`. |

Every inbound message is wrapped in a `try/catch`; malformed JSON or an
unrecognized `type` gets an `error` reply back to *that* client only —
it never takes down the room for anyone else.

## 3. Undo/redo strategy

**Model: an append-only, ordered operation log with a visibility flag,
not "undo = reverse-apply an edit."**

```js
{
  opId: "op-1737...-42",   // SERVER-generated identity for this log entry
  userId: "user-123",
  type: "stroke" | "erase",
  points: [...],
  color: "#ff5470",
  width: 4,
  sequence: 47,             // server-assigned, monotonically increasing
  undone: false,
}
```

- `undo()` walks the log from the tail backwards and flips the **most
  recent visible** op's `undone` to `true`, regardless of which user
  created it, then pushes its id onto a shared `redoStack`.
- `redo()` pops the most recently undone id off `redoStack` and flips
  `undone` back to `false`.
- **Any brand-new op clears `redoStack`.** This is standard undo/redo
  semantics (doing something new invalidates the old redo branch) — the
  only twist in a multi-user setting is that "something new" can come
  from a *different user* than the one who undid. We accept that as the
  simplest, least-surprising-in-aggregate rule; seepara "Global vs.
  per-user undo" below for the tradeoff.

**Why this is the right model for a shared canvas:** reversing an
already-composited raster (especially with an eraser's
`destination-out` blending against strokes underneath it) isn't
generally invertible — you can't "subtract" a stroke back out of pixels
that have since been eroded by other strokes and erasers on top of it.
Toggling *visibility in the source log* and recomputing pixels from
scratch sidesteps that entirely: the log is the truth, the canvas is
just a rendering of "every op where `undone === false`, in `sequence`
order."

**The tail-only invariant, and why it matters for performance:**
because any new op clears the redo stack, `redoStack` is always a
contiguous run at the very end of the sequence. In other words: undo and
redo only ever operate on ops at the tail. That's what lets the client
optimize asymmetrically:
- **Undo → full repaint** of the base canvas (`O(visible ops)`), because
  removing a layer from the *middle* of a composited raster requires
  rebuilding everything above it.
- **Redo → single incremental draw** (`O(1)`), because restoring the
  most recently undone op is always restoring the tail — it can just be
  stamped on top of the current raster exactly like a brand-new op can.

**Global vs. per-user undo — the tradeoff:**
The spec calls for *synchronized global* undo/redo, so that's what's
implemented: any user's `Ctrl+Z` can remove *anyone's* most recent
stroke. The alternative (each user gets their own undo stack, scoped to
their own strokes) avoids the "wait, I didn't draw that, why did my undo
remove it?" surprise — but it reintroduces exactly the ordering
ambiguity that server-assigned sequencing was meant to eliminate: if
user A and user B each maintain independent undo stacks, what does
"undo" mean for the *shared* canvas when both stacks are non-empty and
diverge? Per-user stacks are a genuinely defensible design for some
apps, but they don't satisfy "synchronized global undo/redo" as stated,
and they trade one class of surprise (global reach) for another
(divergent local histories). Global-with-a-single-shared-log was chosen
as the more literal, more tractable interpretation of the requirement.

**Edge case — user A undoes while user B is actively drawing:**
Undo/redo only ever touch **committed** ops in the server's log.
User B's in-progress stroke doesn't exist in that log yet — it's still
purely a live relay (`stroke-start`/`stroke-point`) with no
representation in `DrawingState`. So `undo()` simply can't see it, and
B's stroke is entirely unaffected. When B eventually lifts the pen,
`stroke-end` commits it as a new op with the next `sequence` number,
*after* A's undo in log order — there's no race, because commit and
undo are both handled by the single-threaded server acting on one
in-memory log; whichever message the event loop processes first simply
happens first, deterministically.

## 4. Performance decisions

- **Two-layer canvas (base + live), not one.** Redrawing the *entire*
  history on every single mouse-move would be prohibitively expensive as
  the drawing grows. Splitting into a rarely-fully-repainted `base`
  layer (only touched wholesale on undo, or once per finished stroke
  incrementally) and a cheap, always-fully-repainted `live` layer (which
  only ever holds a handful of short in-progress paths plus cursor
  dots) means the expensive full-canvas operation is rare, and the
  cheap one stays cheap because what it's redrawing never grows.
- **Client-side prediction, server-side reconciliation.** The user
  drawing sees their own stroke instantly on the `live` layer, with zero
  round-trip latency — they don't wait for the server to confirm before
  seeing ink. Once the server's `stroke-end` for that same `opId` comes
  back (round-trip time later), the client swaps that stroke from its
  local live-preview into the authoritative base layer. In the interim
  the *drawing user* is looking at an optimistic local copy, while
  *everyone else* is looking at nothing yet for that stroke (they only
  start seeing it once `stroke-start` arrives, which is also
  near-instant). This is the standard "predict locally, reconcile on
  server echo" pattern — the observable tradeoff is that on a slow
  connection, the drawing user's own stroke can briefly be
  ahead of what the network has actually confirmed, but since strokes
  are pure appends (never destructively edited by someone else while a
  user is mid-drag), there's nothing to *roll back* — reconciliation
  here is a hand-off, not a correction.
- **Batching points per animation frame, not per pointer event.** A fast
  mouse or a graphics tablet can emit `pointermove` well over 100 times a
  second. Sending one WebSocket message per event would flood the
  socket for no visual benefit (nothing renders faster than the
  screen's own refresh rate anyway). Points are accumulated into a
  buffer and flushed as a single `stroke-point` message once per
  `requestAnimationFrame`, which caps outbound message rate to the
  display's refresh rate (typically 60/sec) regardless of input rate,
  while still feeling perfectly live.
- **Cursor broadcasts are throttled independently** (~20/sec, via a
  simple timestamp check) rather than tied to the render loop, since
  cursor position is even lower-stakes than stroke data — nobody notices
  20Hz vs 60Hz cursor updates, but it meaningfully cuts bandwidth in a
  busy room.
- **Fixed logical coordinate space (1600×900), scaled via CSS.** Points
  are transmitted in a resolution-independent logical coordinate space,
  not raw pixel coordinates of each user's actual window. Without this,
  "draw at (400, 300)" would land in a different physical spot on the
  canvas for a user with a 4K monitor versus one on a laptop — the
  canvas element's internal drawing buffer is fixed at
  `LOGICAL_W × LOGICAL_H × devicePixelRatio` and the DOM element is
  scaled to fit each viewport via CSS `aspect-ratio`, with pointer
  coordinates converted through the element's `getBoundingClientRect()`
  back into logical space before ever touching the network.
- **Smoothing via quadratic-curve midpoints, not a spline library.**
  Raw point-to-point line segments from mouse/touch sampling look
  visibly faceted. Instead of pulling in a curve-fitting library, each
  interior sampled point becomes the *control point* of a
  `quadraticCurveTo`, with the curve's start/end anchored at the
  midpoints of adjacent segments — a well-known, cheap technique that
  turns jittery raw samples into a continuously smooth path with no
  extra dependency and no visible latency (it's recomputed every frame
  for in-progress strokes at negligible cost, since strokes are short).

## 5. Conflict resolution approach

**Strategy: server-authoritative sequencing.** The server is the single
point that assigns a monotonically increasing `sequence` number to each
op, at the moment its `stroke-end` arrives (not when the stroke
*started* — see below). Every client renders committed ops strictly in
`sequence` order, so two strokes that overlap the same region of canvas
composite in the same order on every client, regardless of the order in
which each client's local network/CPU happened to observe them.

**Why sequence-on-commit, not sequence-on-start:** assigning the
sequence number at `stroke-start` time would mean two users starting
strokes within the same few milliseconds could be sequenced in an order
that has nothing to do with when their ink actually landed on top of
each other — and worse, a fast one-second stroke started slightly after
a slow ten-second stroke would still need to "wait" for the slower one
to finish before its final position in the log is knowable, if
ordering were start-based. Sequencing at commit keeps the rule simple
and matches visual intuition: whichever stroke's ink *finishes landing*
first, paints first.

**Why this approach over the alternatives:**
- *Operational Transform / CRDT-based merging* is the "correct" answer
  for arbitrary concurrent edits with strong convergence guarantees, but
  it's substantial machinery for what a shared *paint* canvas actually
  needs — strokes are append-only, never edited in place by someone
  else, so there's no real "transform" to perform. OT/CRDTs earn their
  complexity when operations can conflict *structurally* (e.g.
  simultaneous edits to the same text range); painting doesn't have
  that problem because a later stroke simply paints over an earlier
  one — compositing order **is** the conflict resolution.
- *Client-side timestamp ordering* (each client stamps its own op with
  its local clock) is tempting because it needs no round-trip, but
  client clocks aren't reliably synchronized, and it opens the door to
  a client claiming an artificially early or late timestamp. Letting the
  server assign order removes any ambiguity and any trust requirement.
- *Last-write-wins on a shared canvas region* (e.g. locking or claiming
  grid cells) would prevent two users from ever legitimately drawing
  over the same spot, which directly contradicts the point of a
  collaborative canvas — overlapping ink is a *feature*, not a
  conflict to be prevented.

**Tradeoffs of server-authoritative sequencing:**
- It's simple, deterministic, and trivial to reason about — every
  client converges to *pixel-identical* output because they all replay
  the same ordered log through the same deterministic drawing routine.
- The cost is a small dependency on the server being the sole
  arbiter: if the server process were ever horizontally scaled across
  multiple instances without a shared sequence source, two instances
  could each hand out conflicting sequence numbers. This app is
  single-process by design (see README's known limitations), so that
  cost isn't paid here, but it's the reason this strategy doesn't
  automatically scale to multi-node without extra work (e.g. a shared
  atomic counter, or moving to a CRDT specifically to *avoid* needing a
  single arbiter).
- A user who joins mid-stroke doesn't see that stroke's in-progress
  motion, only its final commit — the live-stroke relay is deliberately
  *not* part of the durable log (only committed ops are), so there's
  nothing to "catch up" a late joiner on except the ops that have
  already landed. This is called out again in the README as a known
  limitation rather than hidden, since it's a real (if low-stakes) gap
  in "true" live parity for latecomers.

## 6. Error handling & reconnection

- **Malformed/garbage frames:** `ws-lite.js`'s frame parser is wrapped
  in a `try/catch` per incoming chunk; a corrupt frame closes just that
  one connection rather than crashing the process or affecting other
  users in the room.
- **Malformed JSON / unknown message `type`:** handled per-message in
  `server.js`, replies with an `error` message to the offending client
  only and continues serving everyone else.
- **Abrupt disconnects (closed tab, lost network, dropped phone
  screen):** the raw TCP `'end'` event (FIN received) is treated as the
  authoritative disconnect signal — rather than waiting for the slower,
  sometimes-delayed `'close'` event — so a user vanishing doesn't leave
  a stale entry in the presence list or a ghost in-progress stroke on
  other clients' screens for longer than necessary. Any stroke that
  user had open gets an `aborted: true` `stroke-end` broadcast so its
  live-preview is cleared everywhere else.
- **Client reconnection:** `websocket.js` reconnects with exponential
  backoff (starting at 800ms, capped at 12s) whenever the connection
  drops, and the UI's status pill reflects `connecting… /
  connected / disconnected — retrying…` at each stage. On reconnect the
  server treats it as a brand-new connection and sends a fresh `init`
  snapshot, so the client's canvas is guaranteed consistent with the
  server the moment it's back — at the cost of a new identity/color per
  reconnect (documented in the README, since there's no auth to
  re-attach an old identity to).
- **Server keepalive:** the server pings every connection every 30s and
  drops any connection that hasn't answered a previous ping, so
  half-dead TCP connections (e.g. a laptop that went to sleep) don't
  linger in a room's presence list indefinitely.
