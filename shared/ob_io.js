'use strict';

/**
 * ob_io.js
 * ========
 *
 * Order-of-Battle import + validation, shared by the browser (facilitator CSV
 * import, public/js/export.js) and the server (schema-validating `update_ob` /
 * `set_capability_factors` before they reach the game engine). Loaded in Node
 * via require() and in the browser as a global (`window.OBIO`); served to the
 * page at /shared/ob_io.js.
 *
 * Fixes two robustness bugs in the previous inline importer:
 *   - the parser split on '\n' *before* handling quotes, so any quoted field
 *     containing a newline (e.g. a multi-line JSON blob) corrupted the row.
 *     parseCSV is now a single state machine over the whole text.
 *   - numeric fields used `Number(x) || default`, silently turning a legit `0`
 *     into the default. `num()` only falls back when the cell is truly empty.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.OBIO = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {

  const VALID_CATEGORIES = ['surface', 'submarine', 'air', 'land'];
  const VALID_TEAMS = ['blue', 'red', 'neutral'];
  const GRID_W = 16, GRID_H = 10; // mirrors shared/hexgrid.js; used only for import bounds

  /**
   * Parse CSV text into an array of rows (each an array of string fields).
   * Handles quoted fields, escaped quotes ("") and quoted newlines. A single
   * state machine over the whole text — never a naive split on '\n'.
   */
  function parseCSV(text) {
    const rows = [];
    let row = [], cur = '', inQuote = false;
    const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuote) {
        if (ch === '"') {
          if (s[i + 1] === '"') { cur += '"'; i++; }
          else inQuote = false;
        } else cur += ch;
      } else if (ch === '"') {
        inQuote = true;
      } else if (ch === ',') {
        row.push(cur); cur = '';
      } else if (ch === '\n') {
        row.push(cur); cur = '';
        rows.push(row); row = [];
      } else {
        cur += ch;
      }
    }
    // flush trailing field/row (unless the text ended exactly on a newline)
    if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row); }
    // drop fully-empty rows (e.g. trailing blank lines)
    return rows.filter(r => r.some(f => f.trim() !== ''));
  }

  /** Build an OB `{forces}` object from CSV text. Distinguishes 0 from empty. */
  function obFromCsv(text) {
    const rows = parseCSV(text);
    if (rows.length < 2) throw new Error('CSV vazio ou sem dados.');

    const headers = rows[0].map(h => h.trim());
    const idx = {};
    headers.forEach((h, i) => { idx[h] = i; });

    for (const r of ['team', 'name', 'category', 'col', 'row']) {
      if (idx[r] === undefined) throw new Error(`CSV sem coluna obrigatória: ${r}`);
    }

    const forces = { blue: [], red: [], neutral: [] };

    rows.slice(1).forEach((f, li) => {
      const raw = col => { const v = f[idx[col]]; return v === undefined ? '' : v.trim(); };
      const str = (col, def = '') => { const v = raw(col); return v === '' ? def : v; };
      // Only fall back to `def` when the cell is empty — a real 0 survives.
      const num = (col, def = 0) => { const v = raw(col); if (v === '') return def; const n = Number(v); return Number.isNaN(n) ? def : n; };
      const json = (col, def) => { const v = raw(col); if (v === '') return def; try { const p = JSON.parse(v); return p == null ? def : p; } catch { return def; } };

      const team = str('team');
      if (!VALID_TEAMS.includes(team)) return;

      const spec = {
        id: str('id') || `${team.toUpperCase()}-IMP-${li + 1}`,
        name: str('name', `Unit-${li + 1}`),
        category: str('category', 'surface'),
        subtype: str('subtype', ''),
        stayingPower: num('stayingPower', 2),
        movement: num('movement', 2),
        position: { col: num('col', 8), row: num('row', 5) },
        detectionRange: {
          surface: num('det_surface', 0), air: num('det_air', 0),
          submarine: num('det_submarine', 0), land: num('det_land', 0),
        },
        attackRange: {
          surface: num('atk_surface', 0), air: num('atk_air', 0),
          submarine: num('atk_submarine', 0), land: num('atk_land', 0),
        },
        weapons: json('weapons_json', {}),
        capabilities: json('capabilities_json', {}),
        composition: json('composition_json', []),
        notes: str('notes', ''),
      };
      forces[team].push(spec);
    });

    return { forces };
  }

  /**
   * Validate an OB object's shape before it reaches the game engine. Returns
   * `{ ok, errors }`. Non-fatal by design at the field level — collects every
   * problem so the facilitator gets a full message, not just the first.
   */
  function validateOB(ob) {
    const errors = [];
    if (!ob || typeof ob !== 'object' || !ob.forces || typeof ob.forces !== 'object') {
      return { ok: false, errors: ['OB inválida: falta o objeto `forces`.'] };
    }
    const seenIds = new Set();
    let unitCount = 0;

    for (const team of VALID_TEAMS) {
      const list = ob.forces[team];
      if (list === undefined) continue;
      if (!Array.isArray(list)) { errors.push(`forces.${team} deve ser um array.`); continue; }
      list.forEach((u, i) => {
        unitCount++;
        const where = `${team}[${i}]`;
        if (!u || typeof u !== 'object') { errors.push(`${where}: unidade inválida.`); return; }
        if (!u.id || typeof u.id !== 'string') errors.push(`${where}: id ausente/ inválido.`);
        else if (seenIds.has(u.id)) errors.push(`${where}: id duplicado "${u.id}".`);
        else seenIds.add(u.id);
        if (!u.name || typeof u.name !== 'string') errors.push(`${where}: name ausente.`);
        if (!VALID_CATEGORIES.includes(u.category)) errors.push(`${where}: category "${u.category}" inválida.`);
        const sp = Number(u.stayingPower);
        if (!Number.isFinite(sp) || sp <= 0) errors.push(`${where}: stayingPower deve ser > 0.`);
        const mv = Number(u.movement);
        if (!Number.isFinite(mv) || mv < 0) errors.push(`${where}: movement deve ser >= 0.`);
        const pos = u.position || u.start;
        if (!pos || !Number.isFinite(Number(pos.col)) || !Number.isFinite(Number(pos.row))) {
          errors.push(`${where}: position {col,row} ausente/ inválida.`);
        } else if (pos.col < 0 || pos.col >= GRID_W || pos.row < 0 || pos.row >= GRID_H) {
          errors.push(`${where}: position fora do tabuleiro (${GRID_W}x${GRID_H}).`);
        }
        if (u.weapons != null && typeof u.weapons !== 'object') errors.push(`${where}: weapons deve ser objeto.`);
        if (u.capabilities != null && typeof u.capabilities !== 'object') errors.push(`${where}: capabilities deve ser objeto.`);
      });
    }
    if (unitCount === 0) errors.push('OB sem unidades.');
    return { ok: errors.length === 0, errors };
  }

  return { parseCSV, obFromCsv, validateOB, VALID_CATEGORIES, VALID_TEAMS, GRID_W, GRID_H };
});
