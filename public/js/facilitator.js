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
  units.forEach((spec, idx) => {
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
  });
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

function facEditUnit(team, idx) {
  const spec = facOB.forces[team]?.[idx];
  if (!spec) return;
  const modal = document.getElementById('fac-unit-modal');
  modal.classList.remove('hidden');

  document.getElementById('fum-title').textContent = `Editando: ${spec.name} (${team})`;
  document.getElementById('fum-name').value      = spec.name;
  document.getElementById('fum-category').value  = spec.category;
  document.getElementById('fum-sp').value        = spec.stayingPower;
  document.getElementById('fum-mov').value       = spec.movement;
  document.getElementById('fum-col').value       = spec.position?.col ?? 8;
  document.getElementById('fum-row').value       = spec.position?.row ?? 5;
  document.getElementById('fum-det-s').value     = spec.detectionRange?.surface   ?? 0;
  document.getElementById('fum-det-a').value     = spec.detectionRange?.air       ?? 0;
  document.getElementById('fum-det-sb').value    = spec.detectionRange?.submarine ?? 0;
  document.getElementById('fum-det-l').value     = spec.detectionRange?.land      ?? 0;
  document.getElementById('fum-atk-s').value     = spec.attackRange?.surface      ?? 0;
  document.getElementById('fum-atk-a').value     = spec.attackRange?.air          ?? 0;
  document.getElementById('fum-atk-sb').value    = spec.attackRange?.submarine    ?? 0;
  document.getElementById('fum-atk-l').value     = spec.attackRange?.land         ?? 0;
  document.getElementById('fum-weapons').value   = JSON.stringify(spec.weapons || {}, null, 2);
  document.getElementById('fum-caps').value      = JSON.stringify(spec.capabilities || {}, null, 2);
  document.getElementById('fum-notes').value     = spec.notes || '';

  document.getElementById('fum-save').onclick = () => {
    try {
      spec.name          = document.getElementById('fum-name').value.trim() || spec.name;
      spec.category      = document.getElementById('fum-category').value;
      spec.stayingPower  = Number(document.getElementById('fum-sp').value)  || 2;
      spec.movement      = Number(document.getElementById('fum-mov').value) || 0;
      spec.position      = { col: Number(document.getElementById('fum-col').value), row: Number(document.getElementById('fum-row').value) };
      spec.detectionRange = {
        surface:   Number(document.getElementById('fum-det-s').value)  || 0,
        air:       Number(document.getElementById('fum-det-a').value)  || 0,
        submarine: Number(document.getElementById('fum-det-sb').value) || 0,
        land:      Number(document.getElementById('fum-det-l').value)  || 0,
      };
      spec.attackRange = {
        surface:   Number(document.getElementById('fum-atk-s').value)  || 0,
        air:       Number(document.getElementById('fum-atk-a').value)  || 0,
        submarine: Number(document.getElementById('fum-atk-sb').value) || 0,
        land:      Number(document.getElementById('fum-atk-l').value)  || 0,
      };
      spec.weapons      = JSON.parse(document.getElementById('fum-weapons').value || '{}');
      spec.capabilities = JSON.parse(document.getElementById('fum-caps').value    || '{}');
      spec.notes        = document.getElementById('fum-notes').value;
      facCloseModal();
      facRenderOBTable(team);
      socket.emit('update_ob', { ob: facOB });
    } catch (e) {
      alert('JSON inválido em Armas ou Capacidades: ' + e.message);
    }
  };
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
  socket.emit('start_game', { seed });
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
    const to  = m.to === 'all' ? 'Todos' : m.to === 'blue' ? 'Azul' : 'Vermelho';
    const replies = (m.replies || []).map(r => {
      const rts = new Date(r.timestamp).toLocaleTimeString('pt-BR');
      const rc  = r.from === 'blue' ? 'fac-blue' : 'fac-red';
      return `<div class="fac-reply"><span class="${rc}">${r.from === 'blue' ? 'Azul' : 'Vermelho'}(${rts}):</span> ${escHtml(r.text)}</div>`;
    }).join('');
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
  const alive = state.units.filter(u => u.hp > 0);
  el.innerHTML = alive.map(u => {
    const tc  = u.team === 'blue' ? 'fac-blue' : u.team === 'red' ? 'fac-red' : 'fac-neutral';
    const pos = `${String.fromCharCode(65+u.col)}${u.row+1}`;
    return `<div class="fac-unit-row">
      <span class="${tc}">${u.name}</span>
      <span class="fac-dim">SP:${u.hp}/${u.maxHp} ${pos}</span>
      <div class="fac-unit-row-btns">
        <button class="fac-small-btn" onclick="facQuickEditUnit('${u.id}','${u.name}',${u.hp},${u.maxHp})">✏</button>
        <button class="fac-small-btn red" onclick="facRemoveUnit('${u.id}','${u.name}')">✕</button>
      </div>
    </div>`;
  }).join('');
}

function facQuickEditUnit(unitId, name, hp, maxHp) {
  const newHp = prompt(`HP de ${name} (0–${maxHp}):`, hp);
  if (newHp === null) return;
  const h = Math.max(0, Math.min(maxHp, Number(newHp)));
  socket.emit('facilitator_manage_unit', { action: 'edit', unitId, data: { hp: h } });
}

function facRemoveUnit(unitId, name) {
  if (!confirm(`Remover ${name} do jogo?`)) return;
  socket.emit('facilitator_manage_unit', { action: 'remove', unitId });
}

function facAddNewUnit() {
  const team = prompt('Equipe (blue / red / neutral):', 'neutral');
  if (!['blue','red','neutral'].includes(team)) { alert('Equipe inválida.'); return; }
  const name = prompt('Nome da unidade:', 'Nova Unidade');
  if (!name) return;
  const cat  = prompt('Categoria (surface/submarine/air/land):', 'surface');
  const col  = Number(prompt('Coluna (0–15):', '8'));
  const row  = Number(prompt('Linha (0–9):',   '5'));
  const sp   = Number(prompt('SP (Staying Power):', '2'));
  const mov  = Number(prompt('Movimento:', '2'));
  socket.emit('facilitator_manage_unit', {
    action: 'add',
    data: { team, name, category: cat||'surface', stayingPower: sp||2, movement: mov||0, col, row,
            detectionRange:{surface:0,air:0,submarine:0,land:0},
            attackRange:{surface:0,air:0,submarine:0,land:0},
            weapons:{}, capabilities:{}, composition:[] },
  });
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
