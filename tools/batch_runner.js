#!/usr/bin/env node
'use strict';

/**
 * batch_runner.js
 * ===============
 *
 * Constructive/batch mode for the PBC capability-comparison study
 * (Briefing §2/§11 fase 3-4, Projeto v3.0 §2.4-2.6, matriz_fatorial_2a5.xlsx).
 *
 * For each (condition, replica/seed), plays a full headless game between
 * two instances of shared/bot/decision_engine.js (one per side), driven by
 * shared/game_engine.js (the same state machine used by server.js), with
 * the Blue order of battle adjusted per the 5 capability factors
 * (shared/capability_factors.js). At game end, records the E1/E2/E3 + M Dsp
 * dataset row (shared/metrics.js) to a CSV matching the Coleta_Fatorial /
 * Coleta_Ablacao sheets of matriz_fatorial_2a5.xlsx.
 *
 * Usage:
 *   node tools/batch_runner.js --bloco fatorial  [--cond Cond_05] [--replicas N] [--out path] [--maxTurns N]
 *   node tools/batch_runner.js --bloco ablacao   [--cond C2]      [--replicas N] [--out path] [--maxTurns N]
 *
 * `--cond` restricts to a single condition (default: all conditions in the
 * block). `--replicas` overrides the number of replicas/seeds per condition
 * (default: 20 for fatorial / 50 for ablacao, per the seed protocol).
 * `--maxTurns` caps the number of day-turns per game (default 30; a game
 * that reaches the cap ends "censored" — E3_culminancia may be null and
 * state.winner is null).
 */

const fs = require('fs');
const path = require('path');

const { ORDER_OF_BATTLE } = require('../shared/order_of_battle');
const { applyCapabilityConfig, FACTOR_KEYS } = require('../shared/capability_factors');
const GE = require('../shared/game_engine');
const { decideMovement, decideAttacks } = require('../shared/bot/decision_engine');
const { mulberry32 } = require('../shared/rng');
const { createCulminationTracker, computeFinalMetrics } = require('../shared/metrics');
const { FACTORIAL_CONDITIONS, ABLATION_CONDITIONS } = require('./conditions');

function parseArgs(argv) {
  const args = { bloco: 'fatorial', maxTurns: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bloco') args.bloco = argv[++i];
    else if (a === '--cond') args.cond = argv[++i];
    else if (a === '--replicas') args.replicas = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--maxTurns') args.maxTurns = Number(argv[++i]);
  }
  return args;
}

/**
 * Plays one full headless game for the given capability `factors` and
 * deterministic `seed`. Mirrors the interactive turn cycle in server.js
 * (movement -> movement_approval -> combat -> combat_approval -> nextTurn),
 * with both sides driven by shared/bot/decision_engine.js and no
 * facilitator overrides.
 *
 * @param {object} factors  { A_SSN, B_SSK, C_Azuis, D_MSS, E_Terra } -> +1/-1
 * @param {number} seed     recorded alongside the result for reproducibility
 * @param {number} maxTurns day-turn cap before the game is "censored"
 * @returns {{ state: object, winner: string|null, metrics: object }}
 */
function runGame(factors, seed, maxTurns) {
  const customOB = applyCapabilityConfig(ORDER_OF_BATTLE, factors);
  const state = GE.newGame(customOB);
  // Reserved for stochastic tie-breaking in future bot policies; recorded
  // for reproducibility even though the current policies are deterministic.
  // eslint-disable-next-line no-unused-vars
  const rng = mulberry32(seed);

  const culmination = createCulminationTracker();
  culmination.update(state);

  const maxPhases = maxTurns * 2; // day + night per turn
  let winner = null;
  for (let phase = 0; phase < maxPhases && !winner; phase++) {
    // ─ Movement ─
    const blueMoves = decideMovement(GE.stateFor(state, 'blue'), 'blue');
    const redMoves = decideMovement(GE.stateFor(state, 'red'), 'red');
    GE.applyMoves(state, 'blue', blueMoves);
    GE.applyMoves(state, 'red', redMoves);
    GE.finalizeMovementPhase(state);
    GE.applyMovementApproval(state, []);

    // ─ Combat ─
    state.blueAttacks = decideAttacks(GE.stateFor(state, 'blue'), 'blue');
    state.redAttacks = decideAttacks(GE.stateFor(state, 'red'), 'red');
    state.combatQueue = GE.buildCombatQueue(state);
    GE.resolveCombatQueue(state);

    let result = GE.finishCombatPhase(state);
    winner = result.winner;
    if (!winner) {
      result = GE.applyCombatApproval(state, []);
      winner = result.winner;
    }
    culmination.update(state);
  }

  const metrics = computeFinalMetrics(state, culmination.turn);
  return { state, winner, metrics };
}

const CSV_COLUMNS_FATORIAL = ['ID', 'Cond', 'Replica', 'Semente',
  ...FACTOR_KEYS, 'n_capacidades', 'custo_total',
  'E1_atrito', 'E1_kcv', 'E2_vp', 'E2_sloc', 'E3_culminancia', 'atrito_azul', 'vencedor'];

const CSV_COLUMNS_ABLACAO = ['ID', 'Cond_Abl', 'Capacidade_removida', 'Replica', 'Semente',
  ...FACTOR_KEYS, 'n_capacidades', 'custo_total',
  'E1_atrito', 'E1_kcv', 'E2_vp', 'E2_sloc', 'E3_culminancia', 'atrito_azul', 'vencedor'];

function fmt(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
  return String(v);
}

function writeCsv(outPath, columns, rows) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map(c => fmt(row[c])).join(','));
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const isFactorial = args.bloco === 'fatorial';
  const allConditions = isFactorial ? FACTORIAL_CONDITIONS : ABLATION_CONDITIONS;
  const conditions = args.cond ? allConditions.filter(c => c.condicao === args.cond) : allConditions;
  if (conditions.length === 0) {
    console.error(`Condição não encontrada: ${args.cond} (bloco=${args.bloco})`);
    process.exit(1);
  }

  const rows = [];
  for (const cond of conditions) {
    const seeds = args.replicas ? cond.seeds.slice(0, args.replicas) : cond.seeds;
    seeds.forEach((seed, idx) => {
      const replica = idx + 1;
      const { winner, metrics } = runGame(cond.factors, seed, args.maxTurns);
      const row = {
        ID: isFactorial ? `FAT-${cond.condicao}-R${String(replica).padStart(2, '0')}` : `ABL-${cond.condicao}-R${String(replica).padStart(2, '0')}`,
        Replica: replica,
        Semente: seed,
        n_capacidades: cond.n_capacidades,
        custo_total: cond.custo_total,
        ...metrics,
        vencedor: winner || 'censurado',
      };
      for (const key of FACTOR_KEYS) row[key] = cond.factors[key];
      if (isFactorial) row.Cond = cond.condicao;
      else { row.Cond_Abl = cond.condicao; row.Capacidade_removida = cond.capacidade_removida || ''; }
      rows.push(row);
      console.log(`${row.ID}: vencedor=${row.vencedor} E1_atrito=${fmt(metrics.E1_atrito)} E1_kcv=${metrics.E1_kcv} E2_vp=${fmt(metrics.E2_vp)} E2_sloc=${fmt(metrics.E2_sloc)} E3_culminancia=${metrics.E3_culminancia} atrito_azul=${fmt(metrics.atrito_azul)}`);
    });
  }

  const defaultOut = isFactorial ? 'output/coleta_fatorial.csv' : 'output/coleta_ablacao.csv';
  const outPath = path.resolve(__dirname, '..', args.out || defaultOut);
  writeCsv(outPath, isFactorial ? CSV_COLUMNS_FATORIAL : CSV_COLUMNS_ABLACAO, rows);
  console.log(`\n${rows.length} jogo(s) registrados em ${outPath}`);
}

if (require.main === module) main();

module.exports = { runGame };
