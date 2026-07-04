'use strict';

/**
 * rng.js
 * ======
 *
 * Deterministic seeded PRNG (mulberry32), per "Briefing de Construção"
 * §13 (referência de implementação). Used by the batch runner so that the
 * same seed always reproduces the same sequence of bot decisions, giving
 * the PBC dataset the determinism property required by the acceptance
 * criteria ("mesmo seed -> mesmo resultado").
 *
 * The salvo-equation combat resolution itself (shared/combat_engine.js,
 * shared/salvo_engine/*) is fully deterministic (expected-value kernels,
 * no dice) — it does not consume the RNG. The RNG exists for any
 * stochastic tie-breaking in bot decision policies (shared/bot/*) and for
 * recording the seed alongside each batch run in the dataset.
 */

/**
 * @param {number} seed  32-bit unsigned integer seed
 * @returns {() => number} function returning a float in [0, 1). The returned
 *   function carries a `.state` property (the current internal counter, an
 *   unsigned 32-bit int) so the generator can be snapshotted and resumed
 *   across a process restart via mulberry32FromState — see shared/persistence.js.
 */
function mulberry32(seed) {
  return mulberry32FromState(seed >>> 0);
}

/**
 * Like mulberry32 but resumes from a previously-saved `.state` value, so the
 * sequence continues exactly where it left off. mulberry32(seed) ===
 * mulberry32FromState(seed) before any draw (backward compatible).
 * @param {number} initialA  saved counter (unsigned 32-bit)
 */
function mulberry32FromState(initialA) {
  let a = initialA >>> 0;
  const fn = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    fn.state = a >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  fn.state = a >>> 0;
  return fn;
}

/** Returns an integer in [min, max] (inclusive), drawn from `rng`. */
function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Picks a uniformly random element from `arr` using `rng`. */
function pick(rng, arr) {
  return arr[randInt(rng, 0, arr.length - 1)];
}

module.exports = { mulberry32, mulberry32FromState, randInt, pick };
