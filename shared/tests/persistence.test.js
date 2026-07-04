'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mulberry32, mulberry32FromState } = require('../rng');
const { newGame, buildCombatQueue, resolveCombatQueue } = require('../game_engine');
const P = require('../persistence');

test('mulberry32 exposes .state and resumes exactly via mulberry32FromState', () => {
  const rng = mulberry32(12345);
  const before = mulberry32(12345);
  // fresh factory == fresh from-state (backward compatible)
  assert.equal(rng(), before());

  rng(); rng(); rng();
  const saved = rng.state;
  const continued = [rng(), rng(), rng()];
  const resumed = mulberry32FromState(saved);
  const replay = [resumed(), resumed(), resumed()];
  assert.deepEqual(continued, replay, 'resumed stream continues bit-identically');
});

function surface(id, col, row, sp, weapons) {
  return {
    id, name: id, category: 'surface', composition: [], stayingPower: sp, movement: 0,
    detectionRange: { surface: 8 }, attackRange: { surface: 6 }, weapons, capabilities: {}, position: { col, row },
  };
}

function playedRoom(seed) {
  const customOB = { forces: {
    blue: [surface('B1', 0, 0, 10, { ascm: { quantity: 8, range: 6 } })],
    red: [surface('R1', 1, 0, 6, { ascm: { quantity: 8, range: 6 } })],
  } };
  const state = newGame(customOB, { seed });
  state.phase = 'combat';
  state.blueAttacks = [{ attackerId: 'B1', targetId: 'R1', amount: 3 }];
  state.redAttacks = [{ attackerId: 'R1', targetId: 'B1', amount: 3 }];
  state.combatQueue = buildCombatQueue(state);
  resolveCombatQueue(state); // consumes rng (seeded) + fills combatHistory
  return {
    id: 'ROOM1', players: { blue: 'sock-b', red: null, facilitator: 'sock-f' },
    state, baseOB: {}, customOB, capabilityFactors: { A_SSN: true }, seed,
    bots: { blue: false, red: true }, turnTimerSec: 45,
    cleanupTimer: {}, turnTimer: {},
  };
}

test('serializeRoom -> JSON -> deserializeRoom preserves game state and resumes rng', () => {
  const room = playedRoom(99);
  const json = JSON.parse(JSON.stringify(P.serializeRoom(room)));
  const r = P.deserializeRoom(json);

  assert.equal(r.id, 'ROOM1');
  assert.equal(r.seed, 99);
  assert.equal(r.turnTimerSec, 45);
  assert.deepEqual(r.bots, { blue: false, red: true });
  // players are dropped (ephemeral socket ids)
  assert.deepEqual(r.players, { blue: null, red: null, facilitator: null });
  // full state preserved
  assert.equal(r.state.turn, room.state.turn);
  assert.equal(r.state.phase, room.state.phase);
  assert.deepEqual(r.state.units.map(u => u.hp), room.state.units.map(u => u.hp));
  assert.equal(r.state.combatHistory.length, room.state.combatHistory.length);
  assert.ok(r.state.combatHistory.length > 0, 'combat actually happened');
  // rng resumes at the exact saved position
  assert.equal(typeof r.state.rng, 'function');
  assert.equal(r.state.rng(), room.state.rng(), 'restored rng continues the same stream');
});

test('deserialized room with no seed has a null rng (deterministic)', () => {
  const room = playedRoom(undefined);
  const r = P.deserializeRoom(JSON.parse(JSON.stringify(P.serializeRoom(room))));
  assert.equal(r.state.rng, null);
});

test('loadRooms restores fresh snapshots and discards stale ones', () => {
  const rooms = new Map();
  rooms.set('ROOM1', playedRoom(7));
  const file = path.join(os.tmpdir(), `oas-persist-${process.pid}.json`);
  const now = 1000000;

  // fresh snapshot (savedAt = now) -> restored
  fs.writeFileSync(file, JSON.stringify(P.snapshot(rooms, now)));
  const dest = new Map();
  assert.equal(P.loadRooms(dest, file, 60000, now + 5000), 1);
  assert.ok(dest.has('ROOM1'));

  // stale snapshot (older than maxAge) -> discarded
  const dest2 = new Map();
  assert.equal(P.loadRooms(dest2, file, 60000, now + 5 * 60000), 0);
  assert.equal(dest2.size, 0);

  // missing file -> 0, no throw
  assert.equal(P.loadRooms(new Map(), file + '.nope', 60000, now), 0);
  fs.unlinkSync(file);
});
