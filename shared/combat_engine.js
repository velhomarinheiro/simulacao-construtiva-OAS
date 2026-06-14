'use strict';

/**
 * combat_engine.js
 * ================
 *
 * Resolves a single declared engagement (attacker unit fires `amount`
 * shots of `weaponType` at defender unit) using one pulsed step of the
 * naval_salvo multi-domain salvo equation (shared/salvo_engine), in place
 * of prof-wargame-naval's d6 damage rolls + interception rolls.
 *
 * Each engagement is modelled as a 1-vs-1 raw kernel:
 *
 *   rawKernel = max(0, chi * pOffense * launched - chi * pDefense)
 *
 * computed via salvo_engine's aggregateIncomingKernel, where `launched`
 * (B_j) is the number of shots fired, pOffense is the expected damage per
 * shot (SALVO_KERNELS), and pDefense aggregates the expected damage
 * prevented by all of the defender's eligible interceptors. The defender's
 * own strength is held at 1 inside the kernel computation (so pDefense is
 * not rescaled by the target's stock); the resulting rawKernel is then
 * applied as a loss against the defender's actual `unit.strength`, capped
 * so it cannot go negative.
 *
 * `expectedLoss` (= clamped rawKernel) is always reported and is what gets
 * applied to `defender.hp` when no `rng` is given (the historical,
 * deterministic behaviour relied on by the 60-test suite and by
 * server.js's interactive multiplayer mode).
 *
 * When a seeded `rng` (shared/rng.js#mulberry32) is supplied, an additional
 * *stochastic* outcome is sampled per shot — "vazadores" (leakers: shots
 * not intercepted, drawn from the same D6_DAMAGE_TABLES interception rows
 * used to calibrate pDefense) and "acertos" (hits: damage rolled from the
 * attacker's D6_DAMAGE_TABLES row for the defender's category). The sum of
 * these per-shot rolls (`actualLoss`) is what gets applied to
 * `defender.hp` instead of `expectedLoss`. By construction
 * E[actualLoss] == expectedLoss, so this only adds variance between
 * replicas of the same condition without shifting the calibrated mean.
 */

const { COMBAT_CONFIG, D6_DAMAGE_TABLES } = require('./combat_config');
const { randInt } = require('./rng');
const {
  UnitType,
  Force,
  PairParameters,
  Admissibility,
  aggregateIncomingKernel,
} = require('./salvo_engine');

const DESTROYED_THRESHOLD = 1e-9;

// All cross-domain pairs admissible: weapon target/range validation already
// gates which (attacker, defender) categories may engage at all.
const PERMISSIVE_ADMISSIBILITY = Admissibility.fromArray(
  Array.from({ length: 5 }, () => Array(5).fill(1.0))
);

function getWeaponQuantity(unit, weaponType) {
  if (unit.weapons?.[weaponType] != null) return unit.weapons[weaponType].quantity;
  if (unit.capabilities?.[weaponType] != null) return unit.capabilities[weaponType];
  return 0;
}

function getWeaponRange(unit, weaponType) {
  if (unit.weapons?.[weaponType]?.range != null) return unit.weapons[weaponType].range;
  const profile = COMBAT_CONFIG.weaponProfiles?.[weaponType];
  if (!profile) return 0;
  return profile.defaultRange ?? 0;
}

function spendWeapon(unit, weaponType, amount) {
  const profile = COMBAT_CONFIG.weaponProfiles?.[weaponType];
  if (!profile?.expendable) return;
  if (unit.weapons?.[weaponType]) {
    unit.weapons[weaponType].quantity = Math.max(0, unit.weapons[weaponType].quantity - amount);
  }
}

/** Expected damage per shot (or, for targetCategory 'missile', interception probability). */
function expectedShotValue(damageProfile, targetCategory) {
  return COMBAT_CONFIG.salvoKernels?.[damageProfile]?.[targetCategory] ?? 0;
}

/**
 * Samples one D6_DAMAGE_TABLES row using `rng`: rolls 1-6, looks up the
 * table entry for that face, and resolves a '1d6' entry to a further
 * uniform 1-6 roll. Returns the resulting damage/intercept value (always
 * a non-negative integer).
 */
function rollDamageTable(table, rng) {
  const roll = randInt(rng, 1, 6);
  const value = table[String(roll)];
  return value === '1d6' ? randInt(rng, 1, 6) : (Number(value) || 0);
}

/**
 * Aggregate expected damage prevented by all of the defender's weapons
 * eligible to intercept `incomingProfile`.
 *
 * @returns {{pDefenseTotal: number, details: object[]}}
 */
function resolveInterceptionExpectation({ defender, incomingProfile, launched, pOffense, defenderDisabled }) {
  const details = [];
  if (defenderDisabled || launched <= 0 || !incomingProfile.interceptableBy?.length) {
    return { pDefenseTotal: 0, details };
  }

  let pDefenseTotal = 0;
  for (const defWeapon of incomingProfile.interceptableBy) {
    const defQty = getWeaponQuantity(defender, defWeapon);
    if (defQty <= 0) continue;

    const defProfile = COMBAT_CONFIG.weaponProfiles?.[defWeapon];
    if (!defProfile) continue;

    const pIntercept = expectedShotValue(defProfile.damageProfile, 'missile');
    const shots = Math.min(launched, defQty);
    const expectedIntercepted = pIntercept * shots;
    pDefenseTotal += expectedIntercepted * pOffense;
    details.push({ weapon: defWeapon, shots, pIntercept, expectedIntercepted });
  }
  return { pDefenseTotal, details };
}

/**
 * Resolve one declared engagement.
 *
 * @param {object} attacker  unit firing; needs id, category, weapons/capabilities
 * @param {object} defender  unit targeted; needs id, category, strength (current stock)
 * @param {string} weaponType
 * @param {number} amount  shots requested
 * @param {number} distance  hex distance attacker -> defender
 * @param {boolean} [defenderDisabled]  true skips interception (eg. 0 naval FP)
 * @param {() => number} [rng]  seeded PRNG (shared/rng.js#mulberry32); when
 *   given, `actualLoss` is sampled per-shot instead of equal to
 *   `expectedLoss`, and is what gets applied to `defender.hp`.
 * @returns {object} EngagementResult
 */
function resolveEngagement({ attacker, defender, weaponType, amount, distance, defenderDisabled = false, rng = null }) {
  const profile = COMBAT_CONFIG.weaponProfiles?.[weaponType];
  if (!profile) return { ok: false, reason: `Tipo de arma desconhecido: ${weaponType}` };

  if (!profile.targets.includes(defender.category)) {
    return { ok: false, reason: `${weaponType} não ataca ${defender.category}` };
  }

  const range = getWeaponRange(attacker, weaponType);
  if (distance > range) {
    return { ok: false, reason: 'Fora de alcance', distance, range };
  }

  const qty = getWeaponQuantity(attacker, weaponType);
  if (qty <= 0) return { ok: false, reason: 'Sem armamento disponível' };

  const launched = Math.min(amount, qty);
  spendWeapon(attacker, weaponType, launched);

  const pOffense = expectedShotValue(profile.damageProfile, defender.category);
  const { pDefenseTotal, details: interceptionDetails } = resolveInterceptionExpectation({
    defender,
    incomingProfile: profile,
    launched,
    pOffense,
    defenderDisabled,
  });

  const attackerDomain = COMBAT_CONFIG.categoryToDomain[attacker.category] ?? COMBAT_CONFIG.categoryToDomain.surface;
  const defenderDomain = COMBAT_CONFIG.categoryToDomain[defender.category] ?? COMBAT_CONFIG.categoryToDomain.surface;

  const attackerSide = new Force('attacker', [
    new UnitType({ name: 'ATK', domain: attackerDomain, stayingPower: 1, initialStrength: launched }),
  ]);
  const defenderSide = new Force('defender', [
    new UnitType({ name: 'DEF', domain: defenderDomain, stayingPower: 1, initialStrength: 1 }),
  ]);

  const pairParams = new PairParameters({ pOffense, pDefense: pDefenseTotal });
  const [rawKernel] = aggregateIncomingKernel({
    attackerForce: attackerSide,
    defenderForce: defenderSide,
    attackerStrengths: [launched],
    defenderStrengths: [1],
    offensiveKernel: [[pairParams.offensiveKernel()]],
    defensiveKernel: [[pairParams.defensiveKernel()]],
    admissibility: PERMISSIVE_ADMISSIBILITY,
  });

  const preHp = Math.max(0, defender.hp);
  const expectedLoss = Math.min(rawKernel, preHp);

  let actualLoss = expectedLoss;
  let stochastic = null;
  if (rng) {
    let intercepted = 0;
    for (const d of interceptionDetails) {
      const defProfile = COMBAT_CONFIG.weaponProfiles?.[d.weapon];
      const table = D6_DAMAGE_TABLES[defProfile?.damageProfile]?.missile;
      if (table) for (let i = 0; i < d.shots; i++) intercepted += rollDamageTable(table, rng);
    }
    const leakers = Math.max(0, launched - intercepted);
    const dmgTable = D6_DAMAGE_TABLES[profile.damageProfile]?.[defender.category];
    let sampledLoss = 0;
    if (dmgTable) for (let i = 0; i < leakers; i++) sampledLoss += rollDamageTable(dmgTable, rng);
    actualLoss = Math.min(sampledLoss, preHp);
    stochastic = { intercepted, leakers, sampledLoss };
  }

  const remainingHp = preHp - actualLoss;
  defender.hp = remainingHp;
  const destroyed = remainingHp <= DESTROYED_THRESHOLD;

  return {
    ok: true,
    attackerId: attacker.id,
    defenderId: defender.id,
    weaponType,
    weaponLabel: profile.label,
    targetCategory: defender.category,
    distance,
    range,
    launched,
    expendable: profile.expendable,
    pOffense,
    pDefense: pDefenseTotal,
    rawKernel,
    interception: { pDefenseTotal, details: interceptionDetails },
    expectedLoss,
    actualLoss,
    stochastic,
    remainingHp,
    destroyed,
  };
}

module.exports = {
  getWeaponQuantity,
  getWeaponRange,
  spendWeapon,
  expectedShotValue,
  resolveInterceptionExpectation,
  rollDamageTable,
  resolveEngagement,
};
