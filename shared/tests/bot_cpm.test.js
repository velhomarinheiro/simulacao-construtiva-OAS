'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeCPM } = require('../bot/cpm');

test('linear chain: critical path is the whole chain, zero slack', () => {
  const { schedule, projectDuration, criticalPath } = computeCPM([
    { id: 'A', duration: 2 },
    { id: 'B', duration: 3, dependsOn: ['A'] },
    { id: 'C', duration: 1, dependsOn: ['B'] },
  ]);
  assert.equal(projectDuration, 6);
  assert.deepEqual(schedule.get('A'), { id: 'A', duration: 2, es: 0, ef: 2, ls: 0, lf: 2, slack: 0, critical: true });
  assert.deepEqual(schedule.get('B'), { id: 'B', duration: 3, es: 2, ef: 5, ls: 2, lf: 5, slack: 0, critical: true });
  assert.deepEqual(schedule.get('C'), { id: 'C', duration: 1, es: 5, ef: 6, ls: 5, lf: 6, slack: 0, critical: true });
  assert.deepEqual(criticalPath, ['A', 'B', 'C']);
});

test('classic two-branch network: shorter branch has positive slack', () => {
  // A(3) -> C(2)  and  B(1) -> C(2); both feed C. A->C is the long pole.
  const { schedule, projectDuration, criticalPath } = computeCPM([
    { id: 'A', duration: 3 },
    { id: 'B', duration: 1 },
    { id: 'C', duration: 2, dependsOn: ['A', 'B'] },
  ]);
  assert.equal(projectDuration, 5);
  assert.equal(schedule.get('A').slack, 0);
  assert.equal(schedule.get('B').slack, 2); // B could start up to 2 turns later
  assert.equal(schedule.get('C').slack, 0);
  assert.deepEqual(criticalPath, ['A', 'C']);
});

test('independent tasks (no dependencies) all start at 0 with slack relative to the longest', () => {
  const { schedule, projectDuration } = computeCPM([
    { id: 'SHORT', duration: 1 },
    { id: 'LONG', duration: 4 },
  ]);
  assert.equal(projectDuration, 4);
  assert.equal(schedule.get('SHORT').es, 0);
  assert.equal(schedule.get('SHORT').slack, 3);
  assert.equal(schedule.get('LONG').slack, 0);
});

test('throws on unknown dependency', () => {
  assert.throws(() => computeCPM([{ id: 'A', duration: 1, dependsOn: ['MISSING'] }]), /unknown task/);
});

test('throws on cyclic dependency', () => {
  assert.throws(() => computeCPM([
    { id: 'A', duration: 1, dependsOn: ['B'] },
    { id: 'B', duration: 1, dependsOn: ['A'] },
  ]), /cycle/);
});

test('empty task list', () => {
  const { schedule, projectDuration, criticalPath } = computeCPM([]);
  assert.equal(schedule.size, 0);
  assert.equal(projectDuration, 0);
  assert.deepEqual(criticalPath, []);
});
