'use strict';

/**
 * combat_config.js
 * ================
 *
 * Configuration for per-engagement combat resolution.
 *
 * prof-wargame-naval resolved each declared attack with d6 damage rolls
 * (see D6_DAMAGE_TABLES below, kept here only as the documented source of
 * the calibration). This platform instead resolves every engagement with
 * one pulsed step of the naval_salvo multi-domain salvo equation
 * (shared/salvo_engine). SALVO_KERNELS converts each old (damageProfile,
 * targetCategory) d6 table into the *expected value* of damage per shot
 * fired, used as pOffense in shared/combat_engine.js. For 'missile'
 * categories (interception tables), the same expected value is the
 * per-attempt interception probability, used to derive pDefense.
 *
 * weaponProfiles is otherwise unchanged from prof-wargame-naval: it still
 * drives weapon selection, range checking and target-category validation
 * in server.js, and interceptableBy still determines which of the
 * defender's weapons can intercept an incoming salvo.
 */

/** Maps a unit's combat category to a salvo_engine domain. */
const CATEGORY_TO_DOMAIN = {
  surface: 'S',
  submarine: 'U',
  air: 'A',
  land: 'C',
};

const D6_FACES = [1, 2, 3, 4, 5, 6];
const D6_REROLL_AVERAGE = 3.5; // E['1d6']

/** Expected value of a {face: damage|'1d6'} table, '1d6' -> E[reroll] = 3.5. */
function expectedValue(table) {
  let sum = 0;
  for (const face of D6_FACES) {
    const v = table[String(face)];
    sum += v === '1d6' ? D6_REROLL_AVERAGE : Number(v) || 0;
  }
  return sum / D6_FACES.length;
}

// Original d6 damage tables from prof-wargame-naval/shared/combat_config.js
// (blue and red tables were identical). Kept as the documented source of
// SALVO_KERNELS below.
const D6_DAMAGE_TABLES = {
  ascmSurface: {
    surface: { 1: 0, 2: 0, 3: 0, 4: '1d6', 5: '1d6', 6: '1d6' },
  },
  mssSurface: {
    surface: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 1, 6: '1d6' },
  },
  torpedo: {
    surface: { 1: 0, 2: 0, 3: 0, 4: 1, 5: '1d6', 6: '1d6' },
    submarine: { 1: 0, 2: 0, 3: 0, 4: 1, 5: '1d6', 6: '1d6' },
  },
  lacm: {
    land: { 1: 0, 2: 0, 3: 1, 4: 1, 5: '1d6', 6: '1d6' },
  },
  asbmSurface: {
    surface: { 1: 0, 2: 0, 3: 0, 4: '1d6', 5: '1d6', 6: '1d6' },
  },
  navalGun: {
    surface: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 1, 6: 1 },
    land: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1 },
  },
  airDefense: {
    air: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1, 6: 1 },
    missile: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1, 6: 1 },
  },
  bmd: {
    air: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1, 6: 1 },
    missile: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1, 6: 1 },
  },
  asw: {
    submarine: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1, 6: '1d6' },
  },
  airAttack: {
    surface: { 1: 0, 2: 0, 3: 0, 4: 1, 5: '1d6', 6: '1d6' },
    air: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: '1d6' },
    land: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: '1d6' },
  },
};

/**
 * Per (damageProfile, targetCategory) calibration value, used as pOffense
 * in shared/combat_engine.js (expected damage per shot fired). For
 * targetCategory === 'missile' it is instead the per-attempt interception
 * probability of that interceptor weapon.
 */
const SALVO_KERNELS = Object.fromEntries(
  Object.entries(D6_DAMAGE_TABLES).map(([profile, byCategory]) => [
    profile,
    Object.fromEntries(
      Object.entries(byCategory).map(([category, table]) => [category, expectedValue(table)])
    ),
  ])
);

const weaponProfiles = {
  ascm: {
    expendable: true,
    defaultRange: 6,
    targets: ['surface'],
    interceptableBy: ['airDefense'],
    damageProfile: 'ascmSurface',
    label: 'ASCM',
  },
  mss: {
    expendable: true,
    defaultRange: 3,
    targets: ['surface'],
    interceptableBy: ['airDefense'],
    damageProfile: 'mssSurface',
    label: 'MSS',
  },
  torpedo: {
    expendable: true,
    defaultRange: 2,
    targets: ['surface', 'submarine'],
    interceptableBy: [],
    damageProfile: 'torpedo',
    label: 'TORPEDO',
  },
  lacm: {
    expendable: true,
    defaultRange: 10,
    targets: ['land'],
    interceptableBy: ['airDefense', 'bmd'],
    damageProfile: 'lacm',
    label: 'LACM',
  },
  asbm: {
    expendable: true,
    defaultRange: 10,
    targets: ['surface'],
    interceptableBy: ['bmd'],
    damageProfile: 'asbmSurface',
    label: 'ASBM',
  },
  navalGun: {
    expendable: false,
    defaultRange: 1,
    targets: ['surface', 'land'],
    interceptableBy: [],
    damageProfile: 'navalGun',
    label: 'CANHÃO',
  },
  airDefense: {
    expendable: false,
    defaultRange: 1,
    targets: ['air'],
    interceptableBy: [],
    damageProfile: 'airDefense',
    label: 'DEFA',
  },
  bmd: {
    expendable: false,
    defaultRange: 1,
    targets: ['air'],
    interceptableBy: [],
    damageProfile: 'bmd',
    label: 'BMD',
  },
  asw: {
    expendable: false,
    defaultRange: 2,
    targets: ['submarine'],
    interceptableBy: [],
    damageProfile: 'asw',
    label: 'ASW',
  },
  airAttack: {
    expendable: false,
    defaultRange: 4,
    targets: ['surface', 'air', 'land'],
    interceptableBy: ['airDefense'],
    damageProfile: 'airAttack',
    label: 'AT.AÉR',
  },
};

const COMBAT_CONFIG = {
  weaponProfiles,
  salvoKernels: SALVO_KERNELS,
  categoryToDomain: CATEGORY_TO_DOMAIN,
};

// Capabilities that only *intercept* incoming fire (they cannot inflict
// attrition on an enemy). A unit holding nothing but these has no offensive
// means. `asw` (anti-submarine), `airAttack` and `navalGun` are offensive and
// are NOT listed here.
const DEFENSIVE_CAPABILITIES = new Set(['airDefense', 'bmd']);

/**
 * True if `unit` still retains any *offensive* means: at least one weapon with
 * stock remaining, or an offensive capability (anything but a pure
 * interceptor). Used as the single source of truth for the decisive-victory /
 * combat-ineffective test (game_engine.js#checkWinner,
 * metrics.js#redForceCombatIneffective).
 *
 * Note: `attackRange` is deliberately NOT consulted — it is a static range
 * table that is > 0 for almost every unit regardless of remaining armament, so
 * including it made "combat-ineffective" trigger only when literally every unit
 * was sunk. Offensive means = the ability to actually deal damage.
 */
function hasOffensiveMeans(unit) {
  const weaponStock = Object.values(unit.weapons || {}).some(w => (w?.quantity || 0) > 0);
  const offensiveCapability = Object.entries(unit.capabilities || {})
    .some(([cap, v]) => (v || 0) > 0 && !DEFENSIVE_CAPABILITIES.has(cap));
  return weaponStock || offensiveCapability;
}

/**
 * Expected offensive output represented by one unit of `weaponType` in stock
 * (or one point of an offensive capability of the same name), i.e. the max
 * expected damage per shot across the weapon's valid target categories
 * (`SALVO_KERNELS`). Used to weight the "offensive stock" that drives the Red
 * culmination metric (metrics.js#offensiveStock), so a magazine of long-range
 * ASCM counts for its combat potential rather than as one raw round each.
 */
function weaponOffensiveWeight(weaponType) {
  const profile = weaponProfiles[weaponType];
  if (!profile) return 0;
  if (DEFENSIVE_CAPABILITIES.has(weaponType)) return 0;
  const kernels = SALVO_KERNELS[profile.damageProfile] || {};
  const vals = (profile.targets || []).map(cat => kernels[cat] || 0);
  return vals.length ? Math.max(...vals) : 0;
}

module.exports = {
  CATEGORY_TO_DOMAIN,
  D6_DAMAGE_TABLES,
  SALVO_KERNELS,
  expectedValue,
  weaponProfiles,
  COMBAT_CONFIG,
  DEFENSIVE_CAPABILITIES,
  hasOffensiveMeans,
  weaponOffensiveWeight,
};
