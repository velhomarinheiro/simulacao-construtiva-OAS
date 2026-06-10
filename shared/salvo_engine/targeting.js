'use strict';

/**
 * targeting.js
 * ============
 *
 * Ported from naval_salvo/targeting.py.
 *
 * Targeting policies fill in the sigma^atq (offensive aiming) and
 * sigma^def (defensive aiming) shares of every (attacker, defender)
 * pair. Each policy's compute(attacker, defender, admissibility)
 * returns { sigmaOffense, sigmaDefense }, both (nAttacker x nDefender)
 * matrices with entries in [0, 1].
 *
 * These are not used by the per-engagement 1v1 resolution of the
 * vertical-slice wargame (where sigma is always 1), but are kept for
 * the batch / capability-planning simulations (Mazal step 8: repeated
 * constructive wargames over whole Forces) anticipated for a later
 * phase.
 */

function admissibilityMask(attacker, defender, admissibility) {
  const nAtk = attacker.nUnitTypes;
  const nDef = defender.nUnitTypes;
  const chi = [];
  for (let j = 0; j < nAtk; j++) {
    const row = [];
    for (let i = 0; i < nDef; i++) {
      row.push(admissibility.get(attacker.unitTypes[j].domain, defender.unitTypes[i].domain));
    }
    chi.push(row);
  }
  return chi;
}

/** Normalise each row of W to sum to 1; all-zero rows stay zero. */
function rowNormalise(W) {
  return W.map((row) => {
    const sum = row.reduce((a, b) => a + b, 0.0);
    if (sum <= 0.0) return row.map(() => 0.0);
    return row.map((v) => v / sum);
  });
}

function transpose(M) {
  if (M.length === 0) return [];
  return M[0].map((_, i) => M.map((row) => row[i]));
}

/** Equal split across admissible targets (Hughes 1995 default reading). */
class Uniform {
  compute(attacker, defender, admissibility) {
    const chi = admissibilityMask(attacker, defender, admissibility);
    const sigmaOff = rowNormalise(chi);
    const sigmaDef = transpose(rowNormalise(transpose(chi)));
    return { sigmaOffense: sigmaOff, sigmaDefense: sigmaDef };
  }
}

/**
 * sigma allocated proportionally to the *current* opposing stock
 * (MacKay 2009 / Hausken-Moxnes 2026).
 */
class StrengthProportional {
  compute(attacker, defender, admissibility) {
    const chi = admissibilityMask(attacker, defender, admissibility);
    const A = defender.strengthVector(); // (nDef,)
    const B = attacker.strengthVector(); // (nAtk,)

    const Woff = chi.map((row) => row.map((c, i) => c * A[i]));
    const sigmaOff = rowNormalise(Woff);

    const nAtk = attacker.nUnitTypes;
    const nDef = defender.nUnitTypes;
    const Wdef = chi.map((row, j) => row.map((c) => c * B[j]));
    const colSums = new Array(nDef).fill(0.0);
    for (let i = 0; i < nDef; i++) {
      for (let j = 0; j < nAtk; j++) colSums[i] += Wdef[j][i];
    }
    const sigmaDef = Wdef.map((row) =>
      row.map((v, i) => (colSums[i] > 0.0 ? v / colSums[i] : 0.0))
    );
    return { sigmaOffense: sigmaOff, sigmaDefense: sigmaDef };
  }
}

/** sigma proportional to a calibrated per-target weight vector. */
class ThreatWeighted {
  /**
   * @param {object} [opts]
   * @param {number[]} [opts.offensiveWeights]  length nDefender
   * @param {number[]} [opts.defensiveWeights]  length nAttacker
   */
  constructor({ offensiveWeights = null, defensiveWeights = null } = {}) {
    for (const [name, w] of [
      ['offensiveWeights', offensiveWeights],
      ['defensiveWeights', defensiveWeights],
    ]) {
      if (w == null) continue;
      if (w.some((v) => !(v >= 0.0) || !Number.isFinite(v))) {
        throw new Error(`ThreatWeighted.${name} must be non-negative and finite.`);
      }
    }
    this.offensiveWeights = offensiveWeights;
    this.defensiveWeights = defensiveWeights;
  }

  compute(attacker, defender, admissibility) {
    const chi = admissibilityMask(attacker, defender, admissibility);
    const nAtk = attacker.nUnitTypes;
    const nDef = defender.nUnitTypes;

    const wOff = this.offensiveWeights ?? new Array(nDef).fill(1.0);
    const wDef = this.defensiveWeights ?? new Array(nAtk).fill(1.0);
    if (wOff.length !== nDef) {
      throw new Error(`offensiveWeights length ${wOff.length} != ${nDef}.`);
    }
    if (wDef.length !== nAtk) {
      throw new Error(`defensiveWeights length ${wDef.length} != ${nAtk}.`);
    }

    const sigmaOff = rowNormalise(chi.map((row) => row.map((c, i) => c * wOff[i])));

    const Wdef = chi.map((row, j) => row.map((c) => c * wDef[j]));
    const colSums = new Array(nDef).fill(0.0);
    for (let i = 0; i < nDef; i++) {
      for (let j = 0; j < nAtk; j++) colSums[i] += Wdef[j][i];
    }
    const sigmaDef = Wdef.map((row) =>
      row.map((v, i) => (colSums[i] > 0.0 ? v / colSums[i] : 0.0))
    );
    return { sigmaOffense: sigmaOff, sigmaDefense: sigmaDef };
  }
}

/** Bring-your-own sigma matrices (eg. reproducing historical worked examples). */
class Manual {
  constructor({ sigmaOffense, sigmaDefense }) {
    for (const [name, v] of [
      ['sigmaOffense', sigmaOffense],
      ['sigmaDefense', sigmaDefense],
    ]) {
      if (!v) throw new Error(`Manual.${name} is required.`);
      for (const row of v) {
        for (const x of row) {
          if (!(x >= 0.0 && x <= 1.0) || !Number.isFinite(x)) {
            throw new Error(`Manual.${name} must lie in [0, 1] and be finite.`);
          }
        }
      }
    }
    this.sigmaOffense = sigmaOffense;
    this.sigmaDefense = sigmaDefense;
  }

  compute(attacker, defender) {
    const expected = [attacker.nUnitTypes, defender.nUnitTypes];
    const shapeOf = (m) => [m.length, m[0]?.length ?? 0];
    if (JSON.stringify(shapeOf(this.sigmaOffense)) !== JSON.stringify(expected)) {
      throw new Error('Manual.sigmaOffense has unexpected shape.');
    }
    if (JSON.stringify(shapeOf(this.sigmaDefense)) !== JSON.stringify(expected)) {
      throw new Error('Manual.sigmaDefense has unexpected shape.');
    }
    return {
      sigmaOffense: this.sigmaOffense.map((r) => r.slice()),
      sigmaDefense: this.sigmaDefense.map((r) => r.slice()),
    };
  }
}

module.exports = {
  admissibilityMask,
  rowNormalise,
  Uniform,
  StrengthProportional,
  ThreatWeighted,
  Manual,
};
