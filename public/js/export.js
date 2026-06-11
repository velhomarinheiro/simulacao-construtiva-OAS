'use strict';

// ─── Export game screenshot ───────────────────────────────────────────────────
function exportImage(canvasEl, filename) {
  const name = filename || `wargame-turno-${Date.now()}.png`;
  const url  = canvasEl.toDataURL('image/png');
  const a    = document.createElement('a');
  a.href     = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ─── Export game log as text ──────────────────────────────────────────────────
function exportLog(state, filename) {
  if (!state) return;
  const lines = [];
  lines.push('=== OPERAÇÃO ATLÂNTICO SUL — LOG DA PARTIDA ===');
  lines.push(`Data: ${new Date().toLocaleString('pt-BR')}`);
  lines.push(`Turno: ${state.turn}  |  Período: ${state.period === 'day' ? 'Diurno' : 'Noturno'}`);
  lines.push(`Fase: ${state.phase}`);
  if (state.winner) lines.push(`Vencedor: ${state.winner === 'blue' ? 'FORÇA AZUL' : 'FORÇA VERMELHA'}`);
  lines.push('');
  lines.push('--- UNIDADES AZUIS ---');
  for (const u of state.units.filter(u => u.team === 'blue')) {
    lines.push(`  ${u.name.padEnd(14)} SP:${u.hp}/${u.maxHp}  Pos:${String.fromCharCode(65+u.col)}${u.row+1}  ${u.hp <= 0 ? '[DESTRUÍDA]' : ''}`);
  }
  lines.push('');
  lines.push('--- UNIDADES VERMELHAS ---');
  for (const u of state.units.filter(u => u.team === 'red')) {
    lines.push(`  ${u.name.padEnd(14)} SP:${u.hp}/${u.maxHp}  Pos:${String.fromCharCode(65+u.col)}${u.row+1}  ${u.hp <= 0 ? '[DESTRUÍDA]' : ''}`);
  }
  lines.push('');
  lines.push('--- UNIDADES NEUTRAS ---');
  for (const u of state.units.filter(u => u.team === 'neutral')) {
    lines.push(`  ${u.name.padEnd(14)} Pos:${String.fromCharCode(65+u.col)}${u.row+1}`);
  }
  lines.push('');
  lines.push('--- MENSAGENS ---');
  for (const m of (state.messages || [])) {
    const ts = new Date(m.timestamp).toLocaleTimeString('pt-BR');
    const to = m.to === 'all' ? 'Todos' : m.to === 'blue' ? 'Azul' : 'Vermelho';
    lines.push(`[${ts}] FACILITADOR → ${to}: ${m.text}`);
    for (const r of (m.replies || [])) {
      const rts = new Date(r.timestamp).toLocaleTimeString('pt-BR');
      lines.push(`  [${rts}] ${r.from === 'blue' ? 'Azul' : 'Vermelho'}: ${r.text}`);
    }
  }
  lines.push('');
  lines.push('--- LOG DE BATALHA ---');
  for (const entry of ([...state.log]).reverse()) {
    lines.push(`  ${entry}`);
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename || `wargame-log-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Export Order of Battle as CSV ───────────────────────────────────────────
function exportOBCsv(units, filename) {
  const headers = [
    'team','id','name','category','subtype','stayingPower','movement',
    'col','row',
    'det_surface','det_air','det_submarine','det_land',
    'atk_surface','atk_air','atk_submarine','atk_land',
    'weapons_json','capabilities_json','composition_json','notes',
  ];

  const rows = units.map(u => {
    const det = u.detectionRange || {};
    const atk = u.attackRange    || {};
    const wpn = u.weapons || u.initWeapons || {};
    return [
      u.team,
      u.id,
      u.name,
      u.category,
      u.subtype || (u.composition && u.composition[0] ? u.composition[0].type : ''),
      u.stayingPower ?? u.maxHp ?? u.hp,
      u.movement,
      u.col,
      u.row,
      det.surface  ?? 0,
      det.air      ?? 0,
      det.submarine?? 0,
      det.land     ?? 0,
      atk.surface  ?? 0,
      atk.air      ?? 0,
      atk.submarine?? 0,
      atk.land     ?? 0,
      JSON.stringify(wpn),
      JSON.stringify(u.capabilities || {}),
      JSON.stringify(u.composition  || []),
      (u.notes || '').replace(/"/g, '""'),
    ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
  });

  const csv  = [headers.join(','), ...rows].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename || `wargame-ob-${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Import Order of Battle from CSV ─────────────────────────────────────────
function importOBCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV vazio ou sem dados.');

  function parseCsvRow(line) {
    const fields = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i+1] === '"') { cur += '"'; i++; }
        else { inQuote = !inQuote; }
      } else if (ch === ',' && !inQuote) {
        fields.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur);
    return fields;
  }

  const headers = parseCsvRow(lines[0]);
  const idx = {};
  headers.forEach((h, i) => { idx[h.trim()] = i; });

  const required = ['team','name','category','col','row'];
  for (const r of required) {
    if (idx[r] === undefined) throw new Error(`CSV sem coluna obrigatória: ${r}`);
  }

  const forces = { blue: [], red: [], neutral: [] };

  lines.slice(1).forEach((line, li) => {
    if (!line.trim()) return;
    const f = parseCsvRow(line);
    const get = (col, def = '') => (f[idx[col]] ?? def).trim();
    const getN = (col, def = 0) => Number(get(col, String(def))) || def;
    const getJ = (col, def = {}) => { try { return JSON.parse(get(col,'null')) ?? def; } catch { return def; } };

    const team = get('team');
    if (!['blue','red','neutral'].includes(team)) return;

    const id = get('id') || `${team.toUpperCase()}-IMP-${li+1}`;
    const spec = {
      id,
      name:          get('name', `Unit-${li+1}`),
      category:      get('category', 'surface'),
      subtype:       get('subtype', ''),
      stayingPower:  getN('stayingPower', 2),
      movement:      getN('movement', 2),
      position:      { col: getN('col', 8), row: getN('row', 5) },
      detectionRange:{
        surface:   getN('det_surface', 0),
        air:       getN('det_air', 0),
        submarine: getN('det_submarine', 0),
        land:      getN('det_land', 0),
      },
      attackRange: {
        surface:   getN('atk_surface', 0),
        air:       getN('atk_air', 0),
        submarine: getN('atk_submarine', 0),
        land:      getN('atk_land', 0),
      },
      weapons:      getJ('weapons_json', {}),
      capabilities: getJ('capabilities_json', {}),
      composition:  getJ('composition_json', []),
      notes:        get('notes', ''),
    };

    if (!forces[team]) forces[team] = [];
    forces[team].push(spec);
  });

  return { forces };
}

// ─── Trigger file input for CSV import ───────────────────────────────────────
function triggerImportOB(onSuccess, onError) {
  const inp = document.createElement('input');
  inp.type  = 'file';
  inp.accept= '.csv,text/csv';
  inp.addEventListener('change', () => {
    const file = inp.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const ob = importOBCsv(e.target.result);
        onSuccess(ob);
      } catch (err) {
        if (onError) onError(err.message);
        else alert('Erro ao importar CSV: ' + err.message);
      }
    };
    reader.readAsText(file, 'UTF-8');
  });
  document.body.appendChild(inp);
  inp.click();
  document.body.removeChild(inp);
}
