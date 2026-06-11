'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ORDER_OF_BATTLE } = require('../order_of_battle');
const {
  TASK_TYPES,
  computeReferenceScales,
  unitOE,
  bestTaskForUnit,
  targetValue,
  attackScore,
} = require('../bot/capability_eval');

const scales = computeReferenceScales(ORDER_OF_BATTLE);

test('computeReferenceScales returns positive maxima for every dimension', () => {
  for (const v of Object.values(scales.capabilities)) assert.ok(v > 0);
  for (const v of Object.values(scales.weapons)) assert.ok(v > 0);
  for (const v of Object.values(scales.detection)) assert.ok(v > 0);
  for (const v of Object.values(scales.attackRange)) assert.ok(v > 0);
  assert.ok(scales.targetValueMax > 0);
});

test('unitOE is in [0,1] for every unit and task type', () => {
  const units = [...ORDER_OF_BATTLE.forces.blue, ...ORDER_OF_BATTLE.forces.red];
  for (const u of units) {
    for (const taskType of Object.keys(TASK_TYPES)) {
      const oe = unitOE(u, taskType, scales);
      assert.ok(oe >= 0 && oe <= 1, `${u.id} ${taskType} OE=${oe} out of range`);
    }
  }
});

test('a strong ASW unit scores higher OE for ASW than a pure logistics ship', () => {
  const asw = ORDER_OF_BATTLE.forces.blue.find(u => u.id === 'BLUE-SAG-P'); // capabilities.asw=4
  const log = ORDER_OF_BATTLE.forces.blue.find(u => u.id === 'BLUE-LOG-A'); // no capabilities
  assert.ok(unitOE(asw, 'ASW', scales) > unitOE(log, 'ASW', scales));
});

test('bestTaskForUnit returns one of the known task types with a valid OE', () => {
  const unit = ORDER_OF_BATTLE.forces.blue.find(u => u.id === 'BLUE-SAG-P');
  const { task, oe } = bestTaskForUnit(unit, scales);
  assert.ok(Object.keys(TASK_TYPES).includes(task));
  assert.ok(oe >= 0 && oe <= 1);
});

test('targetValue: a logistics ship (no weapons/capabilities) is worth less than a combatant', () => {
  const log = ORDER_OF_BATTLE.forces.blue.find(u => u.id === 'BLUE-LOG-A');
  const sag = ORDER_OF_BATTLE.forces.blue.find(u => u.id === 'BLUE-SAG-P');
  assert.ok(targetValue({ ...log, hp: log.stayingPower }, scales) < targetValue({ ...sag, hp: sag.stayingPower }, scales));
});

test('attackScore is 0 when target is out of attack range', () => {
  const attacker = { ...ORDER_OF_BATTLE.forces.blue.find(u => u.id === 'BLUE-PAT-C1'), hp: 2 }; // attackRange.surface=1
  const target = { ...ORDER_OF_BATTLE.forces.red.find(u => u.category === 'surface'), hp: 5, category: 'surface' };
  assert.equal(attackScore(attacker, target, 5, scales), 0);
});

test('attackScore is positive when target is within attack range', () => {
  const attacker = { ...ORDER_OF_BATTLE.forces.blue.find(u => u.id === 'BLUE-SAG-P'), hp: 4 }; // attackRange.surface=3
  const target = { ...ORDER_OF_BATTLE.forces.red.find(u => u.category === 'surface'), hp: 5, category: 'surface' };
  assert.ok(attackScore(attacker, target, 2, scales) > 0);
});

test('attackScore prefers a closer target over a farther one of equal value', () => {
  const attacker = { ...ORDER_OF_BATTLE.forces.blue.find(u => u.id === 'BLUE-SAG-P'), hp: 4 };
  const target = { ...ORDER_OF_BATTLE.forces.red.find(u => u.category === 'surface'), hp: 5, category: 'surface' };
  const near = attackScore(attacker, target, 1, scales);
  const far = attackScore(attacker, target, 3, scales);
  assert.ok(near > far);
});
