'use strict';

// ─── Export game screenshot ─────────────────────────────────────────────────────
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

// ─── Export game log as text ────────────────────────────────────────────────────
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
  const hist = state.combatHistory || [];
  if (hist.length) {
    lines.push('');
    lines.push('--- REGISTRO DE ENGAJAMENTOS (AAR) ---');
    for (const h of hist) {
      const outcome = h.destroyed ? 'DESTRUÍDO' : `−${h.actualLoss}SP (resta ${h.remainingHp})`;
      lines.push(`  T${h.turn}/${h.period === 'day' ? 'D' : 'N'} ${h.attackerName}(${h.attackerTeam}) →[${h.weapon}] ${h.targetName}(${h.targetTeam}): ${outcome}`);
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

// ─── Export Order of Battle as CSV ──────────────────────────────────────────────────
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

// ─── Export generic tabular data as CSV ────────────────────────────────────────
// columns: [{ key, label }] — `key` reads (possibly nested via dot-path) from
// each row, `label` is the CSV header.
function exportRowsCsv(rows, columns, filename) {
  const get = (row, key) => key.split('.').reduce((v, k) => (v == null ? v : v[k]), row);
  const headers = columns.map(c => c.label);
  const lines = rows.map(row => columns.map(c => {
    const v = get(row, c.key);
    return `"${String(v ?? '').replace(/"/g, '""')}"`;
  }).join(','));

  const csv  = [headers.join(','), ...lines].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename || `wargame-export-${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Export after-action report (per-engagement) as CSV ─────────────────────────
function exportAarCsv(combatHistory, filename) {
  const columns = [
    { key: 'turn', label: 'Turno' }, { key: 'period', label: 'Periodo' },
    { key: 'engagementId', label: 'Engajamento' },
    { key: 'attackerName', label: 'Atacante' }, { key: 'attackerTeam', label: 'Time_Atacante' },
    { key: 'weapon', label: 'Arma' }, { key: 'launched', label: 'Disparos' },
    { key: 'targetName', label: 'Alvo' }, { key: 'targetTeam', label: 'Time_Alvo' },
    { key: 'actualLoss', label: 'Dano_SP' }, { key: 'remainingHp', label: 'SP_Restante' },
    { key: 'destroyed', label: 'Destruido' },
  ];
  exportRowsCsv(combatHistory || [], columns, filename || `wargame-aar-${Date.now()}.csv`);
}

// ─── Import Order of Battle from CSV ──────────────────────────────────────────────
// Delegates to the shared, multiline-safe parser (shared/ob_io.js, loaded as the
// global OBIO). Keeps a minimal fallback only if that module failed to load.
function importOBCsv(text) {
  if (typeof OBIO !== 'undefined' && OBIO.obFromCsv) return OBIO.obFromCsv(text);
  throw new Error('Módulo de importação (ob_io.js) não carregado.');
}

// ─── Trigger file input for CSV import ─────────────────────────────────────────────────
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
