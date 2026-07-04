'use strict';

/**
 * persistence.js
 * ==============
 *
 * Snapshots the in-memory `rooms` map to a JSON file so that in-progress games
 * survive a server restart (crash, deploy, container recycle). Node-only.
 *
 * What is persisted: room config (baseOB/customOB, capability factors, seed,
 * bots, turn-timer) and the full game state (units, turn/period/phase, attacks,
 * done flags, log, messages, combatHistory, winner, movementSnapshot).
 *
 * What is NOT persisted (and why):
 *   - `players` (socket ids) — ephemeral; after a restart every socket is gone,
 *     so restored rooms start with no one connected. Clients rejoin by room
 *     code (rejoin_room / join_room), which is why the code is preserved.
 *   - live timers (cleanupTimer/turnTimer) — re-armed by normal flow on rejoin.
 *   - `state.rng` (a function) — not JSON-serializable, so its internal counter
 *     is saved as `rngState` and the generator is resumed exactly via
 *     mulberry32FromState (shared/rng.js), continuing the same stream.
 *
 * Saving is debounced: game code calls markDirty() on every state change and a
 * single interval flushes at most every `intervalMs`. A final flush runs on
 * SIGINT/SIGTERM. Writes are atomic (temp file + rename).
 */

const fs = require('fs');
const path = require('path');
const { mulberry32FromState } = require('./rng');

const DAY_MS = 24 * 60 * 60 * 1000;

let _enabled = false, _dirty = false, _timer = null, _file = null, _rooms = null;

function serializeState(state) {
  if (!state) return null;
  const { rng, ...rest } = state;
  return { ...rest, combatQueue: [], rngState: (rng && rng.state != null) ? rng.state : null };
}

function serializeRoom(room) {
  return {
    id: room.id,
    baseOB: room.baseOB,
    customOB: room.customOB,
    capabilityFactors: room.capabilityFactors,
    seed: room.seed,
    bots: room.bots,
    turnTimerSec: room.turnTimerSec || 0,
    state: serializeState(room.state),
  };
}

function deserializeState(s) {
  if (!s) return null;
  const { rngState, ...rest } = s;
  const state = { ...rest, combatQueue: [] };
  state.rng = (rngState != null) ? mulberry32FromState(rngState) : null;
  return state;
}

function deserializeRoom(o) {
  return {
    id: o.id,
    players: { blue: null, red: null, facilitator: null },
    state: deserializeState(o.state),
    baseOB: o.baseOB,
    customOB: o.customOB,
    capabilityFactors: o.capabilityFactors,
    seed: o.seed,
    bots: o.bots || { blue: false, red: false },
    turnTimerSec: o.turnTimerSec || 0,
    cleanupTimer: null,
    turnTimer: null,
  };
}

/** Serializes every room to a snapshot object. Exposed for tests. */
function snapshot(rooms, nowMs) {
  const payload = { savedAt: nowMs, rooms: [] };
  for (const room of rooms.values()) payload.rooms.push(serializeRoom(room));
  return payload;
}

function saveNow(nowMs) {
  if (!_file || !_rooms) return;
  const payload = snapshot(_rooms, nowMs != null ? nowMs : Date.now());
  const tmp = _file + '.tmp';
  fs.mkdirSync(path.dirname(_file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, _file); // atomic replace
  _dirty = false;
}

function markDirty() { if (_enabled) _dirty = true; }

/**
 * Rebuilds rooms from the snapshot file into `rooms`. Skips a snapshot older
 * than `maxAgeMs` (stale games). Returns the number of rooms restored.
 */
function loadRooms(rooms, file, maxAgeMs = DAY_MS, nowMs) {
  try {
    if (!fs.existsSync(file)) return 0;
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!payload || !Array.isArray(payload.rooms)) return 0;
    const now = nowMs != null ? nowMs : Date.now();
    if (payload.savedAt && (now - payload.savedAt) > maxAgeMs) return 0;
    let n = 0;
    for (const o of payload.rooms) {
      if (o && o.id) { rooms.set(o.id, deserializeRoom(o)); n++; }
    }
    return n;
  } catch (e) {
    console.error('[persist] load failed:', e.message);
    return 0;
  }
}

/** Enables debounced autosave + shutdown flush against `rooms` -> `file`. */
function startAutosave(rooms, file, intervalMs = 5000) {
  _rooms = rooms; _file = file; _enabled = true;
  _timer = setInterval(() => {
    if (_dirty) { try { saveNow(); } catch (e) { console.error('[persist] save failed:', e.message); } }
  }, intervalMs);
  if (_timer.unref) _timer.unref();
  const flush = () => { try { saveNow(); } catch { /* best effort */ } };
  process.once('SIGINT', () => { flush(); process.exit(0); });
  process.once('SIGTERM', () => { flush(); process.exit(0); });
  return _timer;
}

/** Stops autosave (used by tests to avoid leaking the interval). */
function stopAutosave() { if (_timer) { clearInterval(_timer); _timer = null; } _enabled = false; _rooms = null; _file = null; }

module.exports = {
  serializeState, serializeRoom, deserializeState, deserializeRoom,
  snapshot, saveNow, markDirty, loadRooms, startAutosave, stopAutosave,
};
