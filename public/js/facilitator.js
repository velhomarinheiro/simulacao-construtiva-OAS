'use strict';
// ─── Facilitador: lógica específica ──────────────────────────────────────────
// Depende de: socket, gameState, render (definidos em client.js)
// e exportImage, exportLog, exportOBCsv, triggerImportOB (definidos em export.js)

// ─── Estado do facilitador ────────────────────────────────────────────────────
let facRepoUnitId   = null;   // unidade selecionada para reposicionamento
let facOB           = null;   // OB customizada (durante config)
let facRoomId       = null;
let blueConnected   = false;
let redConnected    = false;
let facMsgReplyOpen = null;   // messageId da resposta em aberto no painel
let facCapabilityFactors = null; // { A_SSN, B_SSK, C_Azuis, D_MSS, E_Terra } -> bool
let facCapabilityDefs    = null; // { [key]: { label, cost, unitIds } }
let facBatchRows    = null;   // resultados das simulações em lote (IA × IA)
let facBatchSummary = null;

// ─── Inicialização ────────────────────────────────────────────────────────────
function facInit(roomId, ob, capabilityFactors, capabilityFactorDefs) {
  facRoomId = roomId;
  facOB     = ob ? JSON.parse(JSON.stringify(ob)) : null;
  facCapabilityFactors = capabilityFactors    ? { ...capabilityFactors }    : null;
  facCapabilityDefs    = capabilityFactorDefs ? { ...capabilityFactorDefs } : null;
  document.getElementById('fac-room-code').textContent      = roomId;
  const big = document.getElementById('fac-room-code-big');
  if (big) big.textContent = roomId;
  facRenderConfig();
  facRenderPbcPanel();
  facUpdatePlayerStatus({ blueReady: false, redReady: false });
}

// ─── Fatores de capacidade (PBC) ──────────────────────────────────────────────
function facRenderPbcPanel() {
  const list = document.getElementById('fac-pbc-factors');
  if (!list || !facCapabilityDefs || !facCapabilityFactors) return;
  list.innerHTML = Object.keys(facCapabilityDefs).map(key => {
    const def = facCapabilityDefs[key];
    const checked = facCapabilityFactors[key] !== false ? 'checked' : '';
    return `<label class="fac-pbc-row">
      <input type="checkbox" data-factor="${key}" ${checked} onchange="facToggleFactor(this)">
      <span class="fac-pbc-name">${def.label}</span>
      <span class="fac-pbc-cost">${def.cost}</span>
    </label>`;
  }).join('');
  facUpdatePbcSummary();
}

function facUpdatePbcSummary() {
  const summary = document.getElementById('fac-pbc-summary');
  if (!summary || !facCapabilityDefs || !facCapabilityFactors) return;
  let cost = 0, maxCost = 0, active = 0, total = 0;
  for (const key of Object.keys(facCapabilityDefs)) {
    maxCost += facCapabilityDefs[key].cost;
    total++;
    if (facCapabilityFactors[key] !== false) { cost += facCapabilityDefs[key].cost; active++; }
  }
  summary.innerHTML = `Custo total: <strong>${cost}</strong> / ${maxCost} &nbsp;·&nbsp; Capacidades ativas: <strong>${active}</strong>/${total}`;
}

function facToggleFactor(checkbox) {
  if (!facCapabilityFactors) return;
  facCapabilityFactors[checkbox.dataset.factor] = checkbox.checked;
  facUpdatePbcSummary();
  socket.emit('set_capability_factors', { factors: facCapabilityFactors });
}

// Reflete a OB recalculada (após ligar/desligar fatores) na tabela de OB.
function facHandleObUpdated(data) {
  if (data && data.ok === false) {
    const errs = (data.errors || []).slice(0, 3).join('; ');
    showFacNotice(`⚠ OB rejeitada: ${errs}${(data.errors || []).length > 3 ? '…' : ''}`);
    return;
  }
  if (data && data.ob) {
    // Resposta de set_capability_factors: nova OB recomputada.
    facOB = JSON.parse(JSON.stringify(data.ob));
    const activeTab = document.querySelector('.fac-tab.active')?.dataset.team || 'blue';
    facRenderOBTable(activeTab);
    return;
  }
  // Resposta de update_ob bem-sucedida ({ok:true}).
  showFacNotice('OB salva!');
}

// ─── TELA DE CONFIGURAÇÃO ─────────────────────────────────────────────────────

function facRenderConfig() {
  facRenderOBTable('blue');
}

function facSwitchTab(team) {
  document.querySelectorAll('.fac-tab').forEach(t => t.classList.toggle('active', t.dataset.team === team));
  facRenderOBTable(team);
}

function facRenderOBTable(team) {
  const tbody = document.getElementById('fac-ob-tbody');
  if (!tbody || !facOB) return;
  tbody.innerHTML = '';
  const units = facOB.forces[team] || [];

  // Agrupa por domínio → grupo de capacidade (Camada 2), na ordem doutrinária.
  // Mantém o índice original (facEditUnit/facDelete usam o índice do array).
  const TAX = window.FORCE_TAXONOMY;
  const order = TAX ? TAX.taxonomyOrder(team) : null;
  const list = units.map((spec, idx) => ({
    spec, idx,
    cls: TAX ? TAX.classifyUnit(spec.id, team) : { domain: '', sigla: '', label: '' },
  }));
  list.sort((a, b) => {
    const oa = order && order.has(a.spec.id) ? order.get(a.spec.id) : Infinity;
    const ob = order && order.has(b.spec.id) ? order.get(b.spec.id) : Infinity;
    return oa !== ob ? oa - ob : a.idx - b.idx;
  });

  let curKey = null;
  for (const { spec, idx, cls } of list) {
    const key = `${cls.domain}|${cls.sigla}`;
    if (TAX && key !== curKey) {
      curKey = key;
      const hr = document.createElement('tr');
      hr.className = 'fac-ob-group';
      hr.innerHTML = `<td colspan="6">${escHtml(cls.domain)} · <strong>${escHtml(cls.sigla)}</strong> — ${escHtml(cls.label)}</td>`;
      tbody.appendChild(hr);
    }
    const tr = document.createElement('tr');
    const colLetter = String.fromCharCode(65 + (spec.position?.col ?? 0));
    const rowNum    = (spec.position?.row ?? 0) + 1;
    tr.innerHTML = `
      <td class="fac-ob-name">${spec.name}</td>
      <td class="fac-ob-cat">${spec.category}</td>
      <td class="fac-ob-sp">${spec.stayingPower}</td>
      <td class="fac-ob-mov">${spec.movement}</td>
      <td class="fac-ob-pos">${colLetter}${rowNum}</td>
      <td class="fac-ob-actions">
        <button class="fac-small-btn" onclick="facEditUnit('${team}',${idx})">✏</button>
        <button class="fac-small-btn red" onclick="facDeleteUnit('${team}',${idx})">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function facAddUnit(team) {
  const t = team || document.querySelector('.fac-tab.active')?.dataset.team || 'blue';
  const newSpec = {
    id: `${t.toUpperCase()}-NEW-${Date.now()}`,
    name: 'Nova Unidade', category: 'surface', stayingPower: 2, movement: 2,
    detectionRange: { surface:2, air:1, submarine:0, land:1 },
    attackRange:    { surface:2, air:0, submarine:0, land:0 },
    weapons: {}, capabilities: {}, composition: [],
    position: { col: 8, row: 5 }, notes: '',
  };
  if (!facOB.forces[t]) facOB.forces[t] = [];
  facOB.forces[t].push(newSpec);
  const idx = facOB.forces[t].length - 1;
  facRenderOBTable(t);
  facEditUnit(t, idx);
}

function facDeleteUnit(team, idx) {
  if (!confirm(`Excluir "${facOB.forces[team][idx]?.name}"?`)) return;
  facOB.forces[team].splice(idx, 1);
  facRenderOBTable(team);
  socket.emit('update_ob', { ob: facOB });
}

// ─── FORMULÁRIO DE UNIDADE (add/edit sem prompts nem JSON cru) ─────────────────
const FUM_WEAPON_TYPES = ['ascm', 'mss', 'torpedo', 'lacm', 'asbm'];
const FUM_CAP_TYPES    = ['airDefense', 'bmd', 'asw', 'airAttack', 'navalGun'];
let _fumMode = null, _fumTeam = null, _fumIdx = null, _fumUnitId = null;

function _fumOpts(list, sel) {
  return Array.from(new Set([...list, sel].filter(Boolean)))
    .map(t => `<option value="${t}" ${t === sel ? 'selected' : ''}>${t}</option>`).join('');
}
function facWpnRowHtml(type, qty, range) {
  return `<div class="fum-row">
    <select class="fac-input fum-wtype">${_fumOpts(FUM_WEAPON_TYPES, type)}</select>
    <input type="number" class="fac-input fum-wqty"   min="0" placeholder="qtd" value="${qty ?? ''}">
    <input type="number" class="fac-input fum-wrange" min="0" placeholder="alc" value="${range ?? ''}">
    <button type="button" class="fac-small-btn red" onclick="this.parentElement.remove()">✕</button>
  </div>`;
}
function facCapRowHtml(type, val) {
  return `<div class="fum-row">
    <select class="fac-input fum-ctype">${_fumOpts(FUM_CAP_TYPES, type)}</select>
    <input type="number" class="fac-input fum-cval" min="0" placeholder="valor" value="${val ?? ''}">
    <button type="button" class="fac-small-btn red" onclick="this.parentElement.remove()">✕</button>
  </div>`;
}
function facAddWpnRow() { document.getElementById('fum-weapons-list').insertAdjacentHTML('beforeend', facWpnRowHtml('ascm', '', '')); }
function facAddCapRow() { document.getElementById('fum-caps-list').insertAdjacentHTML('beforeend', facCapRowHtml('airDefense', '')); }

function facFillModal(spec, team, spValue) {
  const g = id => document.getElementById(id);
  g('fum-team').value = team || 'neutral';
  g('fum-name').value = spec.name || '';
  g('fum-category').value = spec.category || 'surface';
  g('fum-sp').value = spValue ?? spec.stayingPower ?? spec.maxHp ?? 2;
  g('fum-mov').value = spec.movement ?? 0;
  g('fum-col').value = spec.position?.col ?? spec.col ?? 8;
  g('fum-row').value = spec.position?.row ?? spec.row ?? 5;
  const d = spec.detectionRange || {}, a = spec.attackRange || {};
  g('fum-det-s').value = d.surface ?? 0; g('fum-det-a').value = d.air ?? 0;
  g('fum-det-sb').value = d.submarine ?? 0; g('fum-det-l').value = d.land ?? 0;
  g('fum-atk-s').value = a.surface ?? 0; g('fum-atk-a').value = a.air ?? 0;
  g('fum-atk-sb').value = a.submarine ?? 0; g('fum-atk-l').value = a.land ?? 0;
  const wl = g('fum-weapons-list'); wl.innerHTML = '';
  for (const [t, w] of Object.entries(spec.weapons || {})) wl.insertAdjacentHTML('beforeend', facWpnRowHtml(t, (w && w.quantity != null) ? w.quantity : w, w && w.range));
  const cl = g('fum-caps-list'); cl.innerHTML = '';
  for (const [t, v] of Object.entries(spec.capabilities || {})) cl.insertAdjacentHTML('beforeend', facCapRowHtml(t, v));
  g('fum-notes').value = spec.notes || '';
  document.getElementById('fac-unit-modal').classList.remove('hidden');
  document.getElementById('fum-save').onclick = facSaveUnitModal;
}
function facReadModalSpec() {
  const g = id => document.getElementById(id);
  const n = id => Number(g(id).value) || 0;
  const weapons = {};
  document.querySelectorAll('#fum-weapons-list .fum-row').forEach(r => {
    const t = r.querySelector('.fum-wtype').value;
    const q = Number(r.querySelector('.fum-wqty').value);
    const rng = Number(r.querySelector('.fum-wrange').value);
    if (t && q > 0) weapons[t] = { quantity: q, range: rng > 0 ? rng : 1 };
  });
  const capabilities = {};
  document.querySelectorAll('#fum-caps-list .fum-row').forEach(r => {
    const t = r.querySelector('.fum-ctype').value;
    const v = Number(r.querySelector('.fum-cval').value);
    if (t && v > 0) capabilities[t] = v;
  });
  return {
    team: g('fum-team').value, name: g('fum-name').value.trim(),
    category: g('fum-category').value, stayingPower: n('fum-sp') || 2, movement: n('fum-mov'),
    col: n('fum-col'), row: n('fum-row'),
    detectionRange: { surface: n('fum-det-s'), air: n('fum-det-a'), submarine: n('fum-det-sb'), land: n('fum-det-l') },
    attackRange: { surface: n('fum-atk-s'), air: n('fum-atk-a'), submarine: n('fum-atk-sb'), land: n('fum-atk-l') },
    weapons, capabilities, notes: g('fum-notes').value,
  };
}

function facEditUnit(team, idx) {
  const spec = facOB.forces[team]?.[idx];
  if (!spec) return;
  _fumMode = 'config-edit'; _fumTeam = team; _fumIdx = idx;
  document.getElementById('fum-title').textContent = `Editando: ${spec.name} (${team})`;
  facFillModal(spec, team);
}

function facSaveUnitModal() {
  const s = facReadModalSpec();
  if (!s.name) { showFacNotice('Informe o nome da unidade.'); return; }
  const position = { col: s.col, row: s.row };

  if (_fumMode === 'config-edit') {
    const spec = facOB.forces[_fumTeam]?.[_fumIdx];
    if (!spec) { facCloseModal(); return; }
    Object.assign(spec, {
      name: s.name, category: s.category, stayingPower: s.stayingPower, movement: s.movement,
      position, detectionRange: s.detectionRange, attackRange: s.attackRange,
      weapons: s.weapons, capabilities: s.capabilities, notes: s.notes,
    });
    if (s.team !== _fumTeam) { // moved between forces
      facOB.forces[_fumTeam].splice(_fumIdx, 1);
      (facOB.forces[s.team] = facOB.forces[s.team] || []).push(spec);
    }
    facCloseModal();
    facRenderOBTable(document.querySelector('.fac-tab.active')?.dataset.team || _fumTeam);
    socket.emit('update_ob', { ob: facOB });
  } else if (_fumMode === 'live-add') {
    socket.emit('facilitator_manage_unit', { action: 'add', data: {
      team: s.team, name: s.name, category: s.category, stayingPower: s.stayingPower, movement: s.movement,
      col: s.col, row: s.row, detectionRange: s.detectionRange, attackRange: s.attackRange,
      weapons: s.weapons, capabilities: s.capabilities, composition: [],
    } });
    facCloseModal();
  } else if (_fumMode === 'live-edit') {
    socket.emit('facilitator_manage_unit', { action: 'edit', unitId: _fumUnitId, data: {
      name: s.name, category: s.category, movement: s.movement, stayingPower: s.stayingPower,
      col: s.col, row: s.row, detectionRange: s.detectionRange, attackRange: s.attackRange,
      weapons: s.weapons, capabilities: s.capabilities,
    } });
    facCloseModal();
  }
}

function facCloseModal() {
  document.getElementById('fac-unit-modal').classList.add('hidden');
}

function facSaveOB() {
  if (!facOB) return;
  socket.emit('update_ob', { ob: facOB }); // sucesso/erro reportado em facHandleObUpdated
}

function facStartGame() {
  if (!facOB) return;
  socket.emit('update_ob', { ob: facOB });
  const seedInput = document.getElementById('fac-seed-input');
  const seedRaw   = seedInput ? seedInput.value.trim() : '';
  const seed      = seedRaw === '' ? null : Number(seedRaw);
  const timerRaw  = document.getElementById('fac-turn-timer')?.value.trim() || '';
  const turnTimer = timerRaw === '' ? 0 : Number(timerRaw);
  socket.emit('start_game', { seed, turnTimer });
}

// ─── SIMULAÇÕES EM LOTE (IA × IA) ─────────────────────────────────────────────

function facRunBatchSimulations() {
  if (!facOB) return;
  socket.emit('update_ob', { ob: facOB });

  const nInput     = document.getElementById('fac-batch-n');
  const turnsInput = document.getElementById('fac-batch-turns');
  const seedInput  = document.getElementById('fac-seed-input');
  const replicas   = Math.max(1, Math.min(200, Math.round(Number(nInput?.value)) || 10));
  const maxTurns   = Math.max(1, Math.min(60,  Math.round(Number(turnsInput?.value)) || 30));
  const seedRaw    = seedInput ? seedInput.value.trim() : '';
  const seed       = seedRaw === '' ? null : Number(seedRaw);

  const btn = document.getElementById('fac-batch-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⌛ Gerando simulações...'; }
  document.getElementById('fac-batch-results')?.classList.add('hidden');

  socket.emit('run_batch_simulations', { replicas, maxTurns, seed });
}

function facHandleBatchResults(data) {
  facBatchRows    = data.rows || [];
  facBatchSummary = data.summary || null;

  const btn = document.getElementById('fac-batch-btn');
  if (btn) { btn.disabled = false; btn.textContent = '▶ GERAR SIMULAÇÕES'; }

  const box = document.getElementById('fac-batch-results');
  if (box && facBatchSummary) {
    facRenderBatchSummary(box, facBatchSummary);
    box.insertAdjacentHTML('beforeend',
      '<span class="fac-batch-link" onclick="facOpenBatchModal()">Ver detalhes por réplica / exportar CSV</span>');
    box.classList.remove('hidden');
  }
  showFacNotice(`${facBatchRows.length} simulação(ões) concluída(s).`);
}

function facRenderBatchSummary(container, summary) {
  const fmt = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));
  container.innerHTML = `
    <span class="fac-batch-stat">Simulações: <strong>${summary.n}</strong></span>
    <span class="fac-batch-stat">Vitórias Azul: <strong>${summary.winsBlue}</strong></span>
    <span class="fac-batch-stat">Vitórias Vermelha: <strong>${summary.winsRed}</strong></span>
    <span class="fac-batch-stat">Sem decisão: <strong>${summary.winsNone}</strong></span>
    <span class="fac-batch-stat">E1 Atrito Vermelho (méd.): <strong>${fmt(summary.avgE1_atrito)}</strong></span>
    <span class="fac-batch-stat">E1 KCV (decisivo): <strong>${fmt(summary.pctKcv * 100, 0)}%</strong></span>
    <span class="fac-batch-stat">E2 VP (méd.): <strong>${fmt(summary.avgE2_vp)}</strong></span>
    <span class="fac-batch-stat">E2 SLOC (méd.): <strong>${fmt(summary.avgE2_sloc, 3)}</strong></span>
    <span class="fac-batch-stat">E3 Culminância (turno méd.): <strong>${fmt(summary.avgCulminancia, 1)}</strong></span>
    <span class="fac-batch-stat">Atrito Azul (méd.): <strong>${fmt(summary.avgAtritoAzul)}</strong></span>
    <span class="fac-batch-stat">Turnos (méd.): <strong>${fmt(summary.avgTurns, 1)}</strong></span>
  `;
}

function facOpenBatchModal() {
  if (!facBatchRows) return;
  const modal     = document.getElementById('fac-batch-modal');
  const tbody     = document.getElementById('fac-batch-tbody');
  const summaryEl = document.getElementById('fac-batch-summary');
  if (summaryEl && facBatchSummary) facRenderBatchSummary(summaryEl, facBatchSummary);
  if (tbody) {
    tbody.innerHTML = facBatchRows.map(r => `<tr>
      <td>${r.replica}</td>
      <td>${r.seed ?? '—'}</td>
      <td>${r.winner === 'blue' ? 'Azul' : r.winner === 'red' ? 'Vermelha' : '—'}</td>
      <td>${r.turns}</td>
      <td>${r.metrics.E1_atrito}</td>
      <td>${r.metrics.E1_kcv}</td>
      <td>${r.metrics.E2_vp}</td>
      <td>${r.metrics.E2_sloc != null ? r.metrics.E2_sloc.toFixed(3) : '—'}</td>
      <td>${r.metrics.E3_culminancia ?? '—'}</td>
      <td>${r.metrics.atrito_azul}</td>
    </tr>`).join('');
  }
  modal.classList.remove('hidden');
}

function facCloseBatchModal() {
  document.getElementById('fac-batch-modal').classList.add('hidden');
}

function facExportBatchCsv() {
  if (!facBatchRows) return;
  const columns = [
    { key: 'replica', label: 'Replica' },
    { key: 'seed', label: 'Semente' },
    { key: 'winner', label: 'vencedor' },
    { key: 'turns', label: 'turnos' },
    { key: 'metrics.E1_atrito', label: 'E1_atrito' },
    { key: 'metrics.E1_kcv', label: 'E1_kcv' },
    { key: 'metrics.E2_vp', label: 'E2_vp' },
    { key: 'metrics.E2_sloc', label: 'E2_sloc' },
    { key: 'metrics.E3_culminancia', label: 'E3_culminancia' },
    { key: 'metrics.atrito_azul', label: 'atrito_azul' },
  ];
  exportRowsCsv(facBatchRows, columns, `wargame-simulacoes-${facRoomId}-${Date.now()}.csv`);
}

function facExportOBCsv() {
  if (!facOB) return;
  const all = [
    ...(facOB.forces.blue    || []).map(s => ({...s, team:'blue'})),
    ...(facOB.forces.red     || []).map(s => ({...s, team:'red'})),
    ...(facOB.forces.neutral || []).map(s => ({...s, team:'neutral'})),
  ];
  exportOBCsv(all);
}

function facImportOBCsv() {
  triggerImportOB(
    (ob) => {
      facOB = ob;
      socket.emit('update_ob', { ob: facOB });
      const activeTab = document.querySelector('.fac-tab.active')?.dataset.team || 'blue';
      facRenderOBTable(activeTab);
      showFacNotice('OB importada com sucesso!');
    },
    (err) => alert('Erro ao importar: ' + err)
  );
}

// ─── APROVAÇÃO DE MOVIMENTOS ──────────────────────────────────────────────────

let facPendingOverrides = []; // { unitId, col, row }

function facShowMovementApproval(state) {
  document.getElementById('fac-approval-panel').classList.remove('hidden');
  document.getElementById('fac-approval-title').textContent = 'APROVAÇÃO — MOVIMENTOS';
  const body = document.getElementById('fac-approval-body');

  // Lista unidades que se moveram
  const moved = state.units.filter(u => u.moved && u.hp > 0);
  if (moved.length === 0) {
    body.innerHTML = '<p class="fac-dim">Nenhuma unidade se moveu neste turno.</p>';
  } else {
    body.innerHTML = moved.map(u => {
      const tc  = u.team === 'blue' ? 'fac-blue' : u.team === 'red' ? 'fac-red' : 'fac-neutral';
      const pos = `${String.fromCharCode(65+u.col)}${u.row+1}`;
      return `<div class="fac-approval-unit" data-uid="${u.id}">
        <span class="${tc}">${u.name}</span>
        <span class="fac-dim">→ ${pos}</span>
        <button class="fac-small-btn" onclick="facSelectRepoUnit('${u.id}')">📍 Mover</button>
      </div>`;
    }).join('');
  }
  facPendingOverrides = [];
  document.getElementById('fac-approve-btn').onclick = facApproveMovements;
}

function facSelectRepoUnit(unitId) {
  facRepoUnitId = unitId;
  showFacNotice('Clique no mapa para reposicionar a unidade.');
}

function facHandleMapClickForRepo(col, row) {
  if (!facRepoUnitId) return false;
  const override = facPendingOverrides.find(o => o.unitId === facRepoUnitId);
  if (override) { override.col = col; override.row = row; }
  else facPendingOverrides.push({ unitId: facRepoUnitId, col, row });
  showFacNotice(`Reposicionado → ${String.fromCharCode(65+col)}${row+1}. Clique em "Aprovar" para confirmar.`);
  facRepoUnitId = null;
  return true;
}

function facApproveMovements() {
  socket.emit('approve_movements', { overrides: facPendingOverrides });
  facPendingOverrides = [];
  document.getElementById('fac-approval-panel').classList.add('hidden');
}

// ─── APROVAÇÃO DE COMBATE ─────────────────────────────────────────────────────

let facHpChanges = []; // { unitId, hp }

function facShowCombatApproval(state) {
  document.getElementById('fac-approval-panel').classList.remove('hidden');
  document.getElementById('fac-approval-title').textContent = 'APROVAÇÃO — RESULTADOS DE COMBATE';
  const body = document.getElementById('fac-approval-body');

  const combatants = state.units.filter(u => u.team !== 'neutral');
  facHpChanges = [];

  body.innerHTML = `
    <div class="fac-hp-table">
      ${combatants.map(u => {
        const tc  = u.team === 'blue' ? 'fac-blue' : 'fac-red';
        const pct = u.maxHp > 0 ? (u.hp / u.maxHp * 100) : 0;
        const bar = pct > 60 ? '#69f0ae' : pct > 30 ? '#ffca28' : '#ff5252';
        const destroyed = u.hp <= 0 ? ' fac-destroyed' : '';
        return `<div class="fac-hp-row${destroyed}" data-uid="${u.id}">
          <span class="${tc}">${u.name}</span>
          <div class="fac-hp-bar-wrap"><div class="fac-hp-bar-fill" style="width:${pct}%;background:${bar}"></div></div>
          <input class="fac-hp-input" type="number" min="0" max="${u.maxHp}"
            value="${u.hp}" data-uid="${u.id}" data-maxhp="${u.maxHp}"
            onchange="facRecordHpChange(this)">
          <span class="fac-dim">/ ${u.maxHp}</span>
        </div>`;
      }).join('')}
    </div>`;

  document.getElementById('fac-approve-btn').onclick = facApproveCombat;
}

function facRecordHpChange(input) {
  const uid = input.dataset.uid;
  const hp  = Math.max(0, Math.min(Number(input.dataset.maxhp), Number(input.value)));
  input.value = hp;
  const existing = facHpChanges.find(c => c.unitId === uid);
  if (existing) existing.hp = hp;
  else facHpChanges.push({ unitId: uid, hp });
}

function facApproveCombat() {
  socket.emit('approve_combat', { hpChanges: facHpChanges });
  facHpChanges = [];
  document.getElementById('fac-approval-panel').classList.add('hidden');
}

// ─── MENSAGENS ────────────────────────────────────────────────────────────────

function facSendMessage() {
  const to   = document.getElementById('fac-msg-to').value;
  const text = document.getElementById('fac-msg-text').value.trim();
  if (!text) return;
  socket.emit('facilitator_message', { to, text });
  document.getElementById('fac-msg-text').value = '';
}

function facRenderMessages(messages) {
  const el = document.getElementById('fac-msg-log');
  if (!el) return;
  if (!messages || messages.length === 0) {
    el.innerHTML = '<p class="fac-dim">Nenhuma mensagem.</p>';
    return;
  }
  el.innerHTML = messages.map(m => {
    const ts  = new Date(m.timestamp).toLocaleTimeString('pt-BR');
    const replies = (m.replies || []).map(r => {
      const rts = new Date(r.timestamp).toLocaleTimeString('pt-BR');
      const rc  = r.from === 'blue' ? 'fac-blue' : 'fac-red';
      return `<div class="fac-reply"><span class="${rc}">${r.from === 'blue' ? 'Azul' : 'Vermelho'}(${rts}):</span> ${escHtml(r.text)}</div>`;
    }).join('');
    if (m.from === 'blue' || m.from === 'red') {
      // Mensagem iniciada por um jogador.
      const fc = m.from === 'blue' ? 'fac-blue' : 'fac-red';
      return `<div class="fac-msg-item fac-msg-incoming">
        <div class="fac-msg-header"><span class="${fc}">${m.from === 'blue' ? 'AZUL' : 'VERMELHO'}</span> → <span class="fac-gold">FACILITADOR</span> <span class="fac-dim">[${ts}]</span></div>
        <div class="fac-msg-body">${escHtml(m.text)}</div>
        ${replies}
      </div>`;
    }
    const to = m.to === 'all' ? 'Todos' : m.to === 'blue' ? 'Azul' : 'Vermelho';
    return `<div class="fac-msg-item">
      <div class="fac-msg-header"><span class="fac-gold">FACILITADOR</span> → <span>${to}</span> <span class="fac-dim">[${ts}]</span></div>
      <div class="fac-msg-body">${escHtml(m.text)}</div>
      ${replies}
    </div>`;
  }).reverse().join('');
}

// ─── GERENCIAR UNIDADES ───────────────────────────────────────────────────────

function facRenderUnitManager(state) {
  const el = document.getElementById('fac-unit-list');
  if (!el || !state) return;
  const TAX = window.FORCE_TAXONOMY;
  const alive = state.units.filter(u => u.hp > 0);
  // Ordena e agrupa por lado → domínio/grupo de capacidade (Camada 2).
  const sideRank = { blue: 0, red: 1, neutral: 2 };
  const withCls = alive.map(u => ({ u, cls: TAX ? TAX.classifyUnit(u.id, u.team) : { domain: '', sigla: '', label: '' } }));
  withCls.sort((a, b) => {
    if (sideRank[a.u.team] !== sideRank[b.u.team]) return sideRank[a.u.team] - sideRank[b.u.team];
    const oa = TAX ? (TAX.taxonomyOrder(a.u.team).get(a.u.id) ?? Infinity) : 0;
    const ob = TAX ? (TAX.taxonomyOrder(b.u.team).get(b.u.id) ?? Infinity) : 0;
    return oa - ob;
  });
  let curKey = null;
  let html = '';
  for (const { u, cls } of withCls) {
    const key = `${u.team}|${cls.sigla}`;
    if (TAX && key !== curKey) {
      curKey = key;
      const teamLabel = u.team === 'blue' ? 'Azul' : u.team === 'red' ? 'Vermelho' : 'Neutro';
      html += `<div class="fac-unit-group">${teamLabel} · ${escHtml(cls.sigla)} — ${escHtml(cls.label)}</div>`;
    }
    const tc  = u.team === 'blue' ? 'fac-blue' : u.team === 'red' ? 'fac-red' : 'fac-neutral';
    const pos = `${String.fromCharCode(65 + u.col)}${u.row + 1}`;
    html += `<div class="fac-unit-row">
      <span class="${tc}">${u.name}</span>
      <span class="fac-dim">SP:${u.hp}/${u.maxHp} ${pos}</span>
      <div class="fac-unit-row-btns">
        <button class="fac-small-btn" onclick="facQuickEditUnit('${u.id}')">✏</button>
        <button class="fac-small-btn red" onclick="facRemoveUnit('${u.id}','${u.name}')">✕</button>
      </div>
    </div>`;
  }
  el.innerHTML = html;
}

function facQuickEditUnit(unitId) {
  const u = gameState?.units.find(x => x.id === unitId);
  if (!u) return;
  _fumMode = 'live-edit'; _fumUnitId = unitId; _fumTeam = u.team;
  document.getElementById('fum-title').textContent = `Editando: ${u.name}`;
  // In live mode the SP field is the unit's current staying power (max).
  facFillModal({
    name: u.name, category: u.category, movement: u.movement,
    position: { col: u.col, row: u.row }, detectionRange: u.detectionRange,
    attackRange: u.attackRange, weapons: u.weapons, capabilities: u.capabilities, notes: u.notes,
  }, u.team, u.maxHp);
}

function facRemoveUnit(unitId, name) {
  if (!confirm(`Remover ${name} do jogo?`)) return;
  socket.emit('facilitator_manage_unit', { action: 'remove', unitId });
}

function facAddNewUnit() {
  _fumMode = 'live-add'; _fumTeam = null; _fumIdx = null; _fumUnitId = null;
  document.getElementById('fum-title').textContent = 'NOVA UNIDADE';
  facFillModal({ name: 'Nova Unidade', category: 'surface', stayingPower: 2, movement: 2,
    position: { col: 8, row: 5 }, weapons: {}, capabilities: {} }, 'neutral');
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────
function facExportImage() {
  const canvas = document.getElementById('game-canvas');
  exportImage(canvas, `wargame-mapa-t${gameState?.turn||0}.png`);
}

function facExportLogFile() {
  exportLog(gameState);
}

function facExportAar() {
  const hist = gameState?.combatHistory || [];
  if (!hist.length) { showFacNotice('Sem engajamentos registrados ainda.'); return; }
  exportAarCsv(hist, `wargame-aar-t${gameState?.turn||0}.csv`);
  showFacNotice(`AAR exportado (${hist.length} engajamentos).`);
}

// ─── UTILIDADES ───────────────────────────────────────────────────────────────

function showFacNotice(text) {
  const configVisible = !document.getElementById('config-screen')?.classList.contains('hidden');
  const el = configVisible
    ? document.getElementById('fac-config-notice')
    : document.getElementById('fac-notice');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(showFacNotice._t);
  showFacNotice._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function facUpdatePlayerStatus(data) {
  blueConnected = data.blueReady;
  redConnected  = data.redReady;

  // Header mini-indicator
  const el = document.getElementById('fac-player-status');
  if (el) {
    el.innerHTML =
      `<span class="${blueConnected ? 'fac-blue' : 'fac-dim'}">● Azul</span> ` +
      `<span class="${redConnected  ? 'fac-red'  : 'fac-dim'}">● Vermelho</span>`;
  }

  // Start panel rows
  const blueRow = document.getElementById('fac-status-blue-row');
  const redRow  = document.getElementById('fac-status-red-row');
  if (blueRow) {
    blueRow.textContent = blueConnected ? '⬤ Equipe Azul       conectada' : '⬤ Equipe Azul       sem jogador (IA)';
    blueRow.className   = `fac-player-row ${blueConnected ? 'fac-blue' : 'fac-dim'}`;
  }
  if (redRow) {
    redRow.textContent = redConnected ? '⬤ Equipe Vermelha   conectada' : '⬤ Equipe Vermelha   sem jogador (IA)';
    redRow.className   = `fac-player-row ${redConnected ? 'fac-red' : 'fac-dim'}`;
  }

  // Start button + notice (sempre habilitado: equipes sem jogador conectado
  // são assumidas pelo jogador digital / IA)
  const btn    = document.getElementById('fac-start-btn');
  const notice = document.getElementById('fac-config-notice');
  if (btn) btn.disabled = false;
  if (notice) {
    if (blueConnected && redConnected) {
      notice.textContent  = '✔ Ambas as equipes estão prontas.';
      notice.style.color  = 'var(--green)';
    } else if (!blueConnected && !redConnected) {
      notice.textContent  = 'Nenhum jogador conectado — ambas as equipes serão controladas pela IA (jogador digital).';
      notice.style.color  = '';
    } else {
      const missing = !blueConnected ? 'Azul' : 'Vermelha';
      notice.textContent  = `Equipe ${missing} sem jogador — será controlada pela IA (jogador digital).`;
      notice.style.color  = '';
    }
  }
}

// Mostra/oculta painéis conforme a fase
function facUpdatePhaseUI(phase) {
  const approvalPanel = document.getElementById('fac-approval-panel');
  // O painel de aprovação é exibido explicitamente pelos handlers de evento
  // Aqui apenas resetamos se a fase não é de aprovação
  if (phase !== 'movement_approval' && phase !== 'combat_approval') {
    if (approvalPanel) approvalPanel.classList.add('hidden');
  }
}
