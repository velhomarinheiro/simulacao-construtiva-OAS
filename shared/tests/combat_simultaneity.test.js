'use strict';

// Tests for the simultaneous combat resolution (P0 methodological fixes):
//   1. Simultaneity      — a unit killed this phase still delivers its own
//                          already-declared fire (no Blue-first free strike).
//   2. Battery saturation — several attackers share the defender's interceptor
//                          magazine instead of each facing the full battery.
//   3. Aggregate clip    — overkill on one defender is capped once at the
//                          aggregate, with the applied loss attributed
//                          proportionally back to each engagement.

const test = require('node:test');
const assert = require('node:assert/strict');

const { newGame, buildCombatQueue, resolveCombatQueue } = require('../game_engine');
const { SALVO_KERNELS } = require('../combat_config');

const P_ASCM = SALVO_KERNELS.ascmSurface.surface; // 1.75 expected dmg / shot

function surface(id, col, row, sp, weapons) {
  return {
    id, name: id, category: 'surface', composition: [],
    stayingPower: sp, movement: 0,
    detectionRange: { surface: 2, air: 2, submarine: 1, land: 1 },
    attackRange: { surface: 6, air: 1, submarine: 1, land: 1 },
    weapons, capabilities: {}, position: { col, row },
  };
}

function setup(blue, red, blueAttacks, redAttacks = []) {
  const state = newGame({ forces: { blue, red } });
  state.phase = 'combat';
  state.blueAttacks = blueAttacks;
  state.redAttacks = redAttacks;
  state.combatQueue = buildCombatQueue(state);
  return state;
}

const hp = (state, id) => state.units.find(u => u.id === id).hp;

test('simultaneity: a unit killed this phase still deals its declared damage', () => {
  // Both sides can overkill each other (raw 7 vs SP 4). Under the old
  // Blue-first, immediate-mutation queue, Blue killed Red and Red's return
  // fire was cancelled, so Blue survived. Simultaneous resolution kills both.
  const state = setup(
    [surface('B1', 0, 0, 4, { ascm: { quantity: 4, range: 6 } })],
    [surface('R1', 1, 0, 4, { ascm: { quantity: 4, range: 6 } })],
    [{ attackerId: 'B1', targetId: 'R1', amount: 4 }],
    [{ attackerId: 'R1', targetId: 'B1', amount: 4 }],
  );

  resolveCombatQueue(state);

  assert.equal(hp(state, 'R1'), 0, 'Red destroyed');
  assert.equal(hp(state, 'B1'), 0, 'Blue also destroyed by the dead unit\'s return fire');
  assert.equal(state.combatQueue.length, 2);
  for (const eng of state.combatQueue) assert.equal(eng.result.destroyed, true);
});

test('battery saturation: attackers share the defender interceptor pool', () => {
  // Two 4-shot ASCM salvos vs a 6-round airDefense battery. Shared budget:
  // first engagement uses 4, second uses the remaining 2 (not another full 6).
  const state = setup(
    [
      surface('B1', 0, 0, 10, { ascm: { quantity: 4, range: 6 } }),
      surface('B2', 0, 0, 10, { ascm: { quantity: 4, range: 6 } }),
    ],
    [surface('R1', 1, 0, 100, { airDefense: { quantity: 6, range: 1 } })],
    [
      { attackerId: 'B1', targetId: 'R1', amount: 4 },
      { attackerId: 'B2', targetId: 'R1', amount: 4 },
    ],
  );

  resolveCombatQueue(state);

  const [e1, e2] = state.combatQueue;
  assert.equal(e1.result.interception.details[0].shots, 4, 'first salvo faces 4 interceptors');
  assert.equal(e2.result.interception.details[0].shots, 2, 'second salvo faces only the remaining 2');
});

test('aggregate clip: overkill capped once, attributed proportionally', () => {
  // Two raw-7 salvos (14 total incoming) on a 5-SP target: applied loss is
  // clipped once to 5, and each engagement is credited 7*5/14 = 2.5.
  const state = setup(
    [
      surface('B1', 0, 0, 10, { ascm: { quantity: 4, range: 6 } }),
      surface('B2', 0, 0, 10, { ascm: { quantity: 4, range: 6 } }),
    ],
    [surface('R1', 1, 0, 5, {})],
    [
      { attackerId: 'B1', targetId: 'R1', amount: 4 },
      { attackerId: 'B2', targetId: 'R1', amount: 4 },
    ],
  );

  resolveCombatQueue(state);

  assert.equal(hp(state, 'R1'), 0);
  const [e1, e2] = state.combatQueue;
  assert.ok(Math.abs(e1.result.actualLoss - 2.5) < 1e-9, `e1 share ${e1.result.actualLoss}`);
  assert.ok(Math.abs(e2.result.actualLoss - 2.5) < 1e-9, `e2 share ${e2.result.actualLoss}`);
  const applied = e1.result.actualLoss + e2.result.actualLoss;
  assert.ok(Math.abs(applied - 5) < 1e-9, 'summed attributed loss equals the applied clip');
  assert.equal(e1.result.destroyed, true);
  assert.equal(e2.result.destroyed, true);
});

test('single engagement (no overkill) resolves to the plain expected loss', () => {
  // Sanity: the simultaneous path must not distort the ordinary case.
  const state = setup(
    [surface('B1', 0, 0, 10, { ascm: { quantity: 4, range: 6 } })],
    [surface('R1', 1, 0, 100, {})],
    [{ attackerId: 'B1', targetId: 'R1', amount: 2 }],
  );

  resolveCombatQueue(state);

  const raw = P_ASCM * 2; // 3.5
  assert.ok(Math.abs(hp(state, 'R1') - (100 - raw)) < 1e-9);
  assert.ok(Math.abs(state.combatQueue[0].result.actualLoss - raw) < 1e-9);
  assert.equal(state.combatQueue[0].result.destroyed, false);
});
