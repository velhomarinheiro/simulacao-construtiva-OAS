'use strict';

/**
 * parameters.js
 * =============
 *
 * Ported from naval_salvo/parameters.py.
 *
 * PairParameters    - per (attacker unit type, defender unit type)
 *                      sigma/eta/p coefficients for one ordered pair.
 * DirectionalParameters - (nAttacker x nDefender) grid of PairParameters
 *                      for one attack direction (Blue->Red or Red->Blue).
 * EngagementParameters  - top-level bundle: both Forces + both
 *                      directional blocks + global params (t_char, rho).
 */

const { KINETIC_DOMAINS } = require('./domains');

/**
 * Calibrable parameters for one ordered (attacker, defender) pair.
 *
 * sigma_offense, sigma_defense, eta_offense, eta_defense in [0, 1].
 * p_offense, p_defense >= 0 (unbounded throughput, hits per salvo).
 */
class PairParameters {
  constructor({
    sigmaOffense = 1.0,
    sigmaDefense = 1.0,
    etaOffense = 1.0,
    etaDefense = 1.0,
    pOffense = 0.0,
    pDefense = 0.0,
  } = {}) {
    for (const [name, v] of [
      ['sigmaOffense', sigmaOffense],
      ['sigmaDefense', sigmaDefense],
      ['etaOffense', etaOffense],
      ['etaDefense', etaDefense],
    ]) {
      if (!(v >= 0.0 && v <= 1.0) || !Number.isFinite(v)) {
        throw new Error(`PairParameters.${name} must be in [0, 1] and finite; got ${v}.`);
      }
    }
    for (const [name, v] of [
      ['pOffense', pOffense],
      ['pDefense', pDefense],
    ]) {
      if (!(v >= 0.0) || !Number.isFinite(v)) {
        throw new Error(`PairParameters.${name} must be >= 0 and finite; got ${v}.`);
      }
    }
    this.sigmaOffense = sigmaOffense;
    this.sigmaDefense = sigmaDefense;
    this.etaOffense = etaOffense;
    this.etaDefense = etaDefense;
    this.pOffense = pOffense;
    this.pDefense = pDefense;
  }

  /** sigma^atq * eta^atq * p^atq */
  offensiveKernel() {
    return this.sigmaOffense * this.etaOffense * this.pOffense;
  }

  /** sigma^def * eta^def * p^def */
  defensiveKernel() {
    return this.sigmaDefense * this.etaDefense * this.pDefense;
  }
}

/**
 * All per-pair parameters for one attack direction (attacker -> defender).
 *
 * `pairs[j][i]` describes attacker unit type j attacking defender unit
 * type i (row = attacker, col = defender, matching the JPH "O" matrix).
 */
class DirectionalParameters {
  constructor(attacker, defender, pairs) {
    const nA = attacker.nUnitTypes;
    const nD = defender.nUnitTypes;
    if (pairs.length !== nA || pairs.some((row) => row.length !== nD)) {
      throw new Error(
        `DirectionalParameters.pairs must have shape (${nA}, ${nD}).`
      );
    }
    for (const row of pairs) {
      for (const p of row) {
        if (!(p instanceof PairParameters)) {
          throw new Error('pairs entries must be PairParameters instances.');
        }
      }
    }
    this.attacker = attacker;
    this.defender = defender;
    this.pairs = pairs;
  }

  /** All-zero throughput, unit sigma/eta ("everything inert"). */
  static zeros(attacker, defender) {
    const nA = attacker.nUnitTypes;
    const nD = defender.nUnitTypes;
    const def = new PairParameters();
    const pairs = Array.from({ length: nA }, () => Array.from({ length: nD }, () => def));
    return new DirectionalParameters(attacker, defender, pairs);
  }

  get(attackerName, defenderName) {
    const j = this.attacker.indexOf(attackerName);
    const i = this.defender.indexOf(defenderName);
    return this.pairs[j][i];
  }

  set(attackerName, defenderName, params) {
    if (!(params instanceof PairParameters)) {
      throw new TypeError('params must be a PairParameters instance.');
    }
    const j = this.attacker.indexOf(attackerName);
    const i = this.defender.indexOf(defenderName);
    this.pairs[j][i] = params;
  }

  /** (nAttacker x nDefender) matrix of sigma^atq * eta^atq * p^atq. */
  offensiveKernelMatrix() {
    return this.pairs.map((row) => row.map((p) => p.offensiveKernel()));
  }

  /** (nAttacker x nDefender) matrix of sigma^def * eta^def * p^def. */
  defensiveKernelMatrix() {
    return this.pairs.map((row) => row.map((p) => p.defensiveKernel()));
  }
}

const DEFAULT_T_CHAR = Object.freeze([1.0, 1.0, 1.0, 1.0]); // S, U, A, C
const DEFAULT_RHO = Object.freeze([0.0, 0.0, 0.0, 0.0]);

/**
 * All numerical inputs to the dynamics modules, except the live state.
 *
 * @property {Force} blue
 * @property {Force} red
 * @property {DirectionalParameters} blueAttacksRed
 * @property {DirectionalParameters} redAttacksBlue
 * @property {number[]} tChar  characteristic times per kinetic domain (S,U,A,C)
 * @property {number[]} rho    regeneration rates per kinetic domain (S,U,A,C)
 */
class EngagementParameters {
  constructor({
    blue,
    red,
    blueAttacksRed,
    redAttacksBlue,
    tChar = DEFAULT_T_CHAR,
    rho = DEFAULT_RHO,
  }) {
    if (blueAttacksRed.attacker !== blue || blueAttacksRed.defender !== red) {
      throw new Error('blueAttacksRed must reference the same blue/red Force objects.');
    }
    if (redAttacksBlue.attacker !== red || redAttacksBlue.defender !== blue) {
      throw new Error('redAttacksBlue must reference the same blue/red Force objects.');
    }
    if (tChar.length !== KINETIC_DOMAINS.length) {
      throw new Error(`tChar must have length ${KINETIC_DOMAINS.length}.`);
    }
    if (rho.length !== KINETIC_DOMAINS.length) {
      throw new Error(`rho must have length ${KINETIC_DOMAINS.length}.`);
    }
    for (const v of tChar) {
      if (!(v > 0.0) || !Number.isFinite(v)) {
        throw new Error(`tChar entries must be > 0 and finite; got ${v}.`);
      }
    }
    for (const v of rho) {
      if (!(v >= 0.0) || !Number.isFinite(v)) {
        throw new Error(`rho entries must be >= 0 and finite; got ${v}.`);
      }
    }
    this.blue = blue;
    this.red = red;
    this.blueAttacksRed = blueAttacksRed;
    this.redAttacksBlue = redAttacksBlue;
    this.tChar = tChar.slice();
    this.rho = rho.slice();
  }

  /** Build with both directions filled with zero throughput. */
  static withZeroCouplings(blue, red, tChar = DEFAULT_T_CHAR, rho = DEFAULT_RHO) {
    return new EngagementParameters({
      blue,
      red,
      blueAttacksRed: DirectionalParameters.zeros(blue, red),
      redAttacksBlue: DirectionalParameters.zeros(red, blue),
      tChar,
      rho,
    });
  }
}

module.exports = { PairParameters, DirectionalParameters, EngagementParameters };
