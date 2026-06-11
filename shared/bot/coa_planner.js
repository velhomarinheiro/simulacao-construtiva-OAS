'use strict';

/**
 * coa_planner.js
 * ==============
 *
 * Course-of-action (COA) planner for the digital-player AI: turns a
 * (filtered, fog-of-war-aware) game state into a small task network and
 * runs it through the CPM solver (shared/bot/cpm.js) to find the
 * critical path, then assigns each task to the unit with the best
 * Operational Effectiveness (shared/bot/capability_eval.js).
 *
 * Each detected enemy unit becomes a two-task chain:
 *   TRANSIT_<enemyId>  - close to within weapon/sensor range (duration =
 *                        turns to arrive, based on the assigned unit's
 *                        movement)
 *   ENGAGE_<enemyId>   - execute the attack (duration = 1), depends on
 *                        TRANSIT_<enemyId>
 *
 * The resulting `assignments` give shared/bot/decision_engine.js an
 * objective hex per unit for this turn's movement phase. Tasks with zero
 * slack (the critical path) are the engagements that gate how quickly the
 * team can bring its full weight to bear — useful both for prioritizing
 * unit assignment when multiple enemies compete for the same screening
 * unit, and for reporting ("critical path: must close with RED-GE-1 within
 * 2 turns").
 */

const { GRID_W, GRID_H, hexDist, getTerrain, canEnterTerrain, rangeAgainst } = require('../hexgrid');
const { computeReferenceScales, unitOE, TASK_FOR_TARGET_CATEGORY } = require('./capability_eval');
const { computeCPM } = require('./cpm');

/** Closest hex to `unit` that is within `range` of `target` and passable for `unit`. */
function findApproachHex(unit, target, range) {
  if (hexDist(unit.col, unit.row, target.col, target.row) <= range) {
    return { col: unit.col, row: unit.row };
  }
  let best = null, bestDist = Infinity;
  for (let row = 0; row < GRID_H; row++) {
    for (let col = 0; col < GRID_W; col++) {
      if (hexDist(col, row, target.col, target.row) > range) continue;
      if (!canEnterTerrain(unit.category, getTerrain(col, row))) continue;
      const d = hexDist(unit.col, unit.row, col, row);
      if (d < bestDist) { bestDist = d; best = { col, row }; }
    }
  }
  return best;
}

/** Build a synthetic order-of-battle from the current units, for OE normalization. */
function obFromState(state) {
  return {
    forces: {
      blue: state.units.filter(u => u.team === 'blue'),
      red: state.units.filter(u => u.team === 'red'),
      neutral: state.units.filter(u => u.team === 'neutral'),
    },
  };
}

/**
 * @param {object} state  fog-of-war-filtered game state for `team` (as returned by server stateFor)
 * @param {string} team   'blue' | 'red'
 * @returns {{
 *   tasks: Array, assignments: Array<{unitId,objectiveHex,taskId,targetUnitId,oe,transitTurns}>,
 *   cpm: {schedule:Map, projectDuration:number, criticalPath:string[]}, scales: object,
 * }}
 */
function planCOA(state, team) {
  const scales = computeReferenceScales(obFromState(state));
  const mine = state.units.filter(u => u.team === team && u.hp > 0);
  const enemies = state.units.filter(u => u.team !== team && u.team !== 'neutral' && u.hp > 0 && u.detected);

  const tasks = [];
  const assignments = [];
  const assigned = new Set();

  // Engage detected enemies, prioritizing the highest-OE available unit per target.
  for (const enemy of enemies) {
    const taskType = TASK_FOR_TARGET_CATEGORY[enemy.category];
    if (!taskType) continue;

    let best = null;
    for (const u of mine) {
      if (assigned.has(u.id)) continue;
      const range = rangeAgainst(u.attackRange, enemy.category);
      if (range < 1) continue;
      const approach = findApproachHex(u, enemy, range);
      if (!approach) continue;
      const dist = hexDist(u.col, u.row, approach.col, approach.row);
      const transitTurns = dist === 0 ? 0 : (u.movement > 0 ? Math.ceil(dist / u.movement) : Infinity);
      if (!isFinite(transitTurns)) continue;
      const oe = unitOE(u, taskType, scales);
      if (!best || oe > best.oe) best = { unit: u, approach, transitTurns, oe };
    }
    if (!best) continue;

    assigned.add(best.unit.id);
    const transitId = `TRANSIT_${enemy.id}`;
    const engageId = `ENGAGE_${enemy.id}`;
    tasks.push({ id: transitId, duration: Math.max(1, best.transitTurns), dependsOn: [] });
    tasks.push({ id: engageId, duration: 1, dependsOn: [transitId] });
    assignments.push({
      unitId: best.unit.id, objectiveHex: best.approach, taskId: transitId,
      targetUnitId: enemy.id, oe: best.oe, transitTurns: best.transitTurns,
    });
  }

  // Advance-to-contact: with no detected enemies, push armed units toward the
  // map's longitudinal center to extend sensor coverage.
  if (enemies.length === 0) {
    for (const u of mine) {
      if (assigned.has(u.id)) continue;
      const hasOffense = Object.values(u.attackRange || {}).some(v => v > 0);
      if (!hasOffense || (u.movement || 0) === 0) continue;
      const center = { col: GRID_W >> 1, row: u.row };
      if (u.col === center.col) continue;
      assigned.add(u.id);
      tasks.push({ id: `RECON_${u.id}`, duration: 1, dependsOn: [] });
      assignments.push({ unitId: u.id, objectiveHex: center, taskId: `RECON_${u.id}`, targetUnitId: null, oe: 0, transitTurns: 0 });
    }
  }

  const cpm = tasks.length ? computeCPM(tasks) : { schedule: new Map(), projectDuration: 0, criticalPath: [] };
  return { tasks, assignments, cpm, scales };
}

module.exports = { planCOA, findApproachHex, obFromState };
