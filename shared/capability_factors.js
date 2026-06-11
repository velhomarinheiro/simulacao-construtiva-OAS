'use strict';

/**
 * capability_factors.js
 * ======================
 *
 * Defines the 5 Blue capability factors used by the PBC (Planejamento
 * Baseado em Capacidades) capability-comparison study (ablation design +
 * full factorial 2^5), per "Projeto de Pesquisa com Simulação Construtiva
 * v3.0" (Tabela 1) and the matriz_fatorial_2a5.xlsx "Dicionario" sheet.
 *
 * Each factor maps to a set of forces/order_of_battle.js unit ids that are
 * removed from the Blue order of battle when the factor is "off" (-1).
 * Costs are EAC-normalized (Dicionario sheet): A_SSN=100, B_SSK=31,
 * C_Azuis=78, D_MSS=27, E_Terra=12 (sum=248, matches Cond_C0 baseline cost
 * in the ablation matrix).
 */

const CAPABILITY_FACTORS = {
  A_SSN: {
    label: 'A_SSN — Dissuasão/Negação por Submarino Nuclear',
    cost: 100,
    unitIds: ['BLUE-SUB-N'],
  },
  B_SSK: {
    label: 'B_SSK — Negação por Submarinos Convencionais',
    cost: 31,
    unitIds: ['BLUE-SUB-1', 'BLUE-SUB-2', 'BLUE-SUB-3'],
  },
  C_Azuis: {
    label: 'C_Azuis — Controle de Águas Azuis (Grupos de Tarefa de Superfície)',
    cost: 78,
    unitIds: ['BLUE-SAG-S1', 'BLUE-SAG-S2'],
  },
  D_MSS: {
    label: 'D_MSS — Patrulha Armada com Mísseis de Superfície',
    cost: 27,
    unitIds: ['BLUE-PAT-O1', 'BLUE-PAT-O2', 'BLUE-PAT-C1', 'BLUE-PAT-C2'],
  },
  E_Terra: {
    label: 'E_Terra — Negação Terrestre (Defesa Costeira)',
    cost: 12,
    unitIds: ['BLUE-DCOST1', 'BLUE-DCOST2'],
  },
};

const FACTOR_KEYS = Object.keys(CAPABILITY_FACTORS);

// E2_vp: pontos de valor de infraestrutura crítica (plataformas offshore).
const FPSO_UNIT_IDS = ['BLUE-FPSO1', 'BLUE-FPSO2', 'BLUE-FPSO3', 'BLUE-FPSO4'];

// E2_sloc: nós logísticos/portuários cuja sobrevivência indica segurança
// das linhas de comunicação marítimas (SLOC).
const PORT_UNIT_IDS = ['BLUE-PORTO-S', 'BLUE-PORTO-RJ', 'BLUE-PORTO-V', 'BLUE-PORTO-ACU'];

/** factors[key] truthy/+1 => capability present (on). */
function isActive(value) {
  return value === true || value === 1 || value === '1' || value === '+1';
}

function totalCost(factors) {
  return FACTOR_KEYS.reduce((sum, key) => sum + (isActive(factors[key]) ? CAPABILITY_FACTORS[key].cost : 0), 0);
}

function countActive(factors) {
  return FACTOR_KEYS.reduce((n, key) => n + (isActive(factors[key]) ? 1 : 0), 0);
}

/**
 * Returns a deep-cloned Order of Battle with the units belonging to every
 * "off" capability factor removed from forces.blue.
 *
 * @param {object} baseOB     ORDER_OF_BATTLE-shaped object
 * @param {object} factors    { A_SSN, B_SSK, C_Azuis, D_MSS, E_Terra } -> truthy/+1 = on
 * @returns {object} cloned OB with inactive-factor units removed
 */
function applyCapabilityConfig(baseOB, factors) {
  const ob = JSON.parse(JSON.stringify(baseOB));
  const removeIds = new Set();
  for (const key of FACTOR_KEYS) {
    if (!isActive(factors[key])) {
      for (const id of CAPABILITY_FACTORS[key].unitIds) removeIds.add(id);
    }
  }
  ob.forces.blue = ob.forces.blue.filter(spec => !removeIds.has(spec.id));
  return ob;
}

module.exports = {
  CAPABILITY_FACTORS,
  FACTOR_KEYS,
  FPSO_UNIT_IDS,
  PORT_UNIT_IDS,
  isActive,
  totalCost,
  countActive,
  applyCapabilityConfig,
};
