'use strict';
/**
 * rooms.js
 * --------
 * Manages the set of active rooms. Each room owns:
 *   - a DrawingState (the authoritative op log — see drawing-state.js)
 *   - a Map of connected users (userId -> { conn, color, name, cursor })
 *   - a Set of in-progress (not-yet-committed) live strokes, keyed by opId,
 *     so a client that joins mid-stroke doesn't need special-casing (it
 *     simply won't see partial strokes until they commit — documented
 *     limitation, see README).
 *
 * Rooms are created lazily on first join and garbage collected when the
 * last user leaves (state is intentionally NOT persisted — see spec:
 * persistence is out of scope / optional).
 */

const { DrawingState } = require('./drawing-state');

// A palette of visually distinct, accessible colors handed out round-robin
// per room so simultaneous users are easy to tell apart at a glance.
const USER_COLORS = [
  '#e63946', '#2a9d8f', '#457b9d', '#f4a261',
  '#8338ec', '#ff006e', '#06d6a0', '#ffb703',
  '#3a86ff', '#fb5607', '#7209b7', '#2b9348',
];

const ADJECTIVES = ['Swift', 'Bright', 'Calm', 'Bold', 'Quiet', 'Sharp', 'Warm', 'Cool', 'Quick', 'Gentle'];
const ANIMALS = ['Fox', 'Owl', 'Lynx', 'Wren', 'Otter', 'Hawk', 'Crane', 'Puma', 'Finch', 'Heron'];

function randomName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${a} ${b}`;
}

class Room {
  constructor(id) {
    this.id = id;
    this.state = new DrawingState();
    this.users = new Map(); // userId -> { conn, color, name }
    this._colorCursor = 0;
  }

  nextColor() {
    const color = USER_COLORS[this._colorCursor % USER_COLORS.length];
    this._colorCursor += 1;
    return color;
  }

  addUser(userId, conn) {
    const user = { conn, color: this.nextColor(), name: randomName(), cursor: null };
    this.users.set(userId, user);
    return user;
  }

  removeUser(userId) {
    this.users.delete(userId);
  }

  isEmpty() {
    return this.users.size === 0;
  }

  presenceList() {
    return Array.from(this.users.entries()).map(([id, u]) => ({
      userId: id,
      color: u.color,
      name: u.name,
    }));
  }

  /** Send a JSON message to every user in the room except (optionally) one. */
  broadcast(message, exceptUserId) {
    const payload = JSON.stringify(message);
    for (const [userId, user] of this.users) {
      if (userId === exceptUserId) continue;
      user.conn.send(payload);
    }
  }

  sendTo(userId, message) {
    const user = this.users.get(userId);
    if (!user) return;
    user.conn.send(JSON.stringify(message));
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  getOrCreate(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Room(roomId));
    }
    return this.rooms.get(roomId);
  }

  get(roomId) {
    return this.rooms.get(roomId);
  }

  /** Call after a user leaves a room; cleans up empty rooms so memory doesn't grow unbounded. */
  maybeCleanup(roomId) {
    const room = this.rooms.get(roomId);
    if (room && room.isEmpty()) {
      this.rooms.delete(roomId);
    }
  }
}

module.exports = { RoomManager };
