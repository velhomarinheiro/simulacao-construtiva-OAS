'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveEngagement } = require('../combat_engine');
const { SALVO_KERNELS } = require('../combat_config');

function makeUnit({ id, category, team = 'blue', hp = 10, weapons = {} } = {}) {
  return { id, category, team, hp, weapons };
}

test('ascm vs surface, no interceptors: loss capped at defender strength', () => {
  const attacker = makeUnit({ id: 'B1', category: 'surface', weapons: { ascm: { quantity: 4 } } });
  const defender = makeUnit({ id: 'R1', category: 'surface', hp: 3 });

  const out = resolveEngagement({ attacker, defender, weaponType: 'ascm', amount: 4, distance: 5 });

  assert.equal(out.ok, true);
  assert.equal(out.launched, 4);
  assert.ok(Math.abs(out.pOffense - SALVO_KERNELS.ascmSurface.surface) < 1e-12);
  assert.equal(out.pDefense, 0);
  // raw kernel = 1.75 * 4 = 7, but loss capped at pre-strength (3)
  assert.ok(Math.abs(out.rawKernel - 7.0) < 1e-9);
  assert.ok(Math.abs(out.expectedLoss - 3.0) < 1e-9);
  assert.equal(out.remainingHp, 0);
  assert.equal(out.destroyed, true);
  assert.equal(defender.hp, 0);
  assert.equal(attacker.weapons.ascm.quantity, 0);
});

test('ascm vs surface with airDefense: interception reduces net damage', () => {
  const attacker = makeUnit({ id: 'B1', category: 'surface', weapons: { ascm: { quantity: 4 } } });
  const defender = makeUnit({
    id: 'R1', category: 'surface', hp: 10,
    weapons: { airDefense: { quantity: 6 } },
  });

  const out = resolveEngagement({ attacker, defender, weaponType: 'ascm', amount: 4, distance: 5 });

  const pOffense = SALVO_KERNELS.ascmSurface.surface; // 1.75
  const pIntercept = SALVO_KERNELS.airDefense.missile; // 1/3
  const expectedPDefense = pIntercept * 4 * pOffense; // 4/3 * 1.75
  const expectedRaw = pOffense * 4 - expectedPDefense;

  assert.ok(Math.abs(out.pDefense - expectedPDefense) < 1e-9);
  assert.ok(Math.abs(out.rawKernel - expectedRaw) < 1e-9);
  assert.ok(Math.abs(out.expectedLoss - expectedRaw) < 1e-9);
  assert.ok(Math.abs(out.remainingHp - (10 - expectedRaw)) < 1e-9);
  assert.equal(out.destroyed, false);
});

test('defenderDisabled skips interception even with airDefense available', () => {
  const attacker = makeUnit({ id: 'B1', category: 'surface', weapons: { ascm: { quantity: 4 } } });
  const defender = makeUnit({
    id: 'R1', category: 'surface', hp: 10,
    weapons: { airDefense: { quantity: 6 } },
  });

  const out = resolveEngagement({ attacker, defender, weaponType: 'ascm', amount: 4, distance: 5, defenderDisabled: true });

  assert.equal(out.pDefense, 0);
  assert.ok(Math.abs(out.expectedLoss - SALVO_KERNELS.ascmSurface.surface * 4) < 1e-9);
});

test('out of range', () => {
  const attacker = makeUnit({ id: 'B1', category: 'surface', weapons: { ascm: { quantity: 4 } } });
  const defender = makeUnit({ id: 'R1', category: 'surface', hp: 3 });

  const out = resolveEngagement({ attacker, defender, weaponType: 'ascm', amount: 4, distance: 7 });

  assert.equal(out.ok, false);
  assert.match(out.reason, /alcance/);
});

test('weapon cannot target defender category', () => {
  const attacker = makeUnit({ id: 'B1', category: 'surface', weapons: { ascm: { quantity: 4 } } });
  const defender = makeUnit({ id: 'R1', category: 'land', hp: 3 });

  const out = resolveEngagement({ attacker, defender, weaponType: 'ascm', amount: 4, distance: 1 });

  assert.equal(out.ok, false);
  assert.match(out.reason, /não ataca/);
});

test('launched is capped at available ammo', () => {
  const attacker = makeUnit({ id: 'B1', category: 'surface', weapons: { ascm: { quantity: 2 } } });
  const defender = makeUnit({ id: 'R1', category: 'surface', hp: 10 });

  const out = resolveEngagement({ attacker, defender, weaponType: 'ascm', amount: 5, distance: 5 });

  assert.equal(out.launched, 2);
  assert.equal(attacker.weapons.ascm.quantity, 0);
});

test('non-expendable weapon (navalGun) does not consume ammo counter', () => {
  const attacker = makeUnit({ id: 'B1', category: 'surface', weapons: { navalGun: { quantity: 1 } } });
  const defender = makeUnit({ id: 'R1', category: 'surface', hp: 10 });

  resolveEngagement({ attacker, defender, weaponType: 'navalGun', amount: 1, distance: 1 });

  assert.equal(attacker.weapons.navalGun.quantity, 1);
});

test('torpedo vs submarine ignores defender airDefense (not interceptable)', () => {
  const attacker = makeUnit({ id: 'B1', category: 'submarine', weapons: { torpedo: { quantity: 2 } } });
  const defender = makeUnit({
    id: 'R1', category: 'submarine', hp: 10,
    weapons: { airDefense: { quantity: 6 } },
  });

  const out = resolveEngagement({ attacker, defender, weaponType: 'torpedo', amount: 2, distance: 1 });

  assert.equal(out.pDefense, 0);
  assert.ok(Math.abs(out.expectedLoss - SALVO_KERNELS.torpedo.submarine * 2) < 1e-9);
});

test('lacm interception aggregates airDefense and bmd', () => {
  const attacker = makeUnit({ id: 'B1', category: 'surface', weapons: { lacm: { quantity: 4 } } });
  const defender = makeUnit({
    id: 'R1', category: 'land', hp: 10,
    weapons: { airDefense: { quantity: 4 }, bmd: { quantity: 4 } },
  });

  const out = resolveEngagement({ attacker, defender, weaponType: 'lacm', amount: 4, distance: 8 });

  const pOffense = SALVO_KERNELS.lacm.land;
  const pInterceptAirDefense = SALVO_KERNELS.airDefense.missile;
  const pInterceptBmd = SALVO_KERNELS.bmd.missile;
  const expectedPDefense =
    pInterceptAirDefense * 4 * pOffense + pInterceptBmd * 4 * pOffense;

  assert.ok(Math.abs(out.pDefense - expectedPDefense) < 1e-9);
  assert.equal(out.interception.details.length, 2);
});
