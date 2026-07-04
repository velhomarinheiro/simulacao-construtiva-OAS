'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { newGame, buildCombatQueue, resolveCombatQueue, stateFor } = require('../game_engine');

function surface(id, col, row, sp, weapons) {
  return {
    id, name: id, category: 'surface', composition: [], stayingPower: sp, movement: 0,
    detectionRange: { surface: 8 }, attackRange: { surface: 6 },
    weapons, capabilities: {}, position: { col, row },
  };
}

test('resolveCombatQueue appends a structured record per engagement', () => {
  const state = newGame({ forces: {
    blue: [surface('B1', 0, 0, 10, { ascm: { quantity: 4, range: 6 } })],
    red: [surface('R1', 1, 0, 4, { ascm: { quantity: 4, range: 6 } })],
  } });
  state.phase = 'combat';
  state.blueAttacks = [{ attackerId: 'B1', targetId: 'R1', amount: 4 }];
  state.redAttacks = [{ attackerId: 'R1', targetId: 'B1', amount: 2 }];
  state.combatQueue = buildCombatQueue(state);

  resolveCombatQueue(state);

  assert.equal(state.combatHistory.length, 2, 'one record per successful engagement');
  const bVsR = state.combatHistory.find(h => h.attackerId === 'B1');
  assert.equal(bVsR.targetId, 'R1');
  assert.equal(bVsR.attackerTeam, 'blue');
  assert.equal(bVsR.destroyed, true);
  assert.ok(bVsR.turn === 1 && typeof bVsR.weapon === 'string');
  assert.ok(bVsR.actualLoss > 0);

  // History accumulates across phases.
  const state2 = newGame({ forces: {
    blue: [surface('B1', 0, 0, 10, { ascm: { quantity: 8, range: 6 } })],
    red: [surface('R1', 1, 0, 100, {})],
  } });
  state2.phase = 'combat';
  state2.blueAttacks = [{ attackerId: 'B1', targetId: 'R1', amount: 2 }];
  state2.redAttacks = [];
  state2.combatQueue = buildCombatQueue(state2);
  resolveCombatQueue(state2);
  state2.blueAttacks = [{ attackerId: 'B1', targetId: 'R1', amount: 2 }];
  state2.combatQueue = buildCombatQueue(state2);
  resolveCombatQueue(state2);
  assert.equal(state2.combatHistory.length, 2, 'records accumulate, not reset');
});

test('players do not receive combatHistory; the facilitator does', () => {
  const state = newGame({ forces: {
    blue: [surface('B1', 0, 0, 10, { ascm: { quantity: 4, range: 6 } })],
    red: [surface('R1', 1, 0, 4, { ascm: { quantity: 4, range: 6 } })],
  } });
  state.phase = 'combat';
  state.blueAttacks = [{ attackerId: 'B1', targetId: 'R1', amount: 4 }];
  state.redAttacks = [];
  state.combatQueue = buildCombatQueue(state);
  resolveCombatQueue(state);

  assert.equal(stateFor(state, 'blue').combatHistory, undefined, 'player view has no combatHistory');
  assert.ok(Array.isArray(stateFor(state, 'facilitator').combatHistory), 'facilitator sees combatHistory');
});
