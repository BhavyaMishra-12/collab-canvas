# Collaborative Canvas

A multi-user, real-time collaborative drawing app. Multiple people draw on
the same canvas at once, see each other's strokes appear live (not just on
completion), see each other's cursors, and share one global undo/redo
history.

Built with vanilla JavaScript + the HTML5 Canvas API on the frontend, and a
**hand-rolled WebSocket server on plain Node.js** — no `ws`, no
`socket.io`, no frontend framework. See [ARCHITECTURE.md](./ARCHITECTURE.md)
for why, and for the full protocol/design writeup.

## Setup

Requires Node.js 16+. No external packages are needed — the WebSocket
protocol (handshake + framing) is implemented from scratch in
`server/ws-lite.js`, so `npm install` has nothing to fetch and works
offline.

```bash
npm install   # no-op — zero runtime dependencies, included for convention
npm start
```

Then open **http://localhost:3000** in your browser.

The port can be overridden: `PORT=8080 npm start`.

## Testing with multiple users

The simplest way: open **http://localhost:3000** in two or more browser
tabs (or two different browsers, or a phone on the same network hitting
`http://<your-machine-ip>:3000`). Every tab joins the same default room and
you'll see:

- Each tab's strokes streaming into the others **while being drawn**, not
  just after you lift the pen.
- A colored, labeled cursor dot for every other connected user, moving live.
- An "Online" panel on the left listing everyone currently connected.
- Undo (`Ctrl/Cmd+Z`) and redo (`Ctrl/Cmd+Shift+Z` or `Ctrl+Y`) from *any*
  tab affecting the *shared* canvas — try drawing in tab A and undoing from
  tab B.

To test **isolated rooms**, add a `?room=` query param, e.g.
`http://localhost:3000/?room=team-standup` — tabs with different room
names don't see each other, tabs with the same room name do.

To test **reconnection**: open a tab, start drawing, then stop the server
(`Ctrl+C` in the terminal running `npm start`) and restart it
(`npm start` again). The tab's status pill will show "disconnected —
retrying…" and then reconnect automatically within a few seconds (it
re-fetches the current canvas state on reconnect). Note: a reconnect gets
you a **new** identity/color/cursor (see Known limitations).

There's also a small non-browser integration test at `test/test-client.js`
that drives the server directly over raw TCP (simulating two users:
drawing, undo, redo, a malformed frame, and a disconnect) — useful if
you want to sanity-check the server without opening a browser:

```bash
npm start &            # in one terminal
node test/test-client.js   # in another
```

## Known limitations

- **No authentication or persistence.** Both are explicitly out of scope
  per the spec. Canvas state lives in server memory per room and is lost
  when the server restarts or the last user in a room leaves.
- **Reconnects get a new identity.** Because there's no auth, a dropped
  connection that reconnects is treated as a brand-new user (new color,
  new presence entry) rather than resuming the same one. Their previously
  drawn strokes remain on the canvas (they're part of the shared op log),
  but "who owns which color" shifts after a reconnect.
- **A user who joins mid-stroke won't see that in-progress stroke** until
  it commits — they'll simply see it appear all at once when the drawer
  lifts the pen. This is a deliberate simplification (see
  ARCHITECTURE.md's conflict-handling section) rather than a bug: fully
  solving it would mean replaying arbitrary in-flight partial strokes to
  a joining client, which adds real complexity for a rare, low-stakes edge
  case.
- **Global (not per-user) undo.** Any user's undo can remove *any* user's
  most recent stroke. This is intentional per the spec ("synchronized
  global undo/redo") but can surprise users in a busy room — see the
  tradeoff discussion in `server/drawing-state.js` and ARCHITECTURE.md.
- **No canvas panning/zooming.** The canvas is a single fixed-size sheet
  (1600×900 logical pixels) that scales to fit your window; there's no
  infinite/zoomable canvas.
- **`ctx.roundRect`** (used for cursor name-tag backgrounds) needs a
  reasonably modern browser (Chrome 99+, Firefox 112+, Safari 16+, 2022 or
  later). On older browsers the cursor labels will throw a console error
  but drawing itself is unaffected.
- **Single-process only.** Room state lives in the memory of one Node
  process. Running multiple server instances behind a load balancer would
  require moving room state to a shared store (e.g. Redis) — not
  implemented here, since it's outside the stated scope.
- **No rate limiting / abuse protection.** A malicious client could flood
  the server with messages. The server won't crash (bad JSON/unknown
  message types are handled gracefully), but there's no throttling.

## Project structure

```
client/
  index.html      canvas layers + toolbar + presence panel markup
  style.css       plain CSS
  canvas.js       all canvas rendering/drawing-state logic (no networking)
  websocket.js    WebSocket client wrapper: connect, reconnect, message bus
  main.js         bootstraps the app, wires DOM + network + canvas together
server/
  server.js       HTTP server (serves /client) + WebSocket message protocol
  rooms.js        room/session/presence management
  drawing-state.js authoritative per-room op log + undo/redo logic
  ws-lite.js      zero-dependency WebSocket protocol implementation
test/
  test-client.js  raw-socket integration test exercising the whole protocol
```
