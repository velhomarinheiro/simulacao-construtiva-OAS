'use strict';

/**
 * admissibility.js
 * ================
 *
 * Ported from naval_salvo/admissibility.py.
 *
 * Implements the 5x5 cross-domain admissibility matrix that gates which
 * attacker-domain / defender-domain pairs can interact:
 *
 *   1   - primary admissible (full doctrinal capability)
 *   chi - marginal, calibrable in [0, 1]
 *   0   - structurally null
 *
 * Convention: matrix[d_attacker][d_defender], rows = attackers,
 * columns = defenders, both indexed via DOMAIN_ORDER.
 */

const { DOMAIN_ORDER, domainIndex, parseDomain } = require('./domains');

const DEFAULT_CHI = 0.5;

/** Only the (Surface, Surface) cell is active (JPH 2001 degenerate case). */
function degenerateJohnsPilnickHughes() {
  const M = DOMAIN_ORDER.map(() => DOMAIN_ORDER.map(() => 0.0));
  const s = domainIndex('S');
  M[s][s] = 1.0;
  return M;
}

/**
 * Canonical default 5x5 admissibility matrix (document 1.4 Table 1).
 *
 *   Attacker \ Defender |  S    U    A    C    X
 *   --------------------+------------------------
 *   S (surface)         |  1    chi  chi  1    chi
 *   U (underwater)      |  1    1    0    chi  0
 *   A (air)             |  1    chi  1    1    chi
 *   C (coastal)         |  1    chi  chi  1    chi
 *   X (cyber)           |  chi  0    chi  chi  1
 */
function canonicalMatrix(chi = DEFAULT_CHI) {
  if (!(chi >= 0.0 && chi <= 1.0)) {
    throw new Error(`chi must be in [0, 1]; got ${chi}.`);
  }
  const [S, U, A, C, X] = DOMAIN_ORDER.map((d) => domainIndex(d));
  const M = DOMAIN_ORDER.map(() => DOMAIN_ORDER.map(() => 0.0));

  M[S][S] = 1.0; M[S][U] = chi; M[S][A] = chi; M[S][C] = 1.0; M[S][X] = chi;
  M[U][S] = 1.0; M[U][U] = 1.0; M[U][A] = 0.0; M[U][C] = chi; M[U][X] = 0.0;
  M[A][S] = 1.0; M[A][U] = chi; M[A][A] = 1.0; M[A][C] = 1.0; M[A][X] = chi;
  M[C][S] = 1.0; M[C][U] = chi; M[C][A] = chi; M[C][C] = 1.0; M[C][X] = chi;
  M[X][S] = chi; M[X][U] = 0.0; M[X][A] = chi; M[X][C] = chi; M[X][X] = 1.0;

  return M;
}

class Admissibility {
  /** @param {number[][]} matrix 5x5 array, matrix[attacker][defender] in [0,1] */
  constructor(matrix) {
    if (matrix.length !== DOMAIN_ORDER.length) {
      throw new Error(
        `Admissibility matrix must have ${DOMAIN_ORDER.length} rows; got ${matrix.length}.`
      );
    }
    for (const row of matrix) {
      if (row.length !== DOMAIN_ORDER.length) {
        throw new Error(
          `Admissibility matrix rows must have ${DOMAIN_ORDER.length} entries.`
        );
      }
      for (const v of row) {
        if (!(v >= 0.0 && v <= 1.0) || !Number.isFinite(v)) {
          throw new Error(`All admissibility entries must lie in [0, 1]; got ${v}.`);
        }
      }
    }
    this.matrix = matrix.map((row) => row.slice());
    Object.freeze(this.matrix);
  }

  static canonical(chi = DEFAULT_CHI) {
    return new Admissibility(canonicalMatrix(chi));
  }

  static degenerate() {
    return new Admissibility(degenerateJohnsPilnickHughes());
  }

  static fromArray(M) {
    return new Admissibility(M);
  }

  /** Look up chi(attackerDomain -> defenderDomain). */
  get(attackerDomain, defenderDomain) {
    const a = domainIndex(parseDomain(attackerDomain));
    const d = domainIndex(parseDomain(defenderDomain));
    return this.matrix[a][d];
  }

  isAdmissible(attackerDomain, defenderDomain) {
    return this.get(attackerDomain, defenderDomain) > 0.0;
  }

  asTable() {
    const out = {};
    for (const a of DOMAIN_ORDER) {
      out[a] = {};
      for (const d of DOMAIN_ORDER) {
        out[a][d] = this.get(a, d);
      }
    }
    return out;
  }
}

module.exports = {
  DEFAULT_CHI,
  degenerateJohnsPilnickHughes,
  canonicalMatrix,
  Admissibility,
};
