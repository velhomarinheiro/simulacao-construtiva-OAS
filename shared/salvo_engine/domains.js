'use strict';

/**
 * domains.js
 * ==========
 *
 * Canonical five domains of the heterogeneous multi-domain salvo model,
 * ported from naval_salvo/domains.py.
 *
 * D = { S, U, A, C, X }
 *   S - Surface     (surface combatants, USVs, helicopters carried,
 *                     surface mines, pre-salt platforms)
 *   U - Underwater  (submarines, UUVs, submarine mines)
 *   A - Air         (aircraft, UAVs)
 *   C - Coastal     (coastal artillery, anti-ship missile batteries,
 *                     coastal mines)
 *   X - Cyber-EM    (cyber/electromagnetic effects; sub-types
 *                     X_C2, X_SEN, X_WPN, X_LOG)
 *
 * The ordering (S, U, A, C, X) is fixed and many objects (admissibility
 * matrix, state vectors) are indexed by it.
 */

const DOMAIN_ORDER = Object.freeze(['S', 'U', 'A', 'C', 'X']);

const KINETIC_DOMAINS = Object.freeze(DOMAIN_ORDER.filter((d) => d !== 'X'));

const DOMAIN_INDEX = Object.freeze(
  DOMAIN_ORDER.reduce((acc, d, i) => {
    acc[d] = i;
    return acc;
  }, {})
);

const CYBER_SUBTYPES = Object.freeze(['C2', 'SEN', 'WPN', 'LOG']);

/** True for the four kinetic domains (S, U, A, C); false for X. */
function isKinetic(domain) {
  return domain !== 'X';
}

/** Position of a domain in the canonical ordering (0..4). */
function domainIndex(domain) {
  const idx = DOMAIN_INDEX[domain];
  if (idx === undefined) {
    throw new Error(`Unknown domain '${domain}'.`);
  }
  return idx;
}

/**
 * Coerce a string code or long name to a canonical domain code.
 *
 * Accepts the single-letter canonical code ('S','U','A','C','X') or the
 * long name ('SURFACE','UNDERWATER','AIR','COASTAL','CYBER'), case
 * insensitive.
 */
function parseDomain(value) {
  if (typeof value !== 'string') {
    throw new Error(`Cannot parse domain from value of type ${typeof value}`);
  }
  const key = value.trim().toUpperCase();
  if (DOMAIN_ORDER.includes(key)) return key;
  const longNames = {
    SURFACE: 'S',
    UNDERWATER: 'U',
    AIR: 'A',
    COASTAL: 'C',
    CYBER: 'X',
  };
  if (longNames[key]) return longNames[key];
  throw new Error(
    `Unknown domain '${value}'. Valid values: ${DOMAIN_ORDER.join(', ')} ` +
      `or ${Object.keys(longNames).join(', ')}.`
  );
}

module.exports = {
  DOMAIN_ORDER,
  KINETIC_DOMAINS,
  CYBER_SUBTYPES,
  isKinetic,
  domainIndex,
  parseDomain,
};
