'use strict';

// P1 tests: bot decision noise (seedless = deterministic, seeded = reproducible
// and varying), parametric reload doctrine, and end-to-end pipeline determinism
// / variance through the real order of battle.

const test = require('node:test');
const assert = require('node:assert/strict');

const GE = require('../game_engine');
const { decideMovement, decideAttacks } = require('../bot/decision_engine');
const { createCulminationTracker, computeFinalMetrics } = require('../metrics');
const { ORDER_OF_BATTLE } = require('../order_of_battle');

// ── Bot decision noise ──────────────────────────────────────────────────────

function twoTargetOB() {
  const surface = (id, col, row, extra = {}) => ({
    id, name: id, category: 'surface', composition: [], stayingPower: 10, movement: 0,
    detectionRange: { surface: 8, air: 2, submarine: 1, land: 1 },
    attackRange: { surface: 6, air: 1, submarine: 1, land: 1 },
    weapons: { ascm: { quantity: 4, range: 6 } }, capabilities: {}, position: { col, row }, ...extra,
  });
  return { forces: {
    blue: [surface('B1', 0, 4)],
    // Two identical, equidistant Red targets -> tie broken only by jitter.
    red: [surface('R1', 2, 3), surface('R2', 2, 5)],
  } };
}

test('bots are deterministic without a seed', () => {
  const s = GE.newGame(twoTargetOB());
  const a = decideAttacks(GE.stateFor(s, 'blue'), 'blue');
  const b = decideAttacks(GE.stateFor(s, 'blue'), 'blue');
  assert.deepStrictEqual(a, b);
  assert.equal(a.length, 1);
});

test('seeded bot noise is reproducible and can vary the chosen target', () => {
  const pick = seed => {
    const s = GE.newGame(twoTargetOB(), { seed });
    return decideAttacks(GE.stateFor(s, 'blue'), 'blue')[0].targetId;
  };
  assert.equal(pick(42), pick(42), 'same seed -> same choice');

  const chosen = new Set(Array.from({ length: 40 }, (_, i) => pick(1000 + i)));
  assert.ok(chosen.size > 1, `expected target choice to vary across seeds, got ${[...chosen]}`);
});

// ── Reload doctrine ─────────────────────────────────────────────────────────

function redPortOB() {
  return { forces: {
    blue: [],
    red: [
      { id: 'R1', name: 'R1', category: 'surface', composition: [], stayingPower: 10, movement: 0,
        detectionRange: {}, attackRange: {}, weapons: { ascm: { quantity: 4, range: 6 } },
        capabilities: {}, position: { col: 5, row: 5 } },
      { id: 'RPORT', name: 'RPORT', category: 'surface', composition: [{ type: 'porto' }], stayingPower: 20,
        movement: 0, detectionRange: {}, attackRange: {}, weapons: {}, capabilities: {}, position: { col: 5, row: 5 } },
    ],
  } };
}

function reloadOutcome(doctrine) {
  const s = GE.newGame(redPortOB(), doctrine ? { reloadDoctrine: doctrine } : {});
  const r1 = s.units.find(u => u.id === 'R1');
  r1.weapons.ascm.quantity = 1; // simulate a partially spent magazine
  GE.nextTurn(s);
  return s.units.find(u => u.id === 'R1').weapons.ascm.quantity;
}

test('reload doctrine: baseline keeps Red surface from reloading; symmetric restores it at a Red port', () => {
  assert.equal(reloadOutcome('baseline'), 1, 'baseline: Red surface never reloads');
  assert.equal(reloadOutcome(undefined), 1, 'default doctrine == baseline');
  assert.equal(reloadOutcome('symmetric'), 4, 'symmetric: Red surface reloads stationary on a Red port');
});

// ── End-to-end pipeline ─────────────────────────────────────────────────────

function playGame(seed, maxTurns = 8) {
  const s = GE.newGame(ORDER_OF_BATTLE, seed != null ? { seed } : {});
  const trk = createCulminationTracker();
  trk.update(s);
  for (let p = 0; p < maxTurns * 2 && !s.winner; p++) {
    GE.applyMoves(s, 'blue', decideMovement(GE.stateFor(s, 'blue'), 'blue'));
    GE.applyMoves(s, 'red', decideMovement(GE.stateFor(s, 'red'), 'red'));
    GE.finalizeMovementPhase(s);
    GE.applyMovementApproval(s, []);
    s.blueAttacks = decideAttacks(GE.stateFor(s, 'blue'), 'blue');
    s.redAttacks = decideAttacks(GE.stateFor(s, 'red'), 'red');
    s.combatQueue = GE.buildCombatQueue(s);
    GE.resolveCombatQueue(s);
    const r = GE.finishCombatPhase(s);
    if (!r.winner) GE.applyCombatApproval(s, []);
    trk.update(s);
  }
  return computeFinalMetrics(s, trk.turn);
}

test('end-to-end: same seed reproduces identical metrics', () => {
  assert.deepStrictEqual(playGame(2024), playGame(2024));
});

test('end-to-end: seedless run is fully deterministic', () => {
  assert.deepStrictEqual(playGame(null), playGame(null));
});

test('end-to-end: different seeds produce varying attrition', () => {
  const vals = Array.from({ length: 10 }, (_, i) => playGame(500 + i).E1_atrito);
  assert.ok(new Set(vals).size > 1, `expected E1_atrito to vary across seeds, got ${vals}`);
});
