'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GRID_W, hexDist, getTerrain, canEnterTerrain } = require('../hexgrid');
const { planCOA, findApproachHex, obFromState } = require('../bot/coa_planner');

// ─── findApproachHex ─────────────────────────────────────────

test('findApproachHex: target already within range returns the unit\'s own hex', () => {
  const unit = { col: 0, row: 5, category: 'surface' };
  const target = { col: 1, row: 5 };
  const approach = findApproachHex(unit, target, 2);
  assert.deepEqual(approach, { col: 0, row: 5 });
});

test('findApproachHex: out-of-range target scans the grid for a passable hex within range', () => {
  const unit = { col: 12, row: 5, category: 'submarine' };
  const target = { col: 0, row: 5 }; // land, but shelf/deep water is within range 2
  const approach = findApproachHex(unit, target, 2);
  assert.ok(approach, 'expected a candidate hex to be found');
  assert.ok(hexDist(approach.col, approach.row, target.col, target.row) <= 2);
  assert.ok(canEnterTerrain('submarine', getTerrain(approach.col, approach.row)));
});

test('findApproachHex: returns null when no passable hex exists within range', () => {
  const unit = { col: 10, row: 5, category: 'submarine' };
  const target = { col: 0, row: 0 }; // land, and the only hex within range 0
  const approach = findApproachHex(unit, target, 0);
  assert.equal(approach, null);
});

// ─── obFromState ────────────────────────────────────────────────

test('obFromState partitions units by team', () => {
  const state = {
    units: [
      { id: 'B1', team: 'blue' },
      { id: 'R1', team: 'red' },
      { id: 'N1', team: 'neutral' },
    ],
  };
  const ob = obFromState(state);
  assert.deepEqual(ob.forces.blue.map(u => u.id), ['B1']);
  assert.deepEqual(ob.forces.red.map(u => u.id), ['R1']);
  assert.deepEqual(ob.forces.neutral.map(u => u.id), ['N1']);
});

// ─── planCOA: detected enemy -> TRANSIT/ENGAGE chain ─────────────

test('planCOA: a single detected enemy produces a TRANSIT->ENGAGE chain assigned to the available unit', () => {
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

  const { tasks, assignments, cpm } = planCOA(state, 'blue');

  assert.equal(assignments.length, 1);
  const a = assignments[0];
  assert.equal(a.unitId, 'BLUE-1');
  assert.equal(a.targetUnitId, 'RED-1');
  assert.equal(a.taskId, 'TRANSIT_RED-1');

  const approach = a.objectiveHex;
  assert.ok(approach, 'expected an approach hex');
  assert.ok(hexDist(enemy.col, enemy.row, approach.col, approach.row) <= 3);
  assert.ok(canEnterTerrain('surface', getTerrain(approach.col, approach.row)));

  const dist = hexDist(mine.col, mine.row, approach.col, approach.row);
  const expectedTransit = dist === 0 ? 0 : Math.ceil(dist / mine.movement);
  assert.equal(a.transitTurns, expectedTransit);

  const transitDuration = Math.max(1, expectedTransit);
  assert.deepEqual(tasks.find(t => t.id === 'TRANSIT_RED-1'), { id: 'TRANSIT_RED-1', duration: transitDuration, dependsOn: [] });
  assert.deepEqual(tasks.find(t => t.id === 'ENGAGE_RED-1'), { id: 'ENGAGE_RED-1', duration: 1, dependsOn: ['TRANSIT_RED-1'] });

  assert.equal(cpm.projectDuration, transitDuration + 1);
  assert.deepEqual(cpm.criticalPath, ['TRANSIT_RED-1', 'ENGAGE_RED-1']);
});

// ─── planCOA: multiple targets, units assigned at most once ─────────

test('planCOA: assigns the best-OE unit per target and never double-assigns a unit', () => {
  const sagShip = {
    id: 'BLUE-SAG', team: 'blue', category: 'surface', col: 0, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 3, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 4, air: 0, submarine: 0, land: 0 },
    weapons: { mss: { quantity: 20, range: 3 }, ascm: { quantity: 8, range: 6 } },
    capabilities: { navalGun: 4 },
  };
  const aswShip = {
    id: 'BLUE-ASW', team: 'blue', category: 'surface', col: 1, row: 6, hp: 8, maxHp: 8,
    movement: 4,
    attackRange: { surface: 2, air: 0, submarine: 2, land: 0 },
    detectionRange: { surface: 2, air: 0, submarine: 2, land: 0 },
    weapons: { torpedo: { quantity: 6, range: 2 } },
    capabilities: { asw: 4 },
  };
  const enemySurface = {
    id: 'RED-SURF', team: 'red', category: 'surface', col: 10, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    weapons: {}, capabilities: {}, detected: true,
  };
  const enemySub = {
    id: 'RED-SUB', team: 'red', category: 'submarine', col: 10, row: 6, hp: 4, maxHp: 4,
    movement: 2,
    attackRange: { surface: 1, air: 0, submarine: 1, land: 0 },
    detectionRange: { surface: 1, air: 0, submarine: 1, land: 0 },
    weapons: {}, capabilities: {}, detected: true,
  };
  const state = { units: [sagShip, aswShip, enemySurface, enemySub] };

  const { assignments } = planCOA(state, 'blue');

  assert.equal(assignments.length, 2);
  const byTarget = Object.fromEntries(assignments.map(a => [a.targetUnitId, a]));
  assert.equal(byTarget['RED-SURF'].unitId, 'BLUE-SAG');
  assert.equal(byTarget['RED-SUB'].unitId, 'BLUE-ASW');

  const unitIds = assignments.map(a => a.unitId);
  assert.equal(new Set(unitIds).size, unitIds.length);
});

// ─── planCOA: no detected enemies -> advance-to-contact ────────────

test('planCOA: with no detected enemies, armed and mobile units get RECON tasks toward the map center', () => {
  const center = GRID_W >> 1;
  const advancer = {
    id: 'BLUE-ADV', team: 'blue', category: 'surface', col: 0, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    weapons: {}, capabilities: {},
  };
  const alreadyCentered = {
    id: 'BLUE-CTR', team: 'blue', category: 'surface', col: center, row: 4, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    weapons: {}, capabilities: {},
  };
  const immobile = {
    id: 'BLUE-IMMOBILE', team: 'blue', category: 'surface', col: 1, row: 5, hp: 10, maxHp: 10,
    movement: 0,
    attackRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    weapons: {}, capabilities: {},
  };
  const unarmed = {
    id: 'BLUE-LOG', team: 'blue', category: 'surface', col: 2, row: 5, hp: 3, maxHp: 3,
    movement: 2,
    attackRange: { surface: 0, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 1, air: 0, submarine: 0, land: 0 },
    weapons: {}, capabilities: {},
  };
  const state = { units: [advancer, alreadyCentered, immobile, unarmed] };

  const { tasks, assignments } = planCOA(state, 'blue');

  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].unitId, 'BLUE-ADV');
  assert.equal(assignments[0].taskId, 'RECON_BLUE-ADV');
  assert.deepEqual(assignments[0].objectiveHex, { col: center, row: advancer.row });
  assert.deepEqual(tasks, [{ id: 'RECON_BLUE-ADV', duration: 1, dependsOn: [] }]);
});

// ─── planCOA: enemy nobody can engage is simply skipped ────────────

test('planCOA: a detected enemy that no unit can engage produces no tasks or assignments', () => {
  const unarmed = {
    id: 'BLUE-LOG', team: 'blue', category: 'surface', col: 2, row: 5, hp: 3, maxHp: 3,
    movement: 2,
    attackRange: { surface: 0, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 1, air: 0, submarine: 0, land: 0 },
    weapons: {}, capabilities: {},
  };
  const enemy = {
    id: 'RED-1', team: 'red', category: 'surface', col: 10, row: 5, hp: 10, maxHp: 10,
    movement: 4,
    attackRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    detectionRange: { surface: 2, air: 0, submarine: 0, land: 0 },
    weapons: {}, capabilities: {}, detected: true,
  };
  const state = { units: [unarmed, enemy] };

  const { tasks, assignments, cpm } = planCOA(state, 'blue');

  assert.deepEqual(tasks, []);
  assert.deepEqual(assignments, []);
  assert.equal(cpm.projectDuration, 0);
  assert.deepEqual(cpm.criticalPath, []);
});
