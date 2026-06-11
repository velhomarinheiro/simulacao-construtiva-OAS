'use strict';

/**
 * capability_eval.js
 * ===================
 *
 * Operational Effectiveness (OE) coefficients for the digital-player AI,
 * following Jan Mazal's capability-based-planning approach: each unit's
 * *actual* capability profile (weapons, sensor/detection ranges, attack
 * ranges, defensive systems) is scored against the *required* capability
 * profile of a mission task, normalized to [0,1] against the strongest
 * unit in the order of battle for each dimension.
 *
 * These OE scores feed:
 *  - shared/bot/coa_planner.js: assigning units to course-of-action tasks
 *  - shared/bot/decision_engine.js: prioritizing attack targets in combat
 */

const { rangeAgainst } = require('../hexgrid');

/**
 * Mission task types and the capability dimensions a unit needs to
 * contribute to that task. Each task targets a unit category (the kind of
 * threat/objective it addresses).
 */
const TASK_TYPES = {
  SEA_CONTROL: { targetCategory: 'surface', weapons: ['ascm', 'mss'], capabilities: ['navalGun'], detection: 'surface' },
  ASW:         { targetCategory: 'submarine', weapons: ['torpedo'], capabilities: ['asw'], detection: 'submarine' },
  AIR_DEFENSE: { targetCategory: 'air', weapons: [], capabilities: ['airDefense', 'bmd'], detection: 'air' },
  STRIKE_LAND: { targetCategory: 'land', weapons: ['lacm'], capabilities: ['airAttack', 'navalGun'], detection: 'land' },
};

/** Maps a target's category to the task type concerned with engaging it. */
const TASK_FOR_TARGET_CATEGORY = {
  surface: 'SEA_CONTROL',
  submarine: 'ASW',
  air: 'AIR_DEFENSE',
  land: 'STRIKE_LAND',
};

const ALL_CAPABILITIES = ['airDefense', 'asw', 'airAttack', 'navalGun', 'bmd'];
const ALL_WEAPONS = ['mss', 'ascm', 'torpedo', 'lacm'];
const ALL_DETECTION_DOMAINS = ['surface', 'air', 'submarine', 'land'];

function weaponPotential(unit, weaponType) {
  const w = unit.weapons?.[weaponType];
  if (!w || !w.quantity) return 0;
  return w.quantity * (w.range || 1);
}

/**
 * Reference maxima across an order-of-battle (both sides + neutrals),
 * used to normalize OE components to [0,1]. Recomputed whenever a custom
 * OB is loaded so OE stays meaningful relative to the actual scenario.
 *
 * @param {object} ob  {forces: {blue:[], red:[], neutral:[]}}
 */
function computeReferenceScales(ob) {
  const units = [
    ...(ob?.forces?.blue || []),
    ...(ob?.forces?.red || []),
    ...(ob?.forces?.neutral || []),
  ];

  const capabilities = {};
  for (const c of ALL_CAPABILITIES) {
    capabilities[c] = Math.max(1e-9, ...units.map(u => Number(u.capabilities?.[c] || 0)));
  }

  const weapons = {};
  for (const w of ALL_WEAPONS) {
    weapons[w] = Math.max(1e-9, ...units.map(u => weaponPotential(u, w)));
  }

  const detection = {};
  const attackRange = {};
  for (const d of ALL_DETECTION_DOMAINS) {
    detection[d] = Math.max(1e-9, ...units.map(u => Number(u.detectionRange?.[d] || 0)));
    attackRange[d] = Math.max(1e-9, ...units.map(u => Number(u.attackRange?.[d] || 0)));
  }

  const targetValueMax = Math.max(1e-9, ...units.map(u => rawTargetValue(u)));

  return { capabilities, weapons, detection, attackRange, targetValueMax };
}

/**
 * Operational Effectiveness of `unit` for `taskType`, in [0,1]. Averages
 * the normalized score of every capability dimension the task cares about
 * that the unit actually has data for (a unit with no weapons listed for a
 * task simply contributes via its capabilities/detection/attackRange).
 */
function unitOE(unit, taskType, scales) {
  const task = TASK_TYPES[taskType];
  if (!task) return 0;

  const components = [];

  if (task.weapons.length) {
    const score = task.weapons.reduce((sum, w) => sum + weaponPotential(unit, w) / scales.weapons[w], 0) / task.weapons.length;
    components.push(score);
  }
  if (task.capabilities.length) {
    const score = task.capabilities.reduce((sum, c) => sum + Number(unit.capabilities?.[c] || 0) / scales.capabilities[c], 0) / task.capabilities.length;
    components.push(score);
  }
  components.push(Number(unit.detectionRange?.[task.detection] || 0) / scales.detection[task.detection]);
  components.push(rangeAgainst(unit.attackRange, task.targetCategory) / scales.attackRange[task.targetCategory]);

  if (components.length === 0) return 0;
  const oe = components.reduce((a, b) => a + b, 0) / components.length;
  return Math.max(0, Math.min(1, oe));
}

/** Best task type for `unit` and its OE score, used for COA task assignment. */
function bestTaskForUnit(unit, scales) {
  let best = null;
  for (const taskType of Object.keys(TASK_TYPES)) {
    const oe = unitOE(unit, taskType, scales);
    if (!best || oe > best.oe) best = { task: taskType, oe };
  }
  return best;
}

/** Raw (unnormalized) strategic value of a unit as a target: combines offensive potential, defensive capability and remaining staying power. */
function rawTargetValue(unit) {
  const weaponSum = ALL_WEAPONS.reduce((sum, w) => sum + weaponPotential(unit, w), 0);
  const capSum = ALL_CAPABILITIES.reduce((sum, c) => sum + Number(unit.capabilities?.[c] || 0), 0);
  const hp = Number(unit.hp ?? unit.maxHp ?? unit.stayingPower ?? 0);
  return weaponSum + capSum * 2 + hp;
}

/** Normalized [0,1] strategic value of `unit` as a target, relative to the OB's most valuable unit. */
function targetValue(unit, scales) {
  return Math.max(0, Math.min(1, rawTargetValue(unit) / scales.targetValueMax));
}

/**
 * Score for `attacker` engaging `target` at hex `distance`, combining the
 * attacker's OE for the relevant task with the target's strategic value.
 * Returns 0 if the attacker has no weapon range against the target's
 * category at this distance (mirrors the client/server atkHexes gate).
 */
function attackScore(attacker, target, distance, scales) {
  const range = rangeAgainst(attacker.attackRange, target.category);
  if (range < 1 || distance > range) return 0;

  const taskType = TASK_FOR_TARGET_CATEGORY[target.category];
  const oe = taskType ? unitOE(attacker, taskType, scales) : 0;
  const value = targetValue(target, scales);

  // Slight preference for closer targets (more turns of engagement remaining).
  const proximity = 1 / (1 + distance * 0.1);
  return oe * value * proximity;
}

module.exports = {
  TASK_TYPES,
  TASK_FOR_TARGET_CATEGORY,
  computeReferenceScales,
  unitOE,
  bestTaskForUnit,
  targetValue,
  attackScore,
};
