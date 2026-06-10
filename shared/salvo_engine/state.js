'use strict';

/**
 * state.js
 * ========
 *
 * Ported from naval_salvo/state.py.
 *
 * Data structures representing the *state* of a heterogeneous
 * multi-domain salvo battle at a given instant: UnitType (static
 * parameters), Force (one side's collection of unit types + live
 * strengths), and BattleState (both sides + time/log).
 */

const { DOMAIN_ORDER, KINETIC_DOMAINS, parseDomain } = require('./domains');

/**
 * Static description of one heterogeneous unit type.
 *
 * @property {string} name              unique within a Force
 * @property {string} domain            one of DOMAIN_ORDER ('S','U','A','C','X')
 * @property {number} stayingPower      hits a unit can absorb before
 *                                       combat-ineffective (must be > 0)
 * @property {number} initialStrength   count at t=0 (must be >= 0)
 * @property {string|null} subtype      free-form sub-category tag
 */
class UnitType {
  constructor({ name, domain, stayingPower, initialStrength, subtype = null }) {
    if (!name) throw new Error('UnitType.name must be a non-empty string.');
    this.name = name;
    this.domain = parseDomain(domain);
    if (!(stayingPower > 0.0) || !Number.isFinite(stayingPower)) {
      throw new Error(
        `UnitType ${name}: stayingPower must be > 0 and finite; got ${stayingPower}.`
      );
    }
    this.stayingPower = stayingPower;
    if (!(initialStrength >= 0.0) || !Number.isFinite(initialStrength)) {
      throw new Error(
        `UnitType ${name}: initialStrength must be >= 0 and finite; got ${initialStrength}.`
      );
    }
    this.initialStrength = initialStrength;
    this.subtype = subtype;
  }
}

/**
 * One side (Blue or Red) of an engagement: a list of UnitType plus a
 * parallel array of live current strengths.
 */
class Force {
  /**
   * @param {string} label
   * @param {UnitType[]} unitTypes
   */
  constructor(label, unitTypes = []) {
    if (!label) throw new Error('Force.label must be a non-empty string.');
    this.label = label;
    this.unitTypes = unitTypes.slice();

    const names = this.unitTypes.map((ut) => ut.name);
    const seen = new Set();
    const dup = new Set();
    for (const n of names) {
      if (seen.has(n)) dup.add(n);
      seen.add(n);
    }
    if (dup.size > 0) {
      throw new Error(
        `Force ${label}: duplicate unit type names: ${[...dup].sort().join(', ')}.`
      );
    }

    this.currentStrengths = this.unitTypes.map((ut) => ut.initialStrength);
    this._indexByName = new Map(this.unitTypes.map((ut, i) => [ut.name, i]));
  }

  get nUnitTypes() {
    return this.unitTypes.length;
  }

  addUnitType(ut, currentStrength = ut.initialStrength) {
    if (this._indexByName.has(ut.name)) {
      throw new Error(`Force ${this.label}: unit type ${ut.name} already present.`);
    }
    this.unitTypes.push(ut);
    this.currentStrengths.push(currentStrength);
    this._indexByName.set(ut.name, this.unitTypes.length - 1);
  }

  indexOf(name) {
    const idx = this._indexByName.get(name);
    if (idx === undefined) {
      throw new Error(`Force ${this.label}: unknown unit type ${name}.`);
    }
    return idx;
  }

  unitTypesIn(domain) {
    const d = parseDomain(domain);
    return this.unitTypes.filter((ut) => ut.domain === d);
  }

  indicesIn(domain) {
    const d = parseDomain(domain);
    const out = [];
    this.unitTypes.forEach((ut, i) => {
      if (ut.domain === d) out.push(i);
    });
    return out;
  }

  strengthOf(name) {
    return this.currentStrengths[this.indexOf(name)];
  }

  setStrengthOf(name, value) {
    if (!Number.isFinite(value)) throw new Error(`strength must be finite; got ${value}.`);
    this.currentStrengths[this.indexOf(name)] = Math.max(0.0, value);
  }

  /** Return current strengths as a plain array, in unitTypes order. */
  strengthVector() {
    return this.currentStrengths.slice();
  }

  /**
   * Update all current strengths from an array (same length as
   * unitTypes). Negative entries are clipped to 0.
   */
  setStrengthVector(vec) {
    if (vec.length !== this.nUnitTypes) {
      throw new Error(
        `strength vector has length ${vec.length}; expected ${this.nUnitTypes}.`
      );
    }
    for (const v of vec) {
      if (!Number.isFinite(v)) throw new Error('strength vector contains non-finite values.');
    }
    this.currentStrengths = vec.map((v) => Math.max(0.0, v));
  }

  initialStrengthVector() {
    return this.unitTypes.map((ut) => ut.initialStrength);
  }

  stayingPowerVector() {
    return this.unitTypes.map((ut) => ut.stayingPower);
  }

  /** Current total strength summed within each domain. */
  totalStrengthByDomain() {
    const out = {};
    for (const d of DOMAIN_ORDER) out[d] = 0.0;
    this.unitTypes.forEach((ut, i) => {
      out[ut.domain] += this.currentStrengths[i];
    });
    return out;
  }

  /** True if every unit type has current strength <= threshold. */
  isCombatIneffective(threshold = 0.0) {
    return this.currentStrengths.every((s) => s <= threshold);
  }
}

/**
 * Live state of a Blue-vs-Red engagement: the two Forces plus time and
 * salvo history.
 */
class BattleState {
  constructor(blue, red, time = 0.0, salvoTimes = []) {
    if (blue.label === red.label) {
      throw new Error(
        `Blue and Red forces must have distinct labels; both are ${blue.label}.`
      );
    }
    this.blue = blue;
    this.red = red;
    this.time = time;
    this.salvoTimes = salvoTimes.slice();
  }

  /** Return the Force for 'blue' or 'red' (case-insensitive, or matches label). */
  force(side) {
    const s = side.trim().toLowerCase();
    if (s === this.blue.label.toLowerCase()) return this.blue;
    if (s === this.red.label.toLowerCase()) return this.red;
    if (s === 'blue') return this.blue;
    if (s === 'red') return this.red;
    throw new Error(
      `Unknown side '${side}'; expected one of '${this.blue.label}', '${this.red.label}', 'blue', 'red'.`
    );
  }

  opposingForce(side) {
    const own = this.force(side);
    return own === this.blue ? this.red : this.blue;
  }

  recordSalvo(t) {
    this.salvoTimes.push(t);
  }

  /** True if either side is combat-ineffective in *all* kinetic domains. */
  isTerminated() {
    for (const force of [this.blue, this.red]) {
      let kineticTotal = 0.0;
      force.unitTypes.forEach((ut, i) => {
        if (KINETIC_DOMAINS.includes(ut.domain)) {
          kineticTotal += force.currentStrengths[i];
        }
      });
      if (kineticTotal <= 0.0) return true;
    }
    return false;
  }
}

module.exports = { UnitType, Force, BattleState };
