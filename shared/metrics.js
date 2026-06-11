'use strict';

/**
 * metrics.js
 * ==========
 *
 * Computes the dependent-variable measures (E1/E2/E3 + M Dsp) used by the
 * PBC capability-comparison dataset (Apêndice F §F.6, Projeto v3.0 §2.5,
 * matriz_fatorial_2a5.xlsx "Dicionario"):
 *
 *   E1_atrito      — atrito imposto ao Vermelho (pontos de stayingPower perdidos)
 *   E1_kcv         — 1 se as forças Vermelhas como um todo foram reduzidas a
 *                    incapacidade de combate (decisivo), senão 0
 *   E2_vp          — pontos de valor de infraestrutura crítica preservados (FPSO 1-4)
 *   E2_sloc        — índice [0,1] de segurança das SLOC (sobrevivência dos portos)
 *   E3_culminancia — turno em que a ofensiva Vermelha caiu para <=50% do nível inicial
 *                    (proxy de dissuasão / culminância da ofensiva Vermelha)
 *   atrito_azul    — atrito sofrido pelo Azul (M Dsp — pontos de stayingPower perdidos)
 */

const { FPSO_UNIT_IDS, PORT_UNIT_IDS } = require('./capability_factors');

/** Sum of every weapon quantity + offensive capability value for `team`'s living units. */
function offensiveStock(state, team) {
  let total = 0;
  for (const u of state.units) {
    if (u.team !== team || u.hp <= 0) continue;
    for (const w of Object.values(u.weapons || {})) total += w.quantity || 0;
    for (const v of Object.values(u.capabilities || {})) total += v > 0 ? v : 0;
  }
  return total;
}

/** Sum of (maxHp - hp) over every unit of `team` — "atrito" inflicted on that side. */
function attrition(state, team) {
  let total = 0;
  for (const u of state.units) {
    if (u.team !== team) continue;
    total += Math.max(0, (u.maxHp || 0) - (u.hp || 0));
  }
  return total;
}

/**
 * 1 if Red's forces as a whole have been reduced to combat-ineffective
 * (no surviving Red unit retains any offensive means: attackRange, weapon
 * stock, or offensive capability), else 0. Mirrors the `!r` branch of
 * `game_engine.js#checkWinner` -- "decisive" is now defined by overall
 * reduction of Red's capability, not by the loss of any single unit.
 */
function redForceCombatIneffective(state) {
  const hasOffense = u => Object.values(u.attackRange || {}).some(v => v > 0) || Object.values(u.weapons || {}).some(w => w.quantity > 0) || Object.values(u.capabilities || {}).some(v => v > 0);
  const r = state.units.some(u => u.team === 'red' && u.hp > 0 && hasOffense(u));
  return r ? 0 : 1;
}

/** Sum of remaining hp across the FPSO units (E2_vp — infraestrutura crítica preservada). */
function fpsoValuePreserved(state) {
  let total = 0;
  for (const id of FPSO_UNIT_IDS) {
    const u = state.units.find(x => x.id === id);
    if (u) total += Math.max(0, u.hp || 0);
  }
  return total;
}

/** [0,1] ratio of remaining hp / maxHp summed across the port units (E2_sloc). */
function slocSecurityIndex(state) {
  let hp = 0, maxHp = 0;
  for (const id of PORT_UNIT_IDS) {
    const u = state.units.find(x => x.id === id);
    if (!u) continue;
    hp += Math.max(0, u.hp || 0);
    maxHp += u.maxHp || 0;
  }
  return maxHp > 0 ? hp / maxHp : null;
}

/**
 * Tracks the Red culmination turn (E3_culminancia): the first turn at which
 * Red's total offensive stock falls to <= 50% of its turn-1 baseline.
 * Call `update(state)` once per turn (after combat resolution); read
 * `.turn` at the end of the run (null if culmination never occurred).
 */
function createCulminationTracker() {
  let baseline = null;
  let culminationTurn = null;
  return {
    update(state) {
      const stock = offensiveStock(state, 'red');
      if (baseline === null) baseline = stock;
      if (culminationTurn === null && baseline > 0 && stock <= baseline * 0.5) {
        culminationTurn = state.turn;
      }
    },
    get turn() { return culminationTurn; },
  };
}

/**
 * Final dataset row metrics for one game. `culminationTurn` should come
 * from a createCulminationTracker() updated throughout the run.
 */
function computeFinalMetrics(state, culminationTurn) {
  return {
    E1_atrito: attrition(state, 'red'),
    E1_kcv: redForceCombatIneffective(state),
    E2_vp: fpsoValuePreserved(state),
    E2_sloc: slocSecurityIndex(state),
    E3_culminancia: culminationTurn,
    atrito_azul: attrition(state, 'blue'),
  };
}

module.exports = {
  offensiveStock,
  attrition,
  redForceCombatIneffective,
  fpsoValuePreserved,
  slocSecurityIndex,
  createCulminationTracker,
  computeFinalMetrics,
};
