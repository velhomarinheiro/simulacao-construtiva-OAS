'use strict';

/**
 * pathfinding.js
 * ==============
 *
 * Hex-grid route planning for the digital-player AI. Every step on the
 * 16x10 odd-q grid costs 1 (the game does not model variable terrain
 * movement cost — only passability via canEnterTerrain), so Dijkstra and
 * A* both reduce to BFS with a heuristic; A* is implemented for clarity
 * and to support future variable step costs.
 */

const { GRID_W, GRID_H, getTerrain, canEnterTerrain, hexNeighbors, hexDist } = require('../hexgrid');

/**
 * Breadth-first flood fill of every hex reachable by `unit` within
 * `maxSteps`, respecting terrain passability and other units' positions
 * (an `occupied` set of "col,row" blocks entry, e.g. enemy-occupied hexes
 * for a non-combat unit).
 *
 * @returns {Map<string,{col:number,row:number,dist:number,path:{col,row}[]}>}
 *          keyed by "col,row", including the start hex (dist 0).
 */
function reachableHexes(start, unit, { maxSteps, occupied = new Set(), terrainMap } = {}) {
  const key = (c, r) => `${c},${r}`;
  const visited = new Map();
  visited.set(key(start.col, start.row), { col: start.col, row: start.row, dist: 0, path: [{ col: start.col, row: start.row }] });

  let frontier = [start];
  for (let step = 0; step < maxSteps; step++) {
    const next = [];
    for (const cur of frontier) {
      const curEntry = visited.get(key(cur.col, cur.row));
      for (const nb of hexNeighbors(cur.col, cur.row)) {
        const k = key(nb.col, nb.row);
        if (visited.has(k)) continue;
        const terrain = terrainMap ? terrainMap[nb.row][nb.col] : getTerrain(nb.col, nb.row);
        if (!canEnterTerrain(unit.category, terrain)) continue;
        if (occupied.has(k)) continue;
        const entry = { col: nb.col, row: nb.row, dist: curEntry.dist + 1, path: [...curEntry.path, { col: nb.col, row: nb.row }] };
        visited.set(k, entry);
        next.push(nb);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return visited;
}

/**
 * A* shortest path from `start` to `goal` for `unit`, respecting terrain
 * passability. Returns the full path (including start and goal) or null
 * if unreachable. The returned path may be longer than `unit.movement` —
 * callers should slice `path.slice(0, unit.movement + 1)` to get this
 * turn's commit_moves path.
 */
function findPath(start, goal, unit, { occupied = new Set(), terrainMap } = {}) {
  const key = (c, r) => `${c},${r}`;
  const goalKey = key(goal.col, goal.row);
  if (key(start.col, start.row) === goalKey) return [{ col: start.col, row: start.row }];

  const h = (c, r) => hexDist(c, r, goal.col, goal.row);

  const open = new Map(); // key -> {col,row,g,f}
  const cameFrom = new Map();
  const closed = new Set();

  const startKey = key(start.col, start.row);
  open.set(startKey, { col: start.col, row: start.row, g: 0, f: h(start.col, start.row) });

  while (open.size > 0) {
    let curKey = null, cur = null;
    for (const [k, v] of open) {
      if (!cur || v.f < cur.f) { cur = v; curKey = k; }
    }
    open.delete(curKey);
    closed.add(curKey);

    if (curKey === goalKey) {
      const path = [{ col: cur.col, row: cur.row }];
      let k = curKey;
      while (cameFrom.has(k)) {
        k = cameFrom.get(k);
        const [c, r] = k.split(',').map(Number);
        path.unshift({ col: c, row: r });
      }
      return path;
    }

    for (const nb of hexNeighbors(cur.col, cur.row)) {
      const nk = key(nb.col, nb.row);
      if (closed.has(nk)) continue;
      const terrain = terrainMap ? terrainMap[nb.row][nb.col] : getTerrain(nb.col, nb.row);
      const isGoal = nk === goalKey;
      // Allow stepping onto an occupied hex only if it's the goal (e.g. attacking into a contested hex isn't modeled — movement only).
      if (!canEnterTerrain(unit.category, terrain)) continue;
      if (occupied.has(nk) && !isGoal) continue;

      const tentativeG = cur.g + 1;
      const existing = open.get(nk);
      if (!existing || tentativeG < existing.g) {
        cameFrom.set(nk, curKey);
        open.set(nk, { col: nb.col, row: nb.row, g: tentativeG, f: tentativeG + h(nb.col, nb.row) });
      }
    }
  }
  return null;
}

/**
 * Convenience: best path toward `goal` truncated to what `unit` can cover
 * this turn (unit.movement hexes), via A*. Returns {path, reachedGoal} —
 * `path` always starts at the unit's current position (length >= 1).
 */
function planMoveTowards(unit, goal, opts = {}) {
  const start = { col: unit.col, row: unit.row };
  if (start.col === goal.col && start.row === goal.row) return { path: [start], reachedGoal: true };

  const full = findPath(start, goal, unit, opts);
  if (!full) return { path: [start], reachedGoal: false };

  const truncated = full.slice(0, (unit.movement || 0) + 1);
  return { path: truncated, reachedGoal: truncated.length === full.length };
}

module.exports = {
  reachableHexes,
  findPath,
  planMoveTowards,
};
