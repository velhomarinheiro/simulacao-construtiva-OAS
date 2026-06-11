'use strict';

/**
 * conditions.js
 * =============
 *
 * Generates the experimental condition matrices for the PBC
 * capability-comparison study, matching matriz_fatorial_2a5.xlsx:
 *
 *   - FACTORIAL_CONDITIONS: full factorial 2^5 (32 conditions, "Cond_01"
 *     .. "Cond_32"), standard (Yates) order over
 *     [A_SSN, B_SSK, C_Azuis, D_MSS, E_Terra]. 20 replicas/condition,
 *     seeds 7001-7020 (same set reused across every condition) -> 640 games.
 *
 *   - ABLATION_CONDITIONS: baseline (C0, all 5 capabilities present) plus
 *     one "all except X" condition per capability (C1..C5). 50
 *     replicas/condition, seeds 5001-5050 (same set reused across every
 *     condition) -> 300 games.
 *
 * Costs/n_capacidades are computed via shared/capability_factors so they
 * stay consistent with the EAC-normalized cost table (Dicionario sheet:
 * A_SSN=100, B_SSK=31, C_Azuis=78, D_MSS=27, E_Terra=12).
 */

const { FACTOR_KEYS, totalCost, countActive } = require('../shared/capability_factors');

const FACTORIAL_REPLICAS = 20;
const FACTORIAL_SEED_BASE = 7000; // seeds 7001..7020

const ABLATION_REPLICAS = 50;
const ABLATION_SEED_BASE = 5000; // seeds 5001..5050

function factorialFactors(index) {
  // index: 1..32. Standard (Yates) order: factor i is "+1" when
  // floor((index-1) / 2^(i-1)) is odd.
  const factors = {};
  FACTOR_KEYS.forEach((key, i) => {
    const bit = Math.floor((index - 1) / Math.pow(2, i)) % 2;
    factors[key] = bit === 1 ? 1 : -1;
  });
  return factors;
}

function buildFactorialConditions() {
  const conditions = [];
  for (let i = 1; i <= 32; i++) {
    const factors = factorialFactors(i);
    conditions.push({
      bloco: 'Fatorial',
      condicao: `Cond_${String(i).padStart(2, '0')}`,
      factors,
      n_capacidades: countActive(factors),
      custo_total: totalCost(factors),
      replicas: FACTORIAL_REPLICAS,
      seeds: Array.from({ length: FACTORIAL_REPLICAS }, (_, r) => FACTORIAL_SEED_BASE + r + 1),
    });
  }
  return conditions;
}

function buildAblationConditions() {
  const allOn = {};
  FACTOR_KEYS.forEach(key => { allOn[key] = 1; });

  const conditions = [{
    bloco: 'Ablacao',
    condicao: 'C0',
    capacidade_removida: null,
    factors: { ...allOn },
    n_capacidades: countActive(allOn),
    custo_total: totalCost(allOn),
    replicas: ABLATION_REPLICAS,
    seeds: Array.from({ length: ABLATION_REPLICAS }, (_, r) => ABLATION_SEED_BASE + r + 1),
  }];

  FACTOR_KEYS.forEach((removedKey, i) => {
    const factors = { ...allOn, [removedKey]: -1 };
    conditions.push({
      bloco: 'Ablacao',
      condicao: `C${i + 1}`,
      capacidade_removida: removedKey,
      factors,
      n_capacidades: countActive(factors),
      custo_total: totalCost(factors),
      replicas: ABLATION_REPLICAS,
      seeds: Array.from({ length: ABLATION_REPLICAS }, (_, r) => ABLATION_SEED_BASE + r + 1),
    });
  });

  return conditions;
}

const FACTORIAL_CONDITIONS = buildFactorialConditions();
const ABLATION_CONDITIONS = buildAblationConditions();

module.exports = { FACTOR_KEYS, FACTORIAL_CONDITIONS, ABLATION_CONDITIONS };
