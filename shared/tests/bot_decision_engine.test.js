'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hexDist } = require('../hexgrid');
const { decideMovement, decideAttacks } = require('../bot/decision_engine');

// ─── decideMovement ────────────────────────────────────────────

test('decideMovement: moves an assigned unit a step toward its COA objective hex', () => {
  const mine = {
    id: 'BLUE-1', team: 'blue', category: 'surface', col: 0, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 3, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 4, air: 0, submarine: 0, land: 0 },
    weapons: { mss: { quantity: 10, range: 3 } }, capabilities: {},
  };
  const enemy = {
    id: 'RED-1', team: 'red', category: 'surface', col: 10, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    weapons: {}, capabilities: {}, detected: true,
  };
  const state = { units: [mine, enemy] };

  const moves = decideMovement(state, 'blue');

  assert.equal(moves.length, 1);
  assert.equal(moves[0].unitId, 'BLUE-1');
  const { path } = moves[0];
  assert.deepEqual(path[0], { col: 0, row: 5 });
  assert.ok(path.length >= 2 && path.length <= mine.movement + 1);
  for (let i = 1; i < path.length; i++) {
    assert.equal(hexDist(path[i - 1].col, path[i - 1].row, path[i].col, path[i].row), 1);
  }
});

test('decideMovement: a unit already within attack range of its target stays put', () => {
  const mine = {
    id: 'BLUE-1', team: 'blue', category: 'surface', col: 8, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 3, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 4, air: 0, submarine: 0, land: 0 },
    weapons: { mss: { quantity: 10, range: 3 } }, capabilities: {},
  };
  const enemy = {
    id: 'RED-1', team: 'red', category: 'surface', col: 10, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    weapons: {}, capabilities: {}, detected: true,
  };
  const state = { units: [mine, enemy] };

  assert.deepEqual(decideMovement(state, 'blue'), []);
});

test('decideMovement: a fuel-disabled unit is not moved', () => {
  const mine = {
    id: 'BLUE-1', team: 'blue', category: 'surface', col: 0, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 3, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 4, air: 0, submarine: 0, land: 0 },
    weapons: { mss: { quantity: 10, range: 3 } }, capabilities: {},
    fuel: { fuelType: 'naval', current: 0 },
  };
  const enemy = {
    id: 'RED-1', team: 'red', category: 'surface', col: 10, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    weapons: {}, capabilities: {}, detected: true,
  };
  const state = { units: [mine, enemy] };

  assert.deepEqual(decideMovement(state, 'blue'), []);
});

test('decideMovement: with no detected enemies, advances toward the map center', () => {
  const mine = {
    id: 'BLUE-ADV', team: 'blue', category: 'surface', col: 0, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    weapons: {}, capabilities: {},
  };
  const state = { units: [mine] };

  const moves = decideMovement(state, 'blue');

  assert.equal(moves.length, 1);
  assert.equal(moves[0].unitId, 'BLUE-ADV');
  const { path } = moves[0];
  assert.deepEqual(path[0], { col: 0, row: 5 });
  assert.ok(path.length >= 2 && path.length <= mine.movement + 1);
  // Each step should move strictly closer to the center column (col 8).
  const last = path[path.length - 1];
  assert.ok(Math.abs(last.col - 8) < Math.abs(path[0].col - 8));
});

// ─── decideAttacks ───────────────────────────────────────────────

test('decideAttacks: attacks a detected enemy within weapon range', () => {
  const mine = {
    id: 'BLUE-1', team: 'blue', category: 'surface', col: 8, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 3, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 4, air: 0, submarine: 0, land: 0 },
    weapons: { mss: { quantity: 10, range: 3 } }, capabilities: {},
  };
  const enemy = {
    id: 'RED-1', team: 'red', category: 'surface', col: 10, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    weapons: {}, capabilities: {}, detected: true,
  };
  const state = { units: [mine, enemy] };

  assert.deepEqual(decideAttacks(state, 'blue'), [{ attackerId: 'BLUE-1', targetId: 'RED-1' }]);
});

test('decideAttacks: a detected enemy out of weapon range is not attacked', () => {
  const mine = {
    id: 'BLUE-1', team: 'blue', category: 'surface', col: 0, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 1, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 4, air: 0, submarine: 0, land: 0 },
    weapons: { mss: { quantity: 10, range: 1 } }, capabilities: {},
  };
  const enemy = {
    id: 'RED-1', team: 'red', category: 'surface', col: 10, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    weapons: {}, capabilities: {}, detected: true,
  };
  const state = { units: [mine, enemy] };

  assert.deepEqual(decideAttacks(state, 'blue'), []);
});

test('decideAttacks: a fuel-disabled unit does not attack', () => {
  const mine = {
    id: 'BLUE-1', team: 'blue', category: 'surface', col: 8, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 3, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 4, air: 0, submarine: 0, land: 0 },
    weapons: { mss: { quantity: 10, range: 3 } }, capabilities: {},
    fuel: { fuelType: 'naval', current: 0 },
  };
  const enemy = {
    id: 'RED-1', team: 'red', category: 'surface', col: 10, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    weapons: {}, capabilities: {}, detected: true,
  };
  const state = { units: [mine, enemy] };

  assert.deepEqual(decideAttacks(state, 'blue'), []);
});

test('decideAttacks: prefers the higher-value target when several enemies are in range', () => {
  const mine = {
    id: 'BLUE-1', team: 'blue', category: 'surface', col: 8, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 3, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 4, air: 0, submarine: 0, land: 0 },
    weapons: { mss: { quantity: 10, range: 3 } }, capabilities: { navalGun: 4 },
  };
  const weakEnemy = {
    id: 'RED-WEAK', team: 'red', category: 'surface', col: 10, row: 5, hp: 2, maxHp: 2,
    movement: 4,
    attackRange: { surface: 1, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 1, air: 0, submarine: 0, land: 0 },
    weapons: {}, capabilities: {}, detected: true,
  };
  const strongEnemy = {
    id: 'RED-STRONG', team: 'red', category: 'surface', col: 10, row: 6, hp: 12, maxHp: 12,
    movement: 4,
    attackRange: { surface: 6, air: 1, submarine: 2, land: 8 },
    detectionRange: { surface: 3, air: 2, submarine: 2, land: 1 },
    weapons: { ascm: { quantity: 14, range: 6 }, mss: { quantity: 18, range: 3 }, lacm: { quantity: 8, range: 10 } },
    capabilities: { navalGun: 6, airDefense: 13, bmd: 4, asw: 11 }, detected: true,
  };
  const state = { units: [mine, weakEnemy, strongEnemy] };

  // Sanity check the fixture: both enemies must be within mine's attack range.
  assert.ok(hexDist(mine.col, mine.row, weakEnemy.col, weakEnemy.row) <= mine.attackRange.surface);
  assert.ok(hexDist(mine.col, mine.row, strongEnemy.col, strongEnemy.row) <= mine.attackRange.surface);

  assert.deepEqual(decideAttacks(state, 'blue'), [{ attackerId: 'BLUE-1', targetId: 'RED-STRONG' }]);
});
