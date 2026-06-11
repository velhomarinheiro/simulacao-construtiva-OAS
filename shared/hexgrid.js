'use strict';

/**
 * hexgrid.js
 * ==========
 *
 * Canonical hex-grid geometry and terrain model for the 16x10 odd-q
 * offset map, shared between server.js and the bot/decision-engine
 * modules (shared/bot/*). Extracted from server.js so both the
 * authoritative game loop and the digital-player AI agree on distances,
 * neighbors and terrain passability.
 */

const GRID_W = 16;
const GRID_H = 10;

const T_LAND = 0, T_SHALLOW = 1, T_SHELF = 2, T_DEEP = 3, T_OIL = 4;

const TERRAIN_MAP = [
  [0,0,0,0,0,0,1,2,3,3,3,3,3,3,3,3],
  [0,0,0,0,0,1,1,2,3,3,3,3,3,3,3,3],
  [0,0,0,0,1,1,2,4,3,3,3,3,3,3,3,3],
  [0,0,0,1,1,2,4,4,3,3,3,3,3,3,3,3],
  [0,0,1,1,2,4,4,2,3,3,3,3,3,3,3,3],
  [0,1,1,2,4,4,2,3,3,3,3,3,3,3,3,3],
  [1,1,2,4,4,2,3,3,3,3,3,3,3,3,3,3],
  [1,2,2,4,2,2,3,3,3,3,3,3,3,3,3,3],
  [1,2,2,2,2,3,3,3,3,3,3,3,3,3,3,3],
  [1,2,2,2,3,3,3,3,3,3,3,3,3,3,3,3],
];

function getTerrain(col, row) {
  if (row < 0 || row >= GRID_H || col < 0 || col >= GRID_W) return T_LAND;
  return TERRAIN_MAP[row][col];
}

function canEnterTerrain(category, terrain) {
  if (category === 'air' || category === 'neutral_air') return true;
  if (category === 'land') return terrain === T_LAND || terrain === T_SHALLOW;
  if (category === 'submarine') return terrain !== T_LAND && terrain !== T_SHALLOW;
  return terrain !== T_LAND; // surface
}

function rangeAgainst(t, cat) {
  if (!t) return 0;
  return Number(t[cat] || 0);
}

// ─── Hex math (odd-q offset <-> cube) ─────────────────────────────────────────
function oddqToCube(col, row) {
  const x = col;
  const z = row - (col - (col & 1)) / 2;
  return { x, y: -x - z, z };
}
function cubeToOddq(x, z) {
  return { col: x, row: z + (x - (x & 1)) / 2 };
}

const CUBE_DIRS = [
  { dx: +1, dy: -1, dz: 0 },
  { dx: +1, dy: 0, dz: -1 },
  { dx: 0, dy: +1, dz: -1 },
  { dx: -1, dy: +1, dz: 0 },
  { dx: -1, dy: 0, dz: +1 },
  { dx: 0, dy: -1, dz: +1 },
];

function hexNeighbors(col, row) {
  const c = oddqToCube(col, row);
  return CUBE_DIRS
    .map(d => cubeToOddq(c.x + d.dx, c.z + d.dz))
    .filter(({ col: nc, row: nr }) => nc >= 0 && nc < GRID_W && nr >= 0 && nr < GRID_H);
}

function hexDist(c1, r1, c2, r2) {
  const a = oddqToCube(c1, r1);
  const b = oddqToCube(c2, r2);
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
}

module.exports = {
  GRID_W, GRID_H,
  T_LAND, T_SHALLOW, T_SHELF, T_DEEP, T_OIL,
  TERRAIN_MAP,
  getTerrain,
  canEnterTerrain,
  rangeAgainst,
  oddqToCube,
  cubeToOddq,
  hexNeighbors,
  hexDist,
};
