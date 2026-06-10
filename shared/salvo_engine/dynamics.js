'use strict';

/**
 * dynamics.js
 * ===========
 *
 * Ported from naval_salvo/dynamics/deterministic.py.
 *
 * Deterministic, *pulsed* (jump) regime of the heterogeneous
 * multi-domain salvo equation:
 *
 *   A_i^(d)(t+) = A_i^(d)(t-) - (1 / s_i^(d)) *
 *       max(0, sum_j chi(d_j, d_i) * [ T^atq_{ji} - T^def_{ji} ])
 *
 * where
 *   T^atq_{ji} = sigma_o * eta_o * p_o * B_j(t-)   (attacker j -> defender i)
 *   T^def_{ji} = sigma_d * eta_d * p_d * A_i(t-)   (defender i intercepting j)
 *   chi(d_j, d_i) = admissibility coefficient (attacker domain -> defender domain)
 *   s_i^(d)        = staying power of defender unit type i
 *
 * The exchange is *simultaneous*: both sides compute incoming attrition
 * from the pre-salvo state, then both update. Aggregation over attackers
 * happens *before* the max(0, .) clip (the canonical JPH/Hughes reading).
 */

/**
 * Per-defender raw attrition kernel for one direction.
 *
 * @param {object} params
 * @param {object} params.attackerForce  Force (salvo_engine/state.js)
 * @param {object} params.defenderForce  Force
 * @param {number[]} params.attackerStrengths  B_j, length nAttacker
 * @param {number[]} params.defenderStrengths  A_i, length nDefender
 * @param {number[][]} params.offensiveKernel  (nAttacker x nDefender) O_{ji}
 * @param {number[][]} params.defensiveKernel  (nAttacker x nDefender) D_{ji}
 * @param {object} params.admissibility  Admissibility
 * @returns {number[]} length nDefender, max(0, sum_j chi*O*B - chi*D*A)
 */
function aggregateIncomingKernel({
  attackerForce,
  defenderForce,
  attackerStrengths,
  defenderStrengths,
  offensiveKernel,
  defensiveKernel,
  admissibility,
}) {
  const nAtk = attackerForce.nUnitTypes;
  const nDef = defenderForce.nUnitTypes;

  // chi[j][i] = admissibility(attacker_j.domain -> defender_i.domain)
  const chi = [];
  for (let j = 0; j < nAtk; j++) {
    const row = [];
    const dAtk = attackerForce.unitTypes[j].domain;
    for (let i = 0; i < nDef; i++) {
      const dDef = defenderForce.unitTypes[i].domain;
      row.push(admissibility.get(dAtk, dDef));
    }
    chi.push(row);
  }

  const out = new Array(nDef).fill(0.0);
  for (let i = 0; i < nDef; i++) {
    let totalOffense = 0.0;
    let totalDefense = 0.0;
    for (let j = 0; j < nAtk; j++) {
      const c = chi[j][i];
      totalOffense += c * offensiveKernel[j][i] * attackerStrengths[j];
      totalDefense += c * defensiveKernel[j][i] * defenderStrengths[i];
    }
    out[i] = Math.max(0.0, totalOffense - totalDefense);
  }
  return out;
}

/**
 * Apply one simultaneous salvo exchange to `state`.
 *
 * @param {object} state  BattleState
 * @param {object} params  EngagementParameters
 * @param {object} admissibility  Admissibility
 * @param {object} [opts]
 * @param {boolean} [opts.apply=true]  write post-salvo strengths back into state
 * @param {number} [opts.recordTime]  if set and apply, append to state.salvoTimes
 * @returns {object} SalvoResult
 *   {blueStrengthPre, redStrengthPre, blueStrengthPost, redStrengthPost,
 *    blueLosses, redLosses, blueRawKernel, redRawKernel}
 */
function salvoStep(state, params, admissibility, { apply = true, recordTime = null } = {}) {
  const A = state.blue.strengthVector(); // blue
  const B = state.red.strengthVector(); // red

  const blueRaw = aggregateIncomingKernel({
    attackerForce: state.red,
    defenderForce: state.blue,
    attackerStrengths: B,
    defenderStrengths: A,
    offensiveKernel: params.redAttacksBlue.offensiveKernelMatrix(),
    defensiveKernel: params.redAttacksBlue.defensiveKernelMatrix(),
    admissibility,
  });

  const redRaw = aggregateIncomingKernel({
    attackerForce: state.blue,
    defenderForce: state.red,
    attackerStrengths: A,
    defenderStrengths: B,
    offensiveKernel: params.blueAttacksRed.offensiveKernelMatrix(),
    defensiveKernel: params.blueAttacksRed.defensiveKernelMatrix(),
    admissibility,
  });

  const sBlue = state.blue.stayingPowerVector();
  const sRed = state.red.stayingPowerVector();

  const blueLosses = blueRaw.map((raw, i) => Math.min(raw / sBlue[i], A[i]));
  const redLosses = redRaw.map((raw, i) => Math.min(raw / sRed[i], B[i]));

  const APost = A.map((a, i) => Math.max(0.0, a - blueLosses[i]));
  const BPost = B.map((b, i) => Math.max(0.0, b - redLosses[i]));

  const result = {
    blueStrengthPre: A,
    redStrengthPre: B,
    blueStrengthPost: APost,
    redStrengthPost: BPost,
    blueLosses,
    redLosses,
    blueRawKernel: blueRaw,
    redRawKernel: redRaw,
  };

  if (apply) {
    state.blue.setStrengthVector(APost);
    state.red.setStrengthVector(BPost);
    if (recordTime !== null) state.recordSalvo(recordTime);
  }

  return result;
}

module.exports = { aggregateIncomingKernel, salvoStep };
