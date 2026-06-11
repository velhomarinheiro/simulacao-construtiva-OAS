'use strict';

/**
 * game_engine.js
 * ==============
 *
 * Headless (no Socket.io / no I/O) game-state engine shared by:
 *   - server.js          (interactive multiplayer mode, wraps these
 *                          functions with Socket.io broadcasts/approvals)
 *   - tools/batch_runner.js (constructive/batch mode for the PBC
 *                          capability-comparison study, drives both sides
 *                          with shared/bot/decision_engine.js)
 *
 * All functions here are pure state transitions over the `state` object
 * produced by newGame(); none of them touch the network.
 */

const { ORDER_OF_BATTLE } = require('./order_of_battle');
const { COMBAT_CONFIG } = require('./combat_config');
const { resolveEngagement, getWeaponQuantity, getWeaponRange } = require('./combat_engine');
const {
  initializeFuel, isFuelDisabled,
  navalMoveCost, spendNavalFuel, spendAirFuel,
  spendEngagementFuel, spendDamageFuel,
  markRefuelEligibility, recoverNavalFuel,
  checkNavalFuelZero, checkAirFuelLosses,
  recoverAircraft, resetFuelTurnCounters,
} = require('../fuel_model');
const {
  GRID_W, GRID_H, T_DEEP,
  getTerrain, canEnterTerrain, rangeAgainst, hexDist,
} = require('./hexgrid');

// ─── Display type mapping ─────────────────────────────────────────────────────
const COMP_DISPLAY_TYPE = {
  'navio_aeródromo': 'carrier', 'navio_doca': 'amphib', 'navio_desembarque': 'amphib',
  'fragata': 'fragata', 'corveta': 'corveta', 'destroier': 'destroier', 'destroyer': 'destroier',
  'cruzador': 'cruzador', 'navio_patoc': 'patrulha_oc', 'navio_patrulha': 'patrulha_c',
  'navio_logistico': 'logistico', 'navio_tanque': 'tanque', 'submarino_nuclear': 'sub_nuclear',
  'submarino_convencional': 'submarino', 'patrulha_maritima': 'patrulha', 'caca': 'caca',
  'ataque': 'ataque', 'aew': 'aew', 'helicoptero_ASW': 'helicoptero', 'helicoptero_ASup': 'helicoptero',
  'bateria_costeira': 'bateria_costeira', 'bateria_ada': 'bateria_ada', 'base_naval': 'bateria_ada',
  'plataforma': 'fpso', 'porto': 'porto', 'aeroporto': 'aeroporto',
  'navio_mercante': 'logistico', 'apoio_offshore': 'logistico', 'barco_pesqueiro': 'patrulha_c',
  'veleiro': 'patrulha_c', 'helicoptero_transporte': 'helicoptero', 'aviacao_civil': 'patrulha',
};
const DISPLAY_TYPE_FALLBACK = { surface: 'fragata', submarine: 'submarino', air: 'patrulha', land: 'corveta', neutral: 'logistico' };

// ─── Air refuel ───────────────────────────────────────────────────────────────
function isAirRefuelLocation(unit, state) {
  return state.units.some(o => o.id !== unit.id && o.team === unit.team && (o.hp ?? 0) > 0 && (o.type === 'aeroporto' || o.type === 'carrier') && o.col === unit.col && o.row === unit.row);
}

// ─── Fog of war ───────────────────────────────────────────────────────────────
function saveMovementSnapshot(state) {
  state.movementSnapshot = {};
  for (const u of state.units) state.movementSnapshot[u.id] = { col: u.col, row: u.row };
}

function stateFor(state, role) {
  if (role === 'facilitator') {
    const { combatQueue: _cq, ...rest } = state;
    return { ...rest, isFacilitator: true };
  }
  const team = role;
  const night = state.period === 'night';
  const { combatQueue: _cq, ...stateRest } = state;

  const neutralUnits = state.units.filter(u => u.team === 'neutral' && u.hp > 0);
  const enemyActual = state.units.filter(u => u.team !== team && u.team !== 'neutral' && u.hp > 0);
  const enemies = (state.phase === 'movement' && state.movementSnapshot)
    ? enemyActual.map(u => { const snap = state.movementSnapshot[u.id]; return snap ? { ...u, col: snap.col, row: snap.row } : u; })
    : enemyActual;
  const mine = state.units.filter(u => u.team === team && u.hp > 0);
  const mineForDetection = (state.phase === 'movement' && state.movementSnapshot)
    ? mine.map(u => { const snap = state.movementSnapshot[u.id]; return snap ? { ...u, col: snap.col, row: snap.row } : u; })
    : mine;

  const detected = enemies.filter(enemy => {
    const stealthy = !!enemy.stealthy;
    const deepBonus = getTerrain(enemy.col, enemy.row) === T_DEEP ? 1 : 0;
    return mineForDetection.some(f => {
      let range = stealthy ? rangeAgainst(f.detectionRange, 'submarine') - deepBonus : rangeAgainst(f.detectionRange, enemy.category);
      if (night && f.category !== 'submarine') range -= stealthy ? 1 : 2;
      return range >= 1 && hexDist(f.col, f.row, enemy.col, enemy.row) <= range;
    });
  }).map(e => ({ ...e, detected: true }));

  return {
    ...stateRest,
    units: [...mine, ...detected, ...neutralUnits],
    blueAttacks: team === 'blue' ? state.blueAttacks : (state.blueAttacks !== null ? '✓' : null),
    redAttacks: team === 'red' ? state.redAttacks : (state.redAttacks !== null ? '✓' : null),
    isFacilitator: false,
  };
}

// ─── Weapon priority / combat helpers ────────────────────────────────────────
const WEAPON_PRIORITY = {
  surface: ['ascm', 'asbm', 'mss', 'torpedo', 'airAttack', 'navalGun'],
  submarine: ['asw', 'torpedo'],
  air: ['airDefense', 'airAttack'],
  land: ['lacm', 'airAttack', 'navalGun'],
};
function selectBestWeapon(attacker, target, dist) {
  const priority = WEAPON_PRIORITY[target.category] || [];
  for (const wpnType of priority) {
    const qty = getWeaponQuantity(attacker, wpnType);
    if (qty <= 0) continue;
    const profile = COMBAT_CONFIG.weaponProfiles?.[wpnType];
    if (!profile) continue;
    if (!profile.targets.includes(target.category)) continue;
    const range = getWeaponRange(attacker, wpnType);
    if (dist <= range) return wpnType;
  }
  return null;
}

// ─── Unit factory ─────────────────────────────────────────────────────────────
function makeUnit(team, spec) {
  const pos = spec.position || spec.start || { col: 0, row: 0 };
  const weapons = spec.weapons ? JSON.parse(JSON.stringify(spec.weapons)) : {};
  const unit = {
    id: spec.id, team, name: spec.name, category: spec.category,
    type: (spec.composition && spec.composition[0] && COMP_DISPLAY_TYPE[spec.composition[0].type]) || DISPLAY_TYPE_FALLBACK[spec.category] || 'fragata',
    composition: spec.composition || [], movement: spec.movement,
    detectionRange: spec.detectionRange, attackRange: spec.attackRange,
    col: pos.col, row: pos.row, hp: spec.stayingPower, maxHp: spec.stayingPower,
    stealthy: spec.category === 'submarine', moved: false, weapons,
    initWeapons: JSON.parse(JSON.stringify(weapons)),
    capabilities: spec.capabilities ? { ...spec.capabilities } : {},
    notes: spec.notes || '',
  };
  initializeFuel(unit);
  return unit;
}

let _unitSeed = 1000;
function genUnitId(team) { return `${team.toUpperCase()}-FAC-${_unitSeed++}`; }

function initialUnits(customOB) {
  const ob = customOB || ORDER_OF_BATTLE;
  const units = [];
  for (const spec of (ob.forces.blue || [])) units.push(makeUnit('blue', spec));
  for (const spec of (ob.forces.red || [])) units.push(makeUnit('red', spec));
  for (const spec of (ob.forces.neutral || [])) units.push(makeUnit('neutral', spec));
  return units;
}

function newGame(customOB) {
  const state = {
    turn: 1, period: 'day', phase: 'movement',
    blueDone: false, redDone: false,
    blueAttacks: null, redAttacks: null,
    units: initialUnits(customOB),
    log: ['──── Turno 1 · Período Diurno ────', 'Fase de Movimentação iniciada.'],
    messages: [],
    winner: null,
    movementSnapshot: {},
    combatQueue: [],
  };
  saveMovementSnapshot(state);
  markRefuelEligibility(state);
  return state;
}

// ─── Movement ─────────────────────────────────────────────────────────────────

/** Validates a `commit_moves` payload for `team`. Returns {ok:true} or {ok:false, error}. */
function validateMoves(state, team, moves) {
  for (const { unitId, path } of (moves || [])) {
    if (!Array.isArray(path) || path.length < 2) continue;
    const unit = state.units.find(u => u.id === unitId && u.team === team && u.hp > 0);
    if (!unit) return { ok: false, error: `Unidade ${unitId} inválida.` };
    if (unit.movement === 0) return { ok: false, error: `${unit.name}: unidade fixa.` };
    if (isFuelDisabled(unit)) return { ok: false, error: `${unit.name}: sem combustível.` };
    if (path[0].col !== unit.col || path[0].row !== unit.row) return { ok: false, error: `Caminho inválido para ${unit.name}.` };
    if (path.length - 1 > unit.movement) return { ok: false, error: `${unit.name}: caminho excede alcance.` };
    for (let i = 1; i < path.length; i++) {
      const { col, row } = path[i];
      if (col < 0 || col >= GRID_W || row < 0 || row >= GRID_H) return { ok: false, error: `${unit.name}: fora do tabuleiro.` };
      if (hexDist(path[i - 1].col, path[i - 1].row, col, row) !== 1) return { ok: false, error: `${unit.name}: passo não adjacente.` };
      if (!canEnterTerrain(unit.category, getTerrain(col, row))) return { ok: false, error: `${unit.name}: terreno intransponível.` };
    }
  }
  return { ok: true };
}

/** Applies a validated `commit_moves` payload for `team` (movement + fuel spend), marks team done. */
function applyMoves(state, team, moves) {
  for (const { unitId, path } of (moves || [])) {
    if (!Array.isArray(path) || path.length < 2) continue;
    const unit = state.units.find(u => u.id === unitId && u.team === team && u.hp > 0);
    if (!unit) continue;
    const dest = path[path.length - 1];
    unit.col = dest.col; unit.row = dest.row; unit.moved = true;
    state.log.unshift(`${unit.name}(${team}) → ${String.fromCharCode(65 + dest.col)}${dest.row + 1}`);
    const dist = path.length - 1;
    if (unit.category !== 'air') { spendNavalFuel(unit, navalMoveCost(dist)); }
    else { unit.airStatus = 'airborne'; spendAirFuel(unit, dist); if (isAirRefuelLocation(unit, state)) unit.fuel.wasAtRefuelLocation = true; }
  }

  // Stationary fuel
  for (const u of state.units) {
    if (u.hp <= 0 || u.team !== team || u.moved) continue;
    if (u.category === 'air') {
      if (u.airStatus === 'airborne') { if (isAirRefuelLocation(u, state)) u.fuel.wasAtRefuelLocation = true; else spendAirFuel(u, 1); }
    } else { spendNavalFuel(u, navalMoveCost(0)); }
  }

  if (team === 'blue') state.blueDone = true; else state.redDone = true;
}

/** Once both sides are done moving: fuel checks + transition to movement_approval. Returns {navalEmpty, airLost}. */
function finalizeMovementPhase(state) {
  const navalEmpty = checkNavalFuelZero(state);
  for (const u of navalEmpty) state.log.unshift(`⛽ ${u.name}(${u.team}) sem combustível.`);
  const airLost = checkAirFuelLosses(state);
  for (const u of airLost) state.log.unshift(`✈ ${u.name}(${u.team}) perdida por falta de combustível.`);

  state.phase = 'movement_approval';
  state.log.unshift('Movimentos concluídos. Aguardando aprovação do Facilitador...');
  if (state.log.length > 50) state.log = state.log.slice(0, 50);
  return { navalEmpty, airLost };
}

/** Applies facilitator repositioning overrides and transitions to the combat phase. */
function applyMovementApproval(state, overrides) {
  for (const { unitId, col, row } of (overrides || [])) {
    if (col < 0 || col >= GRID_W || row < 0 || row >= GRID_H) continue;
    const unit = state.units.find(u => u.id === unitId);
    if (unit) {
      unit.col = col; unit.row = row;
      state.log.unshift(`📍 Facilitador reposicionou ${unit.name} → ${String.fromCharCode(65 + col)}${row + 1}`);
    }
  }
  state.phase = 'combat';
  state.log.unshift('Movimentos aprovados. Fase de Combate iniciada. Declare seus ataques.');
}

// ─── Combat system (resolução em pulso único pela equação de salva) ──────────
const SALVO_SIZE = { ascm: 2, mss: 2, torpedo: 1, lacm: 1, asbm: 1 };

function buildCombatQueue(state) {
  const all = [...(state.blueAttacks || []), ...(state.redAttacks || [])];
  return all.map((atk, i) => {
    const att = state.units.find(u => u.id === atk.attackerId && u.hp > 0);
    const def = state.units.find(u => u.id === atk.targetId && u.hp > 0);
    if (!att || !def) return null;
    const dist = hexDist(att.col, att.row, def.col, def.row);
    const wpnType = selectBestWeapon(att, def, dist);
    if (!wpnType) return null;
    const profile = COMBAT_CONFIG.weaponProfiles?.[wpnType];
    const qty = getWeaponQuantity(att, wpnType);
    const requested = atk.amount ?? (SALVO_SIZE[wpnType] || 1);
    const amount = profile?.expendable ? Math.min(qty, Math.max(1, requested)) : 1;
    return {
      id: `ENG-${String(i + 1).padStart(2, '0')}`, attackerId: atk.attackerId, targetId: atk.targetId,
      weaponType: wpnType, amount, status: 'pending', result: null,
    };
  }).filter(Boolean);
}

// Resolves a single declared engagement with one salvo-equation pulse and
// logs the outcome. Mutates engagement.status/result and defender.hp.
function resolveQueuedEngagement(state, engagement) {
  const att = state.units.find(u => u.id === engagement.attackerId && u.hp > 0);
  const def = state.units.find(u => u.id === engagement.targetId && u.hp > 0);
  if (!att || !def) {
    engagement.status = 'ended';
    state.log.unshift(`[${engagement.id}] Unidade destruída — engajamento cancelado.`);
    return;
  }
  if (isFuelDisabled(att)) {
    engagement.status = 'ended';
    engagement.result = { ok: false, reason: 'Atacante sem combustível' };
    state.log.unshift(`⛽ ${att.name} sem combustível — engajamento cancelado.`);
    return;
  }

  state.log.unshift(`──── ${engagement.id} ────`);
  const dist = hexDist(att.col, att.row, def.col, def.row);
  const eng = resolveEngagement({
    attacker: att, defender: def, weaponType: engagement.weaponType,
    amount: engagement.amount, distance: dist, defenderDisabled: isFuelDisabled(def),
  });

  if (!eng.ok) {
    state.log.unshift(`⚠ ${att.name} → ${def.name}: ${eng.reason}`);
  } else {
    spendEngagementFuel(att);
    const interceptStr = eng.interception.pDefenseTotal > 0
      ? ` (interceptação −${eng.interception.pDefenseTotal.toFixed(2)})` : '';
    if (eng.destroyed) {
      state.log.unshift(`💥 ${def.name} DESTRUÍDO por ${att.name} [${eng.weaponLabel}]`);
    } else if (eng.expectedLoss > 1e-3) {
      state.log.unshift(`✓ ${att.name} → ${def.name} −${eng.expectedLoss.toFixed(2)}SP [${eng.weaponLabel}${interceptStr}]`);
      spendDamageFuel(def);
    } else {
      state.log.unshift(`✗ ${att.name} → ${def.name} sem efeito [${eng.weaponLabel}${interceptStr}]`);
    }
  }
  if (state.log.length > 80) state.log = state.log.slice(0, 80);
  engagement.status = 'ended';
  engagement.result = eng;
}

/** Resolves every pending engagement in state.combatQueue (mutates state, no I/O). */
function resolveCombatQueue(state) {
  for (const engagement of state.combatQueue) resolveQueuedEngagement(state, engagement);
}

/** Ends the combat phase: checks for a winner, else moves to combat_approval. Returns {winner}. */
function finishCombatPhase(state) {
  state.log.unshift('── Fase de Combate encerrada. ──');
  state.combatQueue = [];

  const winner = checkWinner(state);
  if (winner) {
    state.winner = winner;
    state.log.unshift(`🏆 ${winner === 'blue' ? 'Força Azul' : 'Força Vermelha'} VENCEU!`);
    return { winner };
  }

  state.phase = 'combat_approval';
  state.log.unshift('Aguardando confirmação do Facilitador para o próximo turno...');
  return { winner: null };
}

/** Applies facilitator HP overrides, re-checks the winner, and (if none) advances the turn. Returns {winner}. */
function applyCombatApproval(state, hpChanges) {
  for (const { unitId, hp } of (hpChanges || [])) {
    const unit = state.units.find(u => u.id === unitId);
    if (!unit) continue;
    const oldHp = unit.hp;
    unit.hp = Math.max(0, Math.min(unit.maxHp, Number(hp) || 0));
    if (unit.hp !== oldHp) state.log.unshift(`📝 Facilitador ajustou SP de ${unit.name}: ${oldHp}→${unit.hp}`);
  }

  const winner = checkWinner(state);
  if (winner) {
    state.winner = winner;
    state.log.unshift(`🏆 ${winner === 'blue' ? 'Força Azul' : 'Força Vermelha'} VENCEU!`);
    return { winner };
  }

  nextTurn(state);
  return { winner: null };
}

/**
 * Determines the game winner, if any.
 *
 * A side loses if no surviving unit retains any offensive means
 * (attackRange, weapon stock, or offensive capability) -- i.e. its forces
 * have been rendered combat-ineffective in general. No single unit (e.g.
 * the Red carrier strike group) is special-cased.
 */
function checkWinner(state) {
  const hasOffense = u => Object.values(u.attackRange || {}).some(v => v > 0) || Object.values(u.weapons || {}).some(w => w.quantity > 0) || Object.values(u.capabilities || {}).some(v => v > 0);
  const b = state.units.some(u => u.team === 'blue' && u.hp > 0 && hasOffense(u));
  const r = state.units.some(u => u.team === 'red' && u.hp > 0 && hasOffense(u));
  if (!b) return 'red'; if (!r) return 'blue'; return null;
}

function nextTurn(state) {
  const portHexes = new Set(state.units.filter(u => u.team === 'blue' && u.hp > 0 && u.type === 'porto').map(u => `${u.col},${u.row}`));
  for (const u of state.units) {
    if (u.hp <= 0) continue;
    if (!u.initWeapons || Object.keys(u.initWeapons).length === 0) continue;
    const hexKey = `${u.col},${u.row}`;
    let reload = false;
    if (u.team === 'blue') {
      if (u.category === 'land') reload = true;
      else if (u.category === 'air') reload = u.fuel?.wasAtRefuelLocation === true;
      else if (!u.moved && (u.category === 'surface' || u.category === 'submarine')) reload = portHexes.has(hexKey);
    } else if (u.team === 'red') {
      if (u.category === 'air') reload = u.fuel?.wasAtRefuelLocation === true;
    }
    if (reload) {
      const restored = [];
      for (const [wpn, init] of Object.entries(u.initWeapons)) {
        const cur = u.weapons[wpn]?.quantity ?? 0;
        if (cur < init.quantity) { u.weapons[wpn] = { ...init }; restored.push(wpn.toUpperCase()); }
      }
      if (restored.length > 0) state.log.unshift(`🔄 ${u.name} recompletou: ${restored.join(', ')}`);
    }
  }
  const fuelReports = recoverNavalFuel(state);
  for (const { unit: u } of fuelReports) state.log.unshift(`⛽ ${u.name}(${u.team}) reabasteceu: ${u.fuel.current}/${u.fuel.max} FP.`);
  recoverAircraft(state);
  state.units.forEach(u => { u.moved = false; });
  resetFuelTurnCounters(state);
  state.period = state.period === 'day' ? 'night' : 'day';
  if (state.period === 'day') state.turn++;
  state.phase = 'movement';
  state.blueDone = state.redDone = false;
  state.blueAttacks = state.redAttacks = null;
  const per = state.period === 'day' ? 'Diurno' : 'Noturno';
  state.log.unshift(`──── Turno ${state.turn} · Período ${per} ────`);
  state.log.unshift('Fase de Movimentação iniciada.');
  if (state.log.length > 50) state.log = state.log.slice(0, 50);
  saveMovementSnapshot(state);
  markRefuelEligibility(state);
}

module.exports = {
  COMP_DISPLAY_TYPE, DISPLAY_TYPE_FALLBACK,
  isAirRefuelLocation, saveMovementSnapshot, stateFor,
  WEAPON_PRIORITY, selectBestWeapon,
  makeUnit, genUnitId, initialUnits, newGame,
  validateMoves, applyMoves, finalizeMovementPhase, applyMovementApproval,
  SALVO_SIZE, buildCombatQueue, resolveQueuedEngagement, resolveCombatQueue,
  finishCombatPhase, applyCombatApproval,
  checkWinner, nextTurn,
};
