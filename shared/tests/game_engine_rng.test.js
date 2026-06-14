'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { newGame, resolveQueuedEngagement } = require('../game_engine');

function makeCustomOB() {
  return {
    forces: {
      blue: [{
        id: 'B1', name: 'Atacante', category: 'surface',
        composition: [], stayingPower: 10, movement: 0,
        detectionRange: { surface: 2, air: 2, submarine: 1, land: 1 },
        attackRange: { surface: 6, air: 1, submarine: 1, land: 1 },
        weapons: { ascm: { quantity: 4, range: 6 } },
        capabilities: {},
        position: { col: 0, row: 0 },
      }],
      red: [{
        id: 'R1', name: 'Defensor', category: 'surface',
        composition: [], stayingPower: 100, movement: 0,
        detectionRange: { surface: 2, air: 2, submarine: 1, land: 1 },
        attackRange: { surface: 2, air: 1, submarine: 1, land: 1 },
        weapons: { airDefense: { quantity: 6, range: 1 } },
        capabilities: {},
        position: { col: 1, row: 0 },
      }],
    },
  };
}

function engage(options) {
  const state = newGame(makeCustomOB(), options);
  const engagement = { id: 'ENG-01', attackerId: 'B1', targetId: 'R1', weaponType: 'ascm', amount: 4, status: 'pending', result: null };
  resolveQueuedEngagement(state, engagement);
  return { state, result: engagement.result };
}

test('newGame without seed: state.rng is null and combat resolution stays deterministic', () => {
  const { state, result } = engage({});

  assert.equal(state.rng, null);
  assert.equal(result.stochastic, null);
  assert.ok(Math.abs(result.actualLoss - result.expectedLoss) < 1e-12);
});

test('newGame with seed: same seed reproduces the same engagement outcome', () => {
  const a = engage({ seed: 777 });
  const b = engage({ seed: 777 });

  assert.notEqual(a.state.rng, null);
  assert.ok(a.result.stochastic !== null);
  assert.equal(a.result.actualLoss, b.result.actualLoss);
  assert.deepStrictEqual(a.result.stochastic, b.result.stochastic);
});

test('newGame with seed: different seeds can produce varying engagement outcomes', () => {
  const losses = Array.from({ length: 20 }, (_, i) => engage({ seed: 2000 + i }).result.actualLoss);
  const distinct = new Set(losses);

  assert.ok(distinct.size > 1, 'expected actualLoss to vary across seeds');
});
