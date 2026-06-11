'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reachableHexes, findPath, planMoveTowards } = require('../bot/pathfinding');
const { hexDist } = require('../hexgrid');

function surfaceUnit(col, row, movement) {
  return { id: 'U1', category: 'surface', col, row, movement };
}

test('reachableHexes includes start at distance 0 and respects step budget', () => {
  const unit = surfaceUnit(8, 5, 2);
  const reached = reachableHexes({ col: 8, row: 5 }, unit, { maxSteps: 2 });
  assert.equal(reached.get('8,5').dist, 0);
  // Every reached hex must be within hex distance <= maxSteps of the start
  for (const { col, row, dist } of reached.values()) {
    assert.ok(dist <= 2);
    assert.ok(hexDist(8, 5, col, row) <= 2);
  }
  // Should reach more than just the start hex on open ocean
  assert.ok(reached.size > 1);
});

test('reachableHexes blocks land for surface units', () => {
  const unit = surfaceUnit(8, 0, 5); // open ocean (col 8 is T_DEEP across most rows)
  const reached = reachableHexes({ col: 8, row: 0 }, unit, { maxSteps: 5 });
  // col 0-3 row 0 are land (T_LAND=0); none should be reachable
  for (const { col, row } of reached.values()) {
    assert.ok(!(col <= 3 && row === 0), `surface unit should not reach land hex ${col},${row}`);
  }
});

test('findPath returns adjacent-step path between two ocean hexes', () => {
  const unit = surfaceUnit(8, 5, 4);
  const path = findPath({ col: 8, row: 5 }, { col: 10, row: 5 }, unit);
  assert.ok(path, 'path should be found');
  assert.equal(path[0].col, 8);
  assert.equal(path[0].row, 5);
  assert.equal(path[path.length - 1].col, 10);
  assert.equal(path[path.length - 1].row, 5);
  for (let i = 1; i < path.length; i++) {
    assert.equal(hexDist(path[i - 1].col, path[i - 1].row, path[i].col, path[i].row), 1);
  }
});

test('findPath returns null when goal is unreachable for the unit category', () => {
  // Submarine cannot enter land/shallow; (0,0) is T_LAND, deep ocean sub can't reach it
  const sub = { id: 'S1', category: 'submarine', col: 8, row: 0, movement: 10 };
  const path = findPath({ col: 8, row: 0 }, { col: 0, row: 0 }, sub);
  assert.equal(path, null);
});

test('planMoveTowards truncates path to unit.movement and reports reachedGoal', () => {
  const unit = surfaceUnit(8, 5, 2);
  const goal = { col: 12, row: 5 }; // distance 4, movement 2
  const { path, reachedGoal } = planMoveTowards(unit, goal);
  assert.equal(path.length, 3); // start + 2 steps
  assert.equal(reachedGoal, false);
  assert.equal(path[0].col, 8);
  assert.equal(path[0].row, 5);
});

test('planMoveTowards returns reachedGoal=true when goal within movement', () => {
  const unit = surfaceUnit(8, 5, 4);
  const goal = { col: 10, row: 5 }; // distance 2
  const { path, reachedGoal } = planMoveTowards(unit, goal);
  assert.equal(reachedGoal, true);
  assert.equal(path[path.length - 1].col, 10);
  assert.equal(path[path.length - 1].row, 5);
});

test('planMoveTowards on unit already at goal returns single-hex path', () => {
  const unit = surfaceUnit(8, 5, 4);
  const { path, reachedGoal } = planMoveTowards(unit, { col: 8, row: 5 });
  assert.equal(path.length, 1);
  assert.equal(reachedGoal, true);
});
