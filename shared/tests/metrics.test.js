'use strict';

// Tests for the P1 metric refinements:
//   - hasOffensiveMeans / E1_kcv: pure interceptors (airDefense/bmd) no longer
//     keep a side "combat effective"; the always-on attackRange table is ignored.
//   - offensiveStock (E3): weighted by expected damage, defensive caps excluded.
//   - attrition, E2_vp, E2_sloc, culmination tracker.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attrition, redForceCombatIneffective, offensiveStock,
  fpsoValuePreserved, slocSecurityIndex, createCulminationTracker,
  computeFinalMetrics,
} = require('../metrics');
const { hasOffensiveMeans, SALVO_KERNELS } = require('../combat_config');
const { FPSO_UNIT_IDS, PORT_UNIT_IDS } = require('../capability_factors');

function unit(o) {
  return { hp: 10, maxHp: 10, team: 'red', weapons: {}, capabilities: {}, attackRange: { surface: 6 }, ...o };
}

test('hasOffensiveMeans: weapon stock or offensive capability counts; interceptors do not', () => {
  assert.equal(hasOffensiveMeans(unit({ weapons: { ascm: { quantity: 2 } } })), true);
  assert.equal(hasOffensiveMeans(unit({ weapons: { ascm: { quantity: 0 } } })), false, 'spent magazine = no offense');
  assert.equal(hasOffensiveMeans(unit({ capabilities: { navalGun: 2 } })), true, 'navalGun is offensive');
  assert.equal(hasOffensiveMeans(unit({ capabilities: { asw: 1 } })), true, 'asw is offensive');
  // Pure interceptors + a static attackRange must NOT count as offense.
  assert.equal(hasOffensiveMeans(unit({ capabilities: { airDefense: 13, bmd: 4 } })), false);
});

test('E1_kcv: Red is combat-ineffective only when no unit can deal damage', () => {
  const armed = { units: [unit({ id: 'R1', weapons: { ascm: { quantity: 1 } } })] };
  assert.equal(redForceCombatIneffective(armed), 0);

  // A surviving Red unit with only air defense (and an attackRange table) is
  // combat-ineffective under the corrected predicate.
  const onlyDefense = { units: [unit({ id: 'R1', weapons: {}, capabilities: { airDefense: 13 } })] };
  assert.equal(redForceCombatIneffective(onlyDefense), 1);

  const allDead = { units: [unit({ id: 'R1', hp: 0, weapons: { ascm: { quantity: 4 } } })] };
  assert.equal(redForceCombatIneffective(allDead), 1);
});

test('offensiveStock: weighted by expected damage, interceptors excluded', () => {
  const state = { units: [unit({
    id: 'R1', team: 'red',
    weapons: { ascm: { quantity: 4 } },
    capabilities: { navalGun: 2, airDefense: 13 },
  })] };
  // 4 ASCM * pOffense(ascm,surface=1.75) + 2 navalGun * max(pOffense navalGun)
  // + airDefense excluded entirely.
  const navalGunW = Math.max(SALVO_KERNELS.navalGun.surface, SALVO_KERNELS.navalGun.land);
  const expected = 4 * SALVO_KERNELS.ascmSurface.surface + 2 * navalGunW;
  assert.ok(Math.abs(offensiveStock(state, 'red') - expected) < 1e-9, `got ${offensiveStock(state, 'red')} expected ${expected}`);
});

test('attrition sums staying-power lost for a team', () => {
  const state = { units: [
    unit({ team: 'red', hp: 6, maxHp: 10 }),
    unit({ team: 'red', hp: 0, maxHp: 4 }),
    unit({ team: 'blue', hp: 3, maxHp: 10 }),
  ] };
  assert.equal(attrition(state, 'red'), 4 + 4);
  assert.equal(attrition(state, 'blue'), 7);
});

test('E2_vp / E2_sloc read the named FPSO and port units', () => {
  const state = { units: [
    { id: FPSO_UNIT_IDS[0], hp: 6, maxHp: 6, team: 'blue', weapons: {}, capabilities: {} },
    { id: FPSO_UNIT_IDS[1], hp: 3, maxHp: 6, team: 'blue', weapons: {}, capabilities: {} },
    { id: PORT_UNIT_IDS[0], hp: 10, maxHp: 20, team: 'blue', weapons: {}, capabilities: {} },
  ] };
  assert.equal(fpsoValuePreserved(state), 9);
  assert.ok(Math.abs(slocSecurityIndex(state) - 0.5) < 1e-9);
});

test('culmination tracker fires when Red offensive stock drops to <=50% of turn-1', () => {
  const trk = createCulminationTracker();
  const mk = q => ({ turn: 0, units: [unit({ id: 'R1', team: 'red', weapons: { ascm: { quantity: q } } })] });
  const s = mk(10); s.turn = 1; trk.update(s);      // baseline
  const s2 = mk(8); s2.turn = 2; trk.update(s2);     // 80% -> not yet
  assert.equal(trk.turn, null);
  const s3 = mk(4); s3.turn = 3; trk.update(s3);     // 40% -> culminates
  assert.equal(trk.turn, 3);
  const s4 = mk(1); s4.turn = 4; trk.update(s4);     // stays at first crossing
  assert.equal(trk.turn, 3);
});

test('computeFinalMetrics assembles the full row', () => {
  const state = { units: [
    unit({ id: 'R1', team: 'red', hp: 5, maxHp: 10, weapons: { ascm: { quantity: 1 } } }),
    { id: FPSO_UNIT_IDS[0], hp: 6, maxHp: 6, team: 'blue', weapons: {}, capabilities: {} },
  ] };
  const m = computeFinalMetrics(state, 7);
  assert.equal(m.E1_atrito, 5);
  assert.equal(m.E1_kcv, 0);
  assert.equal(m.E2_vp, 6);
  assert.equal(m.E3_culminancia, 7);
});
