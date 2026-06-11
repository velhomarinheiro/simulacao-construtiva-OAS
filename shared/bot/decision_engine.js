'use strict';

/**
 * decision_engine.js
 * ===================
 *
 * Turns a course of action (shared/bot/coa_planner.js) into the concrete
 * socket actions a digital player sends each turn:
 *
 *   decideMovement(state, team) -> moves[]    for 'commit_moves'
 *   decideAttacks(state, team)  -> attacks[]  for 'declare_attacks'
 *
 * Movement follows each unit's COA assignment (its objective hex) via
 * A* pathfinding (shared/bot/pathfinding.js), truncated to this turn's
 * movement allowance. Attacks are chosen independently of the COA: every
 * unit with a detected enemy in weapon range fires at its highest
 * attackScore target (shared/bot/capability_eval.js) for this turn.
 */

const { hexDist } = require('../hexgrid');
const { computeReferenceScales, attackScore } = require('./capability_eval');
const { planCOA, obFromState } = require('./coa_planner');
const { planMoveTowards } = require('./pathfinding');

// Mirrors fuel_model.js's isFuelDisabled: naval units at 0 fuel can't move, attack or defend.
function isFuelDisabled(unit) {
  return unit.fuel?.fuelType === 'naval' && (unit.fuel.current ?? 1) <= 0;
}

/**
 * @param {object} state  fog-of-war-filtered game state for `team`
 * @param {string} team   'blue' | 'red'
 * @returns {Array<{unitId:string, path:{col:number,row:number}[]}>}
 */
function decideMovement(state, team) {
  const { assignments } = planCOA(state, team);
  const moves = [];
  for (const a of assignments) {
    const unit = state.units.find(u => u.id === a.unitId && u.team === team && u.hp > 0);
    if (!unit || !unit.movement || isFuelDisabled(unit)) continue;
    const { path } = planMoveTowards(unit, a.objectiveHex);
    if (path.length < 2) continue;
    moves.push({ unitId: unit.id, path });
  }
  return moves;
}

/**
 * @param {object} state  fog-of-war-filtered game state for `team`
 * @param {string} team   'blue' | 'red'
 * @returns {Array<{attackerId:string, targetId:string}>}
 */
function decideAttacks(state, team) {
  const scales = computeReferenceScales(obFromState(state));
  const mine = state.units.filter(u => u.team === team && u.hp > 0 && !isFuelDisabled(u));
  const enemies = state.units.filter(u => u.team !== team && u.team !== 'neutral' && u.hp > 0 && u.detected);

  const attacks = [];
  for (const u of mine) {
    let best = null;
    for (const enemy of enemies) {
      const dist = hexDist(u.col, u.row, enemy.col, enemy.row);
      const score = attackScore(u, enemy, dist, scales);
      if (score > 0 && (!best || score > best.score)) best = { enemy, score };
    }
    if (best) attacks.push({ attackerId: u.id, targetId: best.enemy.id });
  }
  return attacks;
}

module.exports = { decideMovement, decideAttacks, isFuelDisabled };
