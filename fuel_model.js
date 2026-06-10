'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────────
const FUEL_TURN_LIMIT = 4;            // max FP a naval unit may spend per turn

const NAVAL_FP = {
  surface:   12,  // fallback for unlisted surface units
  submarine: 20,  // 20 turns = 10 days at 2 turns/day (conventional AIP)
};

// Per-unit FP overrides (surface ships only; subs use NAVAL_FP.submarine)
const UNIT_FP = {
  // ── Força Azul ────────────────────────────────────────────────────────────────────────
  'BLUE-SAG-P':   12,   // SAG Principal
  'BLUE-SAG-S1':  10,   // SAG-1 (Tamandaré)
  'BLUE-SAG-S2':  10,   // SAG-2 (Tamandaré+Barroso)
  'BLUE-ANFIB':    8,   // Força de Desembarque
  'BLUE-LOG-A':   30,   // Navio Apoio Logístico
  'BLUE-LOG-T':   40,   // Navio Tanque
  'BLUE-PAT-O1':  10,   // Patrulha Oceânica 1
  'BLUE-PAT-O2':  10,   // Patrulha Oceânica 2
  'BLUE-PAT-C1':   6,   // Patrulha Costeira 1
  'BLUE-PAT-C2':   6,   // Patrulha Costeira 2
  // ── Força Vermelha ──────────────────────────────────────────────────────────────────
  // RED-GBPA is nuclear-exempt — no FP entry needed
  'RED-GE-1':     12,   // Escolta CSG (CG+2DDG)
  'RED-GE-2':     12,   // SAG-1 (DDG+2FFG)
  'RED-GE-3':     10,   // SAG-2 (3 FFG)
  'RED-AOR-G':    24,   // Petroleiro CSG
  'RED-GANF':     12,   // Grupo Anfíbio
  'RED-GLOG':     30,   // Grupo Logístico (AOR+AOT)
  'RED-AKE':       8,   // Navio Munições
};

// unit.type values (from COMP_DISPLAY_TYPE in server.js)
const NUCLEAR_SUB_TYPE    = 'sub_nuclear';
const RED_NUCLEAR_CARRIER = 'RED-GBPA';   // by unit ID

// ─── Classification ─────────────────────────────────────────────────────────────────────
function isNuclearSub(unit)     { return unit.category === 'submarine' && unit.type === NUCLEAR_SUB_TYPE; }
function isRedNucCarrier(unit)  { return unit.id === RED_NUCLEAR_CARRIER; }
function isConventionalSub(unit){ return unit.category === 'submarine' && !isNuclearSub(unit); }
function isTanker(unit)         { return unit.type === 'tanque'; }
function isLogistics(unit)      { return unit.type === 'logistico'; }
function isPort(unit)           { return unit.type === 'porto'; }

// Can this naval/sub unit refuel other naval units when stacked?
function isNavalRefuelProvider(unit) {
  return (unit.hp ?? 0) > 0 && (isTanker(unit) || isLogistics(unit) || isPort(unit));
}

// Does this unit consume naval FP?
function usesNavalFuel(unit) {
  if (isRedNucCarrier(unit) || isNuclearSub(unit)) return false;
  if (unit.type === 'fpso') return false;          // fixed offshore platform
  if (unit.category === 'surface') return true;
  return isConventionalSub(unit);
}

// ─── Initialization ──────────────────────────────────────────────────────────────────────
function initializeFuel(unit) {
  if (unit.category === 'air') {
    unit.airStatus = 'ready';     // ready | airborne
    unit.fuel = {
      usesFuel: true,
      fuelType: 'air',
      current:  unit.movement ?? 0,
      max:      unit.movement ?? 0,
      wasAtRefuelLocation: false,
    };
    return;
  }

  if (!usesNavalFuel(unit)) {
    unit.fuel = { usesFuel: false, fuelType: 'none' };
    return;
  }

  const max = isConventionalSub(unit)
    ? NAVAL_FP.submarine
    : (UNIT_FP[unit.id] ?? NAVAL_FP.surface);
  unit.fuel = {
    usesFuel: true,
    fuelType: 'naval',
    current:  max,
    max,
    spentThisTurn: 0,
    wasStackedWithRefuelProvider: false,
  };
}

// ─── Fuel-state queries ──────────────────────────────────────────────────────────────────
function isFuelDisabled(unit) {
  return unit.fuel?.fuelType === 'naval' && (unit.fuel.current ?? 1) <= 0;
}

// Naval units with 0 FP can't move, attack or defend.
// Air: only 'recovering' aircraft can't attack.
function canMove(unit)   { return !isFuelDisabled(unit); }
function canAttack(unit) {
  if (unit.category === 'air') return true;
  return !isFuelDisabled(unit);
}
function canDefend(unit) {
  if (unit.category === 'air') return true;
  return !isFuelDisabled(unit);
}

// ─── Naval fuel spending ───────────────────────────────────────────────────────────────────
// Returns FP cost for a naval unit given movement distance.
function navalMoveCost(distance) {
  if (distance === 0) return 1;   // stationary / holding position
  if (distance >= 3)  return 3;
  return distance;                // 1 or 2
}

function spendNavalFuel(unit, amount) {
  if (!unit.fuel?.usesFuel || unit.fuel.fuelType !== 'naval') return;
  const cap     = Math.max(0, FUEL_TURN_LIMIT - (unit.fuel.spentThisTurn || 0));
  const actual  = Math.min(amount, cap, unit.fuel.current ?? 0);
  unit.fuel.current      = Math.max(0, (unit.fuel.current ?? 0) - actual);
  unit.fuel.spentThisTurn = (unit.fuel.spentThisTurn || 0) + actual;
}

// ─── Air fuel spending ──────────────────────────────────────────────────────────────────
// Only airborne aircraft burn FP.
function spendAirFuel(unit, amount) {
  if (unit.category !== 'air' || unit.airStatus !== 'airborne') return;
  unit.fuel.current = Math.max(0, (unit.fuel.current ?? 0) - amount);
}

// ─── Convenience wrappers used in server.js ───────────────────────────────────────────────────────
function spendEngagementFuel(unit) {
  if (unit.category === 'air') { spendAirFuel(unit, 1); return; }
  spendNavalFuel(unit, 1);
}

function spendDamageFuel(unit) {
  if (unit.category === 'air') { spendAirFuel(unit, 1); return; }
  spendNavalFuel(unit, 1);
}

// ─── Stacking / refuel (naval) ─────────────────────────────────────────────────────────────────
function hasRefuelProvider(unit, allUnits) {
  return allUnits.some(o =>
    o.id !== unit.id && o.team === unit.team &&
    o.col === unit.col && o.row === unit.row &&
    isNavalRefuelProvider(o)
  );
}

// Called at the START of each turn; records whether each naval unit is
// currently stacked with a refuel provider.
function markRefuelEligibility(state) {
  for (const u of state.units) {
    if (u.fuel?.fuelType !== 'naval') continue;
    u.fuel.wasStackedWithRefuelProvider = hasRefuelProvider(u, state.units);
  }
}

// Called at the END of each turn (before the next turn begins).
// A naval unit is refuelled if it was stacked with a provider at the
// START of the turn AND is still stacked with one NOW.
function recoverNavalFuel(state) {
  const reports = [];
  for (const u of state.units) {
    if ((u.hp ?? 0) <= 0 || u.fuel?.fuelType !== 'naval') continue;
    if (!u.fuel.wasStackedWithRefuelProvider) continue;
    if (!hasRefuelProvider(u, state.units)) continue;
    if ((u.fuel.current ?? 0) >= u.fuel.max) continue;
    const before = u.fuel.current;
    u.fuel.current = u.fuel.max;
    reports.push({ unit: u, recovered: u.fuel.max - before });
  }
  return reports;
}

// ─── End-of-movement-phase checks ────────────────────────────────────────────────────────────
// Returns naval units that are at 0 FP (need alerting).
function checkNavalFuelZero(state) {
  return state.units.filter(u =>
    (u.hp ?? 0) > 0 && u.fuel?.fuelType === 'naval' && (u.fuel.current ?? 1) <= 0
  );
}

// Airborne aircraft with 0 FP that didn't reach a base are lost (hp → 0).
function checkAirFuelLosses(state) {
  const lost = [];
  for (const u of state.units) {
    if ((u.hp ?? 0) <= 0 || u.category !== 'air') continue;
    if (u.airStatus !== 'airborne') continue;
    if (u.fuel?.wasAtRefuelLocation) continue;   // made it back safely
    if ((u.fuel?.current ?? 1) <= 0) {
      u.hp = 0;
      lost.push(u);
    }
  }
  return lost;
}

// ─── Turn transition ───────────────────────────────────────────────────────────────────────
// Aircraft that ended their turn at a base → 'ready' (full fuel); called at turn start.
// Weapon restoration is done in server.js nextTurn using the same flag.
function recoverAircraft(state) {
  for (const u of state.units) {
    if (u.category !== 'air' || !u.fuel?.wasAtRefuelLocation) continue;
    u.airStatus               = 'ready';
    u.fuel.current            = u.fuel.max;
    u.fuel.wasAtRefuelLocation = false;
  }
}

function resetFuelTurnCounters(state) {
  for (const u of state.units) {
    if (u.fuel?.spentThisTurn !== undefined) u.fuel.spentThisTurn = 0;
  }
}

module.exports = {
  initializeFuel,
  usesNavalFuel,
  isNavalRefuelProvider,
  isFuelDisabled,
  canMove,
  canAttack,
  canDefend,
  navalMoveCost,
  spendNavalFuel,
  spendAirFuel,
  spendEngagementFuel,
  spendDamageFuel,
  hasRefuelProvider,
  markRefuelEligibility,
  recoverNavalFuel,
  checkNavalFuelZero,
  checkAirFuelLosses,
  recoverAircraft,
  resetFuelTurnCounters,
  FUEL_TURN_LIMIT,
};
