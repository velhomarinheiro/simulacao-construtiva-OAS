'use strict';

// ─── DOM refs ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const lobbyScreen    = $('lobby-screen');
const configScreen   = $('config-screen');
const gameScreen     = $('game-screen');
const canvas         = $('game-canvas');
const ctx            = canvas.getContext('2d');
const teamBadge      = $('team-badge');
const turnLabel      = $('turn-label');
const periodLabel    = $('period-label');
const phaseLabel     = $('phase-label');
const myTurnBanner   = $('my-turn-banner');
const unitPanel      = $('unit-panel');
const endPhaseBtn    = $('end-phase-btn');
const combatBtn      = $('combat-btn');
const undoStepBtn    = $('undo-step-btn');
const cancelBtn      = $('cancel-btn');
const fleetBlue      = $('fleet-blue');
const fleetRed       = $('fleet-red');
const logEl          = $('battle-log');
const gameOver       = $('game-over');
const winnerMsg      = $('winner-msg');
const disconnected   = $('disconnected');
const roomInput      = $('room-input');
const terrainTip     = $('terrain-tip');
const stackPicker    = $('stack-picker');
const spList         = $('sp-list');
const spGroupBtn     = $('sp-group-btn');

// ─── Canvas setup ───────────────────────────────────────────────────────────────────
canvas.width  = CVS_W;
canvas.height = CVS_H;

// Theatre background. Served as a static image at the canvas' native
// resolution (public/mapa.jpeg, 1723×1416 = 1:1 with drawImage below) so it
// renders crisp instead of an upscaled thumbnail. Falls back to a gradient if
// the file fails to load (mapReady stays false).
const mapImg   = new Image();
let   mapReady = false;
mapImg.onload  = () => { mapReady = true;  if (gameState) render(); };
mapImg.onerror = () => { mapReady = false; if (gameState) render(); };
mapImg.src = 'mapa.jpeg';

// ─── Game state ───────────────────────────────────────────────────────────────────
let myRole      = null;   // 'blue' | 'red' | 'facilitator'
let gameState   = null;
let selUnitId   = null;
let moveHexes   = [];
let atkHexes    = [];
let pendingAtks = [];
let hoverHex    = null;
let activePath   = [];
let plannedMoves = new Map();
let selGroupIds  = [];

// ─── Socket ───────────────────────────────────────────────────────────────────────
const socket = io();

function rangeAgainst(rangeTable, targetCategory) {
  if (!rangeTable) return 0;
  return Number(rangeTable[targetCategory] || 0);
}

// ─── Socket events ───────────────────────────────────────────────────────────────────
socket.on('connect', () => {
  const action = sessionStorage.getItem('pendingAction');
  if (action === 'create') {
    sessionStorage.removeItem('pendingAction');
    socket.emit('create_room');
  } else if (action === 'join') {
    const code = sessionStorage.getItem('pendingCode');
    const team = sessionStorage.getItem('pendingTeam');
    sessionStorage.removeItem('pendingAction');
    sessionStorage.removeItem('pendingCode');
    sessionStorage.removeItem('pendingTeam');
    if (code && team) socket.emit('join_room', { roomId: code, team });
  } else {
    // No fresh action — but if we were in a room before (reload / server
    // restart), try to reclaim our seat automatically by the stored code.
    const savedRoom = sessionStorage.getItem('myRoomId');
    const savedRole = sessionStorage.getItem('myRole');
    if (savedRoom && savedRole === 'facilitator') socket.emit('rejoin_room', { roomId: savedRoom });
    else if (savedRoom && (savedRole === 'blue' || savedRole === 'red')) socket.emit('join_room', { roomId: savedRoom, team: savedRole });
  }
});

// Facilitador: sala criada (ou reassumida via rejoin_room)
socket.on('room_created', ({ roomId, role, ob, capabilityFactors, capabilityFactorDefs }) => {
  myRole = role || 'facilitator';
  if (myRole === 'facilitator') {
    sessionStorage.setItem('myRoomId', roomId);
    sessionStorage.setItem('myRole', 'facilitator');
    lobbyScreen.classList.add('hidden');
    configScreen.classList.remove('hidden');
    facInit(roomId, ob, capabilityFactors, capabilityFactorDefs);
  }
});

// Facilitador: OB recalculada (após ligar/desligar fatores PBC)
socket.on('ob_updated', data => {
  if (myRole === 'facilitator' && typeof facHandleObUpdated === 'function') facHandleObUpdated(data);
});

// Facilitador: progresso das simulações em lote (chunks assíncronos)
socket.on('batch_progress', ({ done, total }) => {
  const btn = document.getElementById('fac-batch-btn');
  if (btn) btn.textContent = `⌛ Gerando ${done}/${total}...`;
});

// Facilitador: resultados das simulações em lote (IA × IA)
socket.on('batch_simulation_results', data => {
  if (myRole === 'facilitator' && typeof facHandleBatchResults === 'function') facHandleBatchResults(data);
});

// Facilitador: um jogador humano caiu e a IA assumiu a equipe (sem travar o jogo)
socket.on('player_ai_takeover', ({ team }) => {
  if (typeof showFacNotice === 'function') {
    showFacNotice(`⚠ ${team === 'blue' ? 'Azul' : 'Vermelho'} desconectou — IA assumiu a equipe.`);
  }
});

// ─── Timer de turno ────────────────────────────────────────────────────────────
let _turnTimerInterval = null;
function stopTurnTimerDisplay() {
  if (_turnTimerInterval) { clearInterval(_turnTimerInterval); _turnTimerInterval = null; }
  document.getElementById('turn-timer-display')?.classList.add('hidden');
}
socket.on('turn_deadline', ({ deadline }) => {
  const disp = document.getElementById('turn-timer-display');
  const secsEl = document.getElementById('turn-timer-secs');
  if (!disp || !secsEl) return;
  if (_turnTimerInterval) { clearInterval(_turnTimerInterval); _turnTimerInterval = null; }
  if (!deadline) { disp.classList.add('hidden'); return; }
  disp.classList.remove('hidden');
  const tick = () => {
    const rem = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    secsEl.textContent = rem;
    disp.classList.toggle('urgent', rem <= 10);
    if (rem <= 0) { clearInterval(_turnTimerInterval); _turnTimerInterval = null; }
  };
  tick();
  _turnTimerInterval = setInterval(tick, 500);
});
socket.on('turn_timeout', ({ teams }) => {
  stopTurnTimerDisplay();
  const mine = teams && teams.includes(myRole);
  if (mine) flashError('⏱ Tempo esgotado — a IA agiu por você nesta fase.');
  else if (typeof showFacNotice === 'function') showFacNotice(`⏱ Tempo esgotado — IA agiu por ${teams.map(t => t === 'blue' ? 'Azul' : 'Vermelho').join(', ')}.`);
});

// ─── Mensagem iniciada pelo jogador ────────────────────────────────────────────
socket.on('player_message', () => {
  // O estado (state.messages) é re-renderizado via facBroadcast; aqui só avisamos.
  if (typeof showFacNotice === 'function') showFacNotice('✉ Nova mensagem de um jogador.');
});
function playerSendMessage() {
  const el = document.getElementById('player-msg-compose');
  const text = el?.value.trim();
  if (!text) return;
  socket.emit('player_message', { text });
  el.value = '';
  flashError('Mensagem enviada ao facilitador.');
}

// Jogador: entrou com sucesso
socket.on('join_success', ({ role, roomId }) => {
  myRole = role;
  sessionStorage.setItem('myRoomId', roomId);
  sessionStorage.setItem('myRole', role);
  lobbyScreen.classList.add('hidden');
  showWaitingForFacilitator(role);
});

socket.on('join_error', msg => {
  // A failed auto-rejoin (stale/expired room) should just drop us to the
  // lobby quietly rather than nag with an error.
  const wasAutoRejoin = sessionStorage.getItem('myRoomId') && !sessionStorage.getItem('pendingAction');
  sessionStorage.removeItem('myRoomId');
  sessionStorage.removeItem('myRole');
  if (!wasAutoRejoin) showLobbyErr(msg);
});

// Facilitador: jogador conectou
socket.on('player_joined', data => {
  facUpdatePlayerStatus(data);
});

// Jogo iniciado
socket.on('game_start', ({ role, state }) => {
  myRole = role;
  gameState = state;
  selUnitId = null; selGroupIds = []; moveHexes = []; atkHexes = []; pendingAtks = [];
  activePath = []; plannedMoves.clear(); hideStackPicker();
  closeBrPanel();
  lobbyScreen.classList.add('hidden');
  configScreen.classList.add('hidden');
  $('waiting-screen').classList.add('hidden');
  gameScreen.classList.remove('hidden');
  gameOver.classList.add('hidden');
  if (myRole === 'facilitator') setupFacilitatorUI();
  updateUI(); render();
});

socket.on('game_update', state => {
  const prevTurn   = gameState?.turn;
  const prevPhase  = gameState?.phase;
  const prevMyDone = myRole && gameState && myRole !== 'facilitator'
    ? (myRole === 'blue' ? gameState.blueDone : gameState.redDone)
    : false;

  gameState = state;

  const myDoneNow = myRole === 'blue' ? state.blueDone : state.redDone;
  const shouldReset = state.turn !== prevTurn
    || (prevPhase === 'combat' && state.phase === 'movement')
    || (state.phase === 'movement' && prevMyDone && !myDoneNow);

  if (shouldReset) {
    activePath = []; plannedMoves.clear(); selGroupIds = [];
    selUnitId = null; moveHexes = []; atkHexes = [];
    hideStackPicker(); closeBrPanel();
  } else if (selUnitId) {
    const u = gameState.units.find(u => u.id === selUnitId && u.hp > 0);
    if (u) {
      if (selGroupIds.length > 0) {
        const gUnits = gameState.units.filter(u => selGroupIds.includes(u.id) && u.hp > 0);
        if (gUnits.length > 0) recalcHighlightsGroup(gUnits); else deselect();
      } else {
        recalcHighlights(u);
      }
    } else { deselect(); }
  }

  // Facilitador: atualiza painéis
  if (myRole === 'facilitator') {
    facUpdatePhaseUI(state.phase);
    facRenderMessages(state.messages || []);
    facRenderUnitManager(state);
  }

  // Aprovação de combate: abre painel automaticamente
  if (myRole === 'facilitator' && state.phase === 'combat_approval') {
    facShowCombatApproval(state);
  }

  updateUI(); render();
});

// Facilitador: aprovação de movimentos solicitada
socket.on('movement_approval_needed', state => {
  gameState = state;
  if (myRole === 'facilitator') {
    facShowMovementApproval(state);
    facRenderUnitManager(state);
  }
  updateUI(); render();
});

// Facilitador: aprovação de combate solicitada
socket.on('combat_approval_needed', state => {
  gameState = state;
  if (myRole === 'facilitator') {
    facShowCombatApproval(state);
    facRenderUnitManager(state);
  }
  updateUI(); render();
});

socket.on('game_over', ({ winner, state }) => {
  if (state) gameState = state;
  if (gameState) gameState.winner = winner;
  updateUI(); render();
  if (myRole !== 'facilitator') {
    const mine = winner === myRole;
    winnerMsg.textContent = mine ? '🏆 VITÓRIA! Sua força prevaleceu.' : '💀 DERROTA. Sua frota foi afundada.';
    winnerMsg.className   = mine ? 'victory' : 'defeat';
  } else {
    winnerMsg.textContent = winner === 'blue' ? '🏆 Força Azul venceu.' : '🏆 Força Vermelha venceu.';
    winnerMsg.className   = 'victory';
  }
  gameOver.classList.remove('hidden');
});

socket.on('player_disconnected', ({ role }) => {
  flashError(`${role === 'blue' ? 'Azul' : role === 'red' ? 'Vermelho' : 'Facilitador'} desconectou.`);
});
socket.on('opponent_disconnected', () => disconnected.classList.remove('hidden'));

socket.on('action_error', msg => {
  flashError(msg);
  if (gameState?.phase === 'movement' && myRole !== 'facilitator') {
    if (myRole === 'blue') gameState.blueDone = false; else gameState.redDone = false;
    updateUI();
  }
});

socket.on('combat_results', data => handleCombatResults(data));

socket.on('fuel_alert', ({ name, type }) => {
  const msg = type === 'air_lost'
    ? `✈ ${name} perdida por falta de combustível!`
    : `⛽ ${name} sem combustível — imóvel e indefesa.`;
  flashError(msg);
});

// Mensagem do facilitador (para jogadores)
socket.on('facilitator_message', msg => {
  if (myRole === 'facilitator') return;
  showPlayerMessage(msg);
});

// Resposta de jogador (para facilitador)
socket.on('player_reply', ({ messageId, reply }) => {
  if (myRole !== 'facilitator') return;
  if (gameState?.messages) {
    const m = gameState.messages.find(m => m.id === messageId);
    if (m) m.replies.push(reply);
    facRenderMessages(gameState.messages);
  }
});

// ─── Lobby ─────────────────────────────────────────────────────────────────────────
$('btn-create-fac').addEventListener('click', () => socket.emit('create_room'));

$('btn-join-blue').addEventListener('click', () => {
  const code = roomInput.value.trim().toUpperCase();
  if (!code) return;
  socket.emit('join_room', { roomId: code, team: 'blue' });
});

$('btn-join-red').addEventListener('click', () => {
  const code = roomInput.value.trim().toUpperCase();
  if (!code) return;
  socket.emit('join_room', { roomId: code, team: 'red' });
});

roomInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join-blue').click(); });

function showWaitingForFacilitator(role) {
  const el = $('waiting-screen');
  el.classList.remove('hidden');
  const label = role === 'blue' ? 'FORÇA AZUL' : 'FORÇA VERMELHA';
  const cls   = role === 'blue' ? 'blue' : 'red';
  el.querySelector('.waiting-role').textContent  = label;
  el.querySelector('.waiting-role').className    = `waiting-role ${cls}`;
}

// ─── Jogador: popup de mensagem ─────────────────────────────────────────────────────────────
let _currentMsgId = null;

function showPlayerMessage(msg) {
  const overlay = $('player-msg-overlay');
  const textEl  = $('player-msg-text');
  const idEl    = $('player-msg-id');
  if (!overlay) return;
  textEl.textContent = msg.text;
  idEl.dataset.msgid = msg.id;
  _currentMsgId = msg.id;
  overlay.classList.remove('hidden');
}

function playerSendReply() {
  const input = $('player-msg-reply');
  const text  = input?.value?.trim();
  if (!text || !_currentMsgId) return;
  socket.emit('player_reply', { messageId: _currentMsgId, text });
  input.value = '';
  $('player-msg-overlay').classList.add('hidden');
  _currentMsgId = null;
}

function playerDismissMessage() {
  $('player-msg-overlay').classList.add('hidden');
  _currentMsgId = null;
}

// ─── Config: tab switching (delegated from HTML onclick) ──────────────────────────────────────
function facSwitchTabWrapper(team) { facSwitchTab(team); }

// ─── Facilitador: setup pós game_start ──────────────────────────────────────────────────
function setupFacilitatorUI() {
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) sidebar.classList.add('fac-sidebar');
  $('fac-panels').classList.remove('hidden');
  $('player-panels').classList.add('hidden');
}

// ─── Game actions (players only) ─────────────────────────────────────────────────────────────────
if (endPhaseBtn) endPhaseBtn.addEventListener('click', () => {
  if (!isMyTurn()) return;
  if (selUnitId !== null && activePath.length > 1) {
    const ids = selGroupIds.length > 0 ? selGroupIds : [selUnitId];
    for (const id of ids) plannedMoves.set(id, [...activePath]);
  }
  const moves = [];
  for (const [unitId, path] of plannedMoves) {
    if (path.length > 1) moves.push({ unitId, path });
  }
  socket.emit('commit_moves', { moves });
  if (myRole === 'blue') gameState.blueDone = true; else gameState.redDone = true;
  activePath = []; plannedMoves.clear(); selGroupIds = [];
  selUnitId = null; moveHexes = []; atkHexes = [];
  hideStackPicker(); updateUI(); render();
});

if (combatBtn) combatBtn.addEventListener('click', () => {
  if (!isMyTurn()) return;
  socket.emit('declare_attacks', pendingAtks);
  pendingAtks = []; deselect();
});

if (undoStepBtn) undoStepBtn.addEventListener('click', () => undoStep());
if (cancelBtn)   cancelBtn.addEventListener('click',   () => { hideStackPicker(); deselect(false); });

$('btn-restart')?.addEventListener('click', () => { socket.emit('restart'); gameOver.classList.add('hidden'); });
$('br-btn-ok')?.addEventListener('click',       () => onBrOk());
$('btn-back')?.addEventListener('click',        () => location.reload());

$('unit-panel')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-atk-adj]');
  if (!btn) return;
  const attackerId = btn.dataset.attacker;
  const targetId   = btn.dataset.target;
  const delta      = Number(btn.dataset.atk_adj);
  const atk = pendingAtks.find(a => a.attackerId === attackerId && a.targetId === targetId);
  if (!atk) return;
  const maxAmt = Number(btn.dataset.max) || 4;
  atk.amount = Math.max(1, Math.min(maxAmt, (atk.amount || 1) + delta));
  updateUI(); render();
});

// ─── Canvas input ───────────────────────────────────────────────────────────────────────
canvas.addEventListener('mousemove', e => {
  const r  = canvas.getBoundingClientRect();
  const sx = canvas.width  / r.width;
  const sy = canvas.height / r.height;
  const h  = pixelToHex((e.clientX - r.left) * sx, (e.clientY - r.top) * sy);
  hoverHex = h;
  if (h.col >= 0 && h.col < GRID_W && h.row >= 0 && h.row < GRID_H) {
    const t = TERRAIN_MAP[h.row][h.col];
    const inf = INFRA.filter(i => i.col === h.col && i.row === h.row);
    let tip = `${hexLabel(h.col)}${h.row+1} · ${T_NAME[t]}`;
    if (inf.length) tip += ' · ' + inf.map(i => i.name).join(', ');
    terrainTip.textContent = tip;
    terrainTip.style.display = 'block';
  } else {
    terrainTip.style.display = 'none';
  }
  render();
});
canvas.addEventListener('mouseleave', () => { hoverHex = null; terrainTip.style.display='none'; render(); });

canvas.addEventListener('click', e => {
  if (!gameState) return;
  const r  = canvas.getBoundingClientRect();
  const sx = canvas.width  / r.width;
  const sy = canvas.height / r.height;
  const h  = pixelToHex((e.clientX - r.left) * sx, (e.clientY - r.top) * sy);
  handleClick(h.col, h.row);
});

// Touch support: a tap resolves to the same hex/action as a click, and a touch
// move updates the hover/terrain tip (mobile/tablet parity with the mouse).
function hexFromTouch(t) {
  const r  = canvas.getBoundingClientRect();
  const sx = canvas.width  / r.width;
  const sy = canvas.height / r.height;
  return pixelToHex((t.clientX - r.left) * sx, (t.clientY - r.top) * sy);
}
canvas.addEventListener('touchstart', e => {
  if (!gameState || !e.touches[0]) return;
  const h = hexFromTouch(e.touches[0]);
  hoverHex = { col: h.col, row: h.row };
  render();
}, { passive: true });
canvas.addEventListener('touchend', e => {
  if (!gameState || !e.changedTouches[0]) return;
  e.preventDefault(); // suppress the synthetic click that would double-fire
  const h = hexFromTouch(e.changedTouches[0]);
  handleClick(h.col, h.row);
}, { passive: false });

// ─── Click logic ─────────────────────────────────────────────────────────────────────────
function handleClick(col, row) {
  if (!gameState || gameState.winner) return;
  if (col < 0 || col >= GRID_W || row < 0 || row >= GRID_H) return;

  // Facilitador: reposicionamento de unidade
  if (myRole === 'facilitator') {
    // Durante aprovação de movimentos: reposicionamento temporário
    if (gameState.phase === 'movement_approval' && facHandleMapClickForRepo(col, row)) {
      // Aplica override visual (simulado via reposition)
      socket.emit('facilitator_reposition', { unitId: facRepoUnitId || '', col, row });
      return;
    }
    // Fora de aprovação: reposicionamento imediato
    if (facRepoUnitId) {
      socket.emit('facilitator_reposition', { unitId: facRepoUnitId, col, row });
      facRepoUnitId = null;
      showFacNotice(`Unidade movida para ${String.fromCharCode(65+col)}${row+1}`);
      return;
    }

    // Facilitador pode selecionar unidade para reposicionar
    const anyUnit = gameState.units.filter(u => u.col === col && u.row === row && u.hp > 0);
    if (anyUnit.length > 0) {
      facRepoUnitId = anyUnit[0].id;
      showFacNotice(`${anyUnit[0].name} selecionada. Clique no mapa para mover.`);
    }
    return;
  }

  // Jogadores
  const {phase} = gameState;
  if (!stackPicker.classList.contains('hidden')) { hideStackPicker(); return; }

  if (phase === 'movement_approval' || phase === 'combat_approval') return; // aguardando facilitador

  if (phase === 'combat') {
    if (isMyTurn() && selUnitId !== null) {
      const atk = atkHexes.find(h => h.col === col && h.row === row);
      if (atk) {
        if (selGroupIds.length > 0) {
          const allDeclared = selGroupIds.every(id => pendingAtks.some(a => a.attackerId === id && a.targetId === atk.unitId));
          if (allDeclared) {
            pendingAtks = pendingAtks.filter(a => !(selGroupIds.includes(a.attackerId) && a.targetId === atk.unitId));
          } else {
            for (const id of selGroupIds) {
              const gu = gameState.units.find(u => u.id === id && u.hp > 0);
              if (!gu) continue;
              if (rangeAgainst(gu.attackRange, atk.category) >= 1 &&
                  hexDist(gu.col, gu.row, atk.col, atk.row) <= rangeAgainst(gu.attackRange, atk.category) &&
                  !pendingAtks.some(a => a.attackerId === id && a.targetId === atk.unitId)) {
                pendingAtks.push({ attackerId: id, targetId: atk.unitId, amount: 1 });
              }
            }
          }
        } else {
          const idx = pendingAtks.findIndex(a => a.attackerId === selUnitId && a.targetId === atk.unitId);
          if (idx >= 0) pendingAtks.splice(idx, 1);
          else pendingAtks.push({ attackerId: selUnitId, targetId: atk.unitId, amount: 1 });
        }
        updateUI(); render(); return;
      }
    }
    const ownUnits = gameState.units.filter(u => u.col === col && u.row === row && u.hp > 0 && u.team === myRole);
    if (ownUnits.length > 1) { showStackPicker(col, row, ownUnits); return; }
    if (ownUnits.length === 1) {
      selGroupIds = []; selUnitId = ownUnits[0].id;
      recalcHighlights(ownUnits[0]); updateUI(); render();
    } else { deselect(); }
    return;
  }

  if (phase === 'movement' && isMyTurn()) {
    if (selUnitId !== null) {
      const move = moveHexes.find(h => h.col === col && h.row === row);
      if (move) {
        activePath.push({ col, row });
        if (selGroupIds.length > 0) {
          const gUnits = gameState.units.filter(u => selGroupIds.includes(u.id) && u.hp > 0);
          recalcHighlightsGroup(gUnits);
        } else {
          const u = gameState.units.find(u => u.id === selUnitId && u.hp > 0);
          if (u) recalcHighlights(u);
        }
        updateUI(); render(); return;
      }
    }
    const ownUnits = gameState.units.filter(u => u.col === col && u.row === row && u.hp > 0 && u.team === myRole);
    if (ownUnits.length === 0) { deselect(true); return; }
    if (ownUnits.length > 1)   { deselect(true); showStackPicker(col, row, ownUnits); return; }
    const unit = ownUnits[0];
    if (selUnitId === unit.id && selGroupIds.length === 0) return;
    deselect(true);
    selUnitId = unit.id; selGroupIds = [];
    const saved = plannedMoves.get(unit.id);
    activePath = saved ? [...saved] : [{ col: unit.col, row: unit.row }];
    recalcHighlights(unit); updateUI(); render();
  }
}

function deselect(save = true) {
  if (selUnitId !== null) {
    const ids = selGroupIds.length > 0 ? selGroupIds : [selUnitId];
    if (save && activePath.length > 1) {
      for (const id of ids) plannedMoves.set(id, [...activePath]);
    } else if (!save) {
      for (const id of ids) plannedMoves.delete(id);
    }
  }
  selUnitId = null; selGroupIds = []; activePath = []; moveHexes = []; atkHexes = [];
  updateUI(); render();
}

function undoStep() {
  if (activePath.length <= 1) return;
  activePath.pop();
  if (selGroupIds.length > 0) {
    const gUnits = gameState?.units.filter(u => selGroupIds.includes(u.id) && u.hp > 0) || [];
    if (gUnits.length > 0) recalcHighlightsGroup(gUnits);
  } else {
    const u = gameState?.units.find(u => u.id === selUnitId && u.hp > 0);
    if (u) recalcHighlights(u);
  }
  updateUI(); render();
}

function recalcHighlightsGroup(units) {
  const {phase} = gameState;
  if (phase === 'movement' && isMyTurn()) {
    const minMov    = Math.min(...units.map(u => u.movement));
    const stepsTaken= activePath.length - 1;
    if (stepsTaken < minMov) {
      const lastHex = activePath[activePath.length - 1];
      const inPath  = new Set(activePath.map(h => `${h.col},${h.row}`));
      moveHexes = hexNeighbors(lastHex.col, lastHex.row).filter(nb => {
        if (inPath.has(`${nb.col},${nb.row}`)) return false;
        return units.every(u => canEnterTerrain(u.category, TERRAIN_MAP[nb.row][nb.col]));
      });
    } else { moveHexes = []; }
  } else { moveHexes = []; }

  if (phase === 'combat' && isMyTurn()) {
    atkHexes = [];
    const enemies = gameState.units.filter(u => u.team !== myRole && u.team !== 'neutral' && u.hp > 0 && u.detected);
    for (const e of enemies) {
      if (units.some(u => hexDist(u.col, u.row, e.col, e.row) <= rangeAgainst(u.attackRange, e.category))) {
        atkHexes.push({ col: e.col, row: e.row, unitId: e.id, category: e.category });
      }
    }
  } else { atkHexes = []; }
}

function showStackPicker(col, row, units) {
  spList.innerHTML = '';
  for (const u of units) {
    const btn = document.createElement('button');
    btn.className = 'sp-unit-btn';
    const c = u.team === 'blue' ? 'var(--blue-l)' : u.team === 'red' ? 'var(--red-l)' : '#aaffaa';
    btn.innerHTML = `<span style="color:${c}">${u.name}</span> · ${u.hp}/${u.maxHp}SP`;
    btn.addEventListener('click', () => { hideStackPicker(); _selectUnit(u); });
    spList.appendChild(btn);
  }
  spGroupBtn.onclick = () => { hideStackPicker(); _selectGroup(units); };
  const {x, y} = hexToPixel(col, row);
  const rect   = canvas.getBoundingClientRect();
  const wrap   = canvas.parentElement.getBoundingClientRect();
  const scale  = rect.width / canvas.width;
  const sx = rect.left - wrap.left + x * scale;
  const sy = rect.top  - wrap.top  + (y + HEX_R) * scale + 6;
  stackPicker.style.left = `${Math.round(sx - 85)}px`;
  stackPicker.style.top  = `${Math.round(sy)}px`;
  stackPicker.classList.remove('hidden');
}

function hideStackPicker() { stackPicker.classList.add('hidden'); }

function _selectUnit(unit) {
  selGroupIds = [];
  if (gameState.phase === 'movement') {
    deselect(true);
    selUnitId = unit.id;
    const saved = plannedMoves.get(unit.id);
    activePath = saved ? [...saved] : [{ col: unit.col, row: unit.row }];
    recalcHighlights(unit);
  } else {
    selUnitId = unit.id; recalcHighlights(unit);
  }
  updateUI(); render();
}

function _selectGroup(units) {
  const ids = units.map(u => u.id);
  if (gameState.phase === 'movement') {
    deselect(true);
    selGroupIds = ids; selUnitId = ids[0];
    for (const id of ids) plannedMoves.delete(id);
    const lead = units[0];
    activePath = [{ col: lead.col, row: lead.row }];
    recalcHighlightsGroup(units);
  } else {
    selGroupIds = ids; selUnitId = ids[0];
    recalcHighlightsGroup(units);
  }
  updateUI(); render();
}

function recalcHighlights(unit) {
  const {phase} = gameState;
  if (phase === 'movement' && isMyTurn()) {
    const stepsTaken = activePath.length - 1;
    if (stepsTaken < unit.movement) {
      const lastHex = activePath[activePath.length - 1];
      const inPath  = new Set(activePath.map(h => `${h.col},${h.row}`));
      moveHexes = hexNeighbors(lastHex.col, lastHex.row).filter(nb => {
        if (inPath.has(`${nb.col},${nb.row}`)) return false;
        return canEnterTerrain(unit.category, TERRAIN_MAP[nb.row][nb.col]);
      });
    } else { moveHexes = []; }
  } else { moveHexes = []; }

  if (phase === 'combat' && isMyTurn()) {
    atkHexes = [];
    const enemies = gameState.units.filter(u => u.team !== myRole && u.team !== 'neutral' && u.hp > 0 && u.detected);
    for (const e of enemies) {
      if (hexDist(unit.col, unit.row, e.col, e.row) <= rangeAgainst(unit.attackRange, e.category)) {
        atkHexes.push({ col: e.col, row: e.row, unitId: e.id, category: e.category });
      }
    }
  } else { atkHexes = []; }
}

function isMyTurn() {
  if (!gameState || myRole === 'facilitator') return false;
  const {phase, blueDone, redDone} = gameState;
  if (phase === 'movement') return myRole === 'blue' ? !blueDone : !redDone;
  if (phase === 'combat')   return myRole === 'blue' ? gameState.blueAttacks === null : gameState.redAttacks === null;
  return false;
}

// ─── UI update ────────────────────────────────────────────────────────────────────────
function updateUI() {
  if (!gameState) return;
  const {turn, period, phase, units, log, winner} = gameState;

  if (myRole === 'facilitator') {
    teamBadge.textContent = 'FACILITADOR';
    teamBadge.className   = 'team-badge fac';
  } else {
    teamBadge.textContent = myRole === 'blue' ? 'FORÇA AZUL' : 'FORÇA VERMELHA';
    teamBadge.className   = `team-badge ${myRole}`;
  }

  turnLabel.textContent  = `Turno ${turn}`;
  periodLabel.textContent= period === 'day' ? '☀ Diurno' : '🌙 Noturno';

  const phaseLabels = {
    movement: 'Movimentação',
    movement_approval: 'Aprovação de Movimentos',
    combat: 'Combate',
    combat_approval: 'Aprovação de Combate',
  };
  phaseLabel.textContent = phaseLabels[phase] || phase;

  myTurnBanner.classList.toggle('visible', isMyTurn() && !winner);

  // Esconder botões de ação para facilitador e para fases de aprovação
  const isApprovalPhase = phase === 'movement_approval' || phase === 'combat_approval';
  if (endPhaseBtn) endPhaseBtn.classList.add('hidden');
  if (combatBtn)   combatBtn.classList.add('hidden');
  if (undoStepBtn) undoStepBtn.classList.add('hidden');
  if (cancelBtn)   cancelBtn.classList.toggle('hidden', selUnitId === null);

  if (myRole !== 'facilitator' && isMyTurn() && !winner && !isApprovalPhase) {
    if (phase === 'movement') {
      endPhaseBtn.classList.remove('hidden');
      const n = plannedMoves.size + (selUnitId !== null && activePath.length > 1 && !plannedMoves.has(selUnitId) ? 1 : 0);
      endPhaseBtn.textContent = n > 0 ? `Encerrar Movimentação (${n})` : 'Encerrar Movimentação';
      if (selUnitId !== null && activePath.length > 1) undoStepBtn.classList.remove('hidden');
    }
    if (phase === 'combat') combatBtn.classList.remove('hidden');
  }
  if (combatBtn) combatBtn.textContent = `Confirmar Ataques (${pendingAtks.length})`;

  // Mensagem de espera para jogadores em fases de aprovação
  const waitBanner = $('waiting-approval-banner');
  if (waitBanner) {
    waitBanner.classList.toggle('hidden', !isApprovalPhase || myRole === 'facilitator');
    if (isApprovalPhase) {
      waitBanner.textContent = phase === 'movement_approval'
        ? '⌛ Aguardando aprovação do Facilitador (movimentos)...'
        : '⌛ Aguardando aprovação do Facilitador (combate)...';
    }
  }

  const b = units.filter(u => u.team === 'blue'    && u.hp > 0).length;
  const r = units.filter(u => u.team === 'red'     && u.hp > 0).length;
  const n = units.filter(u => u.team === 'neutral' && u.hp > 0).length;
  fleetBlue.textContent = `Azul: ${b}`;
  fleetRed.textContent  = `Verm: ${r}`;
  const fleetNeu = $('fleet-neutral');
  if (fleetNeu) fleetNeu.textContent = `Neut: ${n}`;

  // Unit info panel
  const sel = selUnitId ? gameState.units.find(u => u.id === selUnitId && u.hp > 0) : null;
  if (sel && unitPanel) {
    const hpPct = sel.hp / sel.maxHp * 100;
    const bar   = hpPct > 60 ? '#69f0ae' : hpPct > 30 ? '#ffca28' : '#ff5252';
    const t     = sel.col >= 0 ? TERRAIN_MAP[sel.row][sel.col] : 3;
    const pathSteps    = activePath.length - 1;
    const pathStepsMov = selGroupIds.length > 0
      ? Math.min(...selGroupIds.map(id => { const u2=gameState.units.find(u=>u.id===id); return u2?u2.movement:99; }))
      : sel.movement;
    const pathHint   = pathSteps > 0 ? `<div class="u-hint">Caminho: ${pathSteps}/${pathStepsMov} passo(s)</div>` : '';
    const groupHint  = selGroupIds.length > 1 ? `<div class="u-hint">Grupo: ${selGroupIds.length} unidades</div>` : '';
    const myAtks     = selGroupIds.length > 0
      ? pendingAtks.filter(a => selGroupIds.includes(a.attackerId))
      : pendingAtks.filter(a => a.attackerId === sel.id);
    const det  = sel.detectionRange || {};
    const comp = (sel.composition||[]).map(c=>`${c.quantity}× ${c.type}`).join(' · ');
    const wpns = sel.weapons || {};
    const initW= sel.initWeapons || {};
    const wpnLines = Object.entries(wpns)
      .filter(([,w])=>w.quantity>0||(initW[w]?.quantity??0)>0)
      .map(([k,w])=>`${k.toUpperCase()}: <b>${w.quantity}</b>/${initW[k]?.quantity??w.quantity}`);
    const caps = sel.capabilities || {};
    const capLines = Object.entries(caps).filter(([,v])=>v>0).map(([k,v])=>`${k.toUpperCase()}: ${v}`);
    const teamColor = sel.team === 'blue' ? 'blue' : sel.team === 'red' ? 'red' : 'neutral';

    // Botão de gerenciamento rápido para facilitador
    const facBtn = myRole === 'facilitator'
      ? `<div style="margin-top:6px;display:flex;gap:4px;">
          <button class="fac-small-btn" style="flex:1" onclick="facQuickEditUnit('${sel.id}','${sel.name}',${sel.hp},${sel.maxHp})">✏ Editar SP</button>
          <button class="fac-small-btn" style="flex:1" onclick="facSelectRepoUnit('${sel.id}')">📍 Mover</button>
         </div>` : '';

    unitPanel.innerHTML = `
      <div class="u-name ${teamColor}">${sel.name}</div>
      <div class="hp-bar"><div class="hp-fill" style="width:${hpPct}%;background:${bar}"></div></div>
      <div class="u-stats">
        <span>SP</span><span>${sel.hp}/${sel.maxHp}</span>
        <span>MOV</span><span>${sel.movement}</span>
        <span>Equipe</span><span>${sel.team}</span>
        ${fuelRow(sel)}
        <span>Det S/Aé/Sb/T</span><span>${det.surface||0}/${det.air||0}/${det.submarine||0}/${det.land||0}</span>
        <span>Terreno</span><span style="font-size:0.7em">${T_NAME[t]}</span>
      </div>
      ${wpnLines.length ? `<div class="u-hint" style="font-size:0.67rem;line-height:1.7">🚀 ${wpnLines.join(' · ')}</div>` : ''}
      ${capLines.length ? `<div class="u-hint" style="color:var(--text-dim);font-size:0.67rem;line-height:1.7">⚙ ${capLines.join(' · ')}</div>` : ''}
      ${comp ? `<div class="u-hint" style="color:var(--dim);font-size:0.67rem;line-height:1.5">${comp}</div>` : ''}
      ${groupHint}${pathHint}
      ${atkHexes.length && myRole !== 'facilitator' ? '<div class="u-hint">Clique em alvos vermelhos p/ declarar ataque</div>' : ''}
      ${myAtks.length ? buildAtkListHtml(myAtks) : ''}
      ${facBtn}
    `;
  } else if (unitPanel) {
    const hint = myRole === 'facilitator'
      ? '<p class="no-sel">Clique em qualquer unidade para ver detalhes</p>'
      : '<p class="no-sel">Clique em uma unidade sua</p>';
    unitPanel.innerHTML = hint;
  }

  logEl.innerHTML = (log||[]).map(l=>`<p>${l}</p>`).join('');
}

function fuelRow(unit) {
  const f = unit.fuel;
  if (!f || !f.usesFuel) return `<span>Combustível</span><span class="fp-inf">∞</span>`;
  if (unit.category === 'air') {
    const STATUS = { ready:'Pronta', airborne:'Em voo', recovering:'Reabastecendo' };
    const statusLabel = STATUS[unit.airStatus] || unit.airStatus || '—';
    const fpLabel = unit.airStatus === 'ready' || unit.airStatus === 'recovering'
      ? `${f.max} FP` : `${f.current??0}/${f.max} FP`;
    const fpClass = (f.current??f.max) <= Math.ceil(f.max*0.25) ? 'fp-low' : 'fp-ok';
    return `<span>Status</span><span>${statusLabel}</span>
            <span>Combustível</span><span class="${fpClass}">${fpLabel}</span>`;
  }
  const cur = f.current ?? 0;
  const pct = f.max > 0 ? cur / f.max : 0;
  const cls = cur <= 0 ? 'fp-empty' : pct <= 0.25 ? 'fp-low' : 'fp-ok';
  return `<span>Combustível</span><span class="${cls}">${cur}/${f.max} FP</span>`;
}

function buildAtkListHtml(atks) {
  if (!atks.length) return '';
  const items = atks.map(a => {
    const tgt    = gameState?.units.find(u => u.id === a.targetId);
    const tgtName= tgt?.name || a.targetId;
    const attUnit= gameState?.units.find(u => u.id === a.attackerId);
    const maxAmt = attUnit ? Math.max(1, ...Object.values(attUnit.weapons||{}).map(w=>w.quantity||0)) : 4;
    const amt    = a.amount || 1;
    return `<div class="atk-entry">
      <span class="atk-target">→ ${tgtName}</span>
      <span class="atk-amt-ctrl">
        <button class="atk-adj-btn" data-atk-adj data-attacker="${a.attackerId}" data-target="${a.targetId}" data-atk_adj="-1" data-max="${maxAmt}">−</button>
        <span class="atk-amt-val">${amt}</span>
        <button class="atk-adj-btn" data-atk-adj data-attacker="${a.attackerId}" data-target="${a.targetId}" data-atk_adj="1" data-max="${maxAmt}">+</button>
      </span>
    </div>`;
  }).join('');
  return `<div class="atk-list"><div class="atk-list-title">Ataques declarados:</div>${items}</div>`;
}

// ═══ RENDERING ═══════════════════════════════════════════════════════════════════════
function render() {
  if (!gameState) return;
  ctx.clearRect(0, 0, CVS_W, CVS_H);
  drawBackground();
  drawHighlights();
  drawGrid();
  drawInfrastructure();
  drawUnits();
  drawCoordLabels();
  if (hoverHex) drawHover();
}

function drawBackground() {
  if (mapReady) ctx.drawImage(mapImg, 0, 0, CVS_W, CVS_H);
  else {
    const g = ctx.createLinearGradient(0,0,CVS_W,CVS_H);
    g.addColorStop(0.0,'#0d2a45'); g.addColorStop(0.2,'#0a2238'); g.addColorStop(1.0,'#071520');
    ctx.fillStyle=g; ctx.fillRect(0,0,CVS_W,CVS_H);
  }
}

function drawHighlights() {
  for (const [unitId, path] of plannedMoves) {
    if (unitId === selUnitId) continue;
    drawPathTrail(path,'rgba(100,180,255,0.18)','rgba(100,180,255,0.55)','rgba(100,180,255,0.35)','rgba(100,180,255,0.85)');
  }
  if (selUnitId !== null && activePath.length > 1) {
    drawPathTrail(activePath,'rgba(255,220,0,0.20)','rgba(255,220,0,0.65)','rgba(255,220,0,0.40)','rgba(255,220,0,0.95)');
  }
  for (const h of moveHexes) {
    const {x,y}=hexToPixel(h.col,h.row);
    drawHex(ctx,x,y,'rgba(0,230,118,0.22)','rgba(0,230,118,0.70)',1.8);
  }
  for (const h of atkHexes) {
    const {x,y}=hexToPixel(h.col,h.row);
    const declared=pendingAtks.some(a=>a.targetId===h.unitId);
    drawHex(ctx,x,y,
      declared?'rgba(255,60,60,0.50)':'rgba(255,60,60,0.22)',
      declared?'rgba(255,120,120,1.0)':'rgba(255,80,80,0.75)',2.0);
  }
  // Destacar unidade selecionada para reposicionamento (facilitador)
  if (myRole === 'facilitator' && facRepoUnitId) {
    const repoUnit = gameState?.units.find(u => u.id === facRepoUnitId && u.hp > 0);
    if (repoUnit) {
      const {x,y} = hexToPixel(repoUnit.col, repoUnit.row);
      drawHex(ctx,x,y,'rgba(255,200,0,0.30)','rgba(255,200,0,1.0)',3.0);
    }
  }
}

function drawPathTrail(path, fillMid, strokeMid, fillLast, strokeLast) {
  for (let i = 1; i < path.length; i++) {
    const {col,row}=path[i];
    const {x,y}=hexToPixel(col,row);
    const isLast=i===path.length-1;
    drawHex(ctx,x,y,isLast?fillLast:fillMid,isLast?strokeLast:strokeMid,isLast?2.2:1.6);
    ctx.save();
    ctx.fillStyle='rgba(255,255,255,0.92)';
    ctx.font=`bold ${Math.round(HEX_R*0.30)}px sans-serif`;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='rgba(0,0,0,0.8)'; ctx.shadowBlur=3;
    ctx.fillText(String(i),x,y);
    ctx.restore();
  }
}

function drawGrid() {
  for (let r=0;r<GRID_H;r++) for (let c=0;c<GRID_W;c++) {
    const t=TERRAIN_MAP[r][c];
    const {x,y}=hexToPixel(c,r);
    drawHex(ctx,x,y,null,T_BORDER[t],0.8);
  }
}

const INFRA_COLORS={naval:'#82b1ff',port:'#80cbc4',aero:'#b0bec5',oil:'#ffcc02'};
function drawInfrastructure() {
  for (const inf of INFRA) {
    const {x,y}=hexToPixel(inf.col,inf.row);
    const col=INFRA_COLORS[inf.type]||'#fff';
    ctx.shadowColor='rgba(0,0,0,0.8)'; ctx.shadowBlur=4;
    ctx.fillStyle=col;
    ctx.font=`bold ${Math.round(HEX_R*0.38)}px sans-serif`;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(inf.label,x,y-HEX_R*0.1);
    ctx.shadowBlur=0;
    ctx.fillStyle='rgba(255,255,200,0.7)';
    ctx.font=`${Math.round(HEX_R*0.2)}px 'Courier New',monospace`;
    ctx.fillText(inf.name,x,y+HEX_R*0.38);
  }
}

function drawUnits() {
  if (!gameState) return;
  // Ghost destinations
  for (const [unitId,path] of plannedMoves) {
    if (path.length<=1) continue;
    const unit=gameState.units.find(u=>u.id===unitId&&u.hp>0);
    if (!unit) continue;
    const dest=path[path.length-1];
    const {x,y}=hexToPixel(dest.col,dest.row);
    ctx.save(); ctx.globalAlpha=0.35;
    ctx.beginPath(); ctx.arc(x,y,HEX_R*0.58,0,Math.PI*2); ctx.fillStyle='rgba(0,0,0,0.45)'; ctx.fill();
    drawUnitCounter(ctx,unit,x,y,false);
    ctx.restore();
  }
  if (selUnitId!==null&&activePath.length>1) {
    const unit=gameState.units.find(u=>u.id===selUnitId&&u.hp>0);
    if (unit) {
      const dest=activePath[activePath.length-1];
      const {x,y}=hexToPixel(dest.col,dest.row);
      ctx.save(); ctx.globalAlpha=0.40;
      ctx.beginPath(); ctx.arc(x,y,HEX_R*0.58,0,Math.PI*2); ctx.fillStyle='rgba(0,0,0,0.45)'; ctx.fill();
      drawUnitCounter(ctx,unit,x,y,false);
      ctx.restore();
    }
  }
  // Actual units
  for (const u of gameState.units) {
    if (u.hp<=0) continue;
    const {x,y}=hexToPixel(u.col,u.row);
    ctx.beginPath(); ctx.arc(x,y,HEX_R*0.58,0,Math.PI*2); ctx.fillStyle='rgba(0,0,0,0.45)'; ctx.fill();
    const isSelected=u.id===selUnitId||selGroupIds.includes(u.id);
    drawUnitCounter(ctx,u,x,y,isSelected);
  }
  // Stack badges
  const hexStacks={};
  for (const u of gameState.units) {
    if (u.hp<=0) continue;
    const k=`${u.col},${u.row}`;
    if (!hexStacks[k]) hexStacks[k]={col:u.col,row:u.row,count:0};
    hexStacks[k].count++;
  }
  for (const {col,row,count} of Object.values(hexStacks)) {
    if (count<2) continue;
    const {x,y}=hexToPixel(col,row);
    const r=HEX_R*0.22,bx=x+HEX_R*0.38,by=y-HEX_R*0.38;
    ctx.beginPath(); ctx.arc(bx,by,r,0,Math.PI*2);
    ctx.fillStyle='rgba(255,200,0,0.92)'; ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,0.6)'; ctx.lineWidth=1; ctx.stroke();
    ctx.fillStyle='#000';
    ctx.font=`bold ${Math.round(r*1.3)}px sans-serif`;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(String(count),bx,by);
  }
}

function drawCoordLabels() {
  ctx.shadowColor='rgba(0,0,0,0.8)'; ctx.shadowBlur=3;
  const fs=Math.round(HEX_R*0.27);
  ctx.fillStyle='rgba(200,220,240,0.55)';
  ctx.font=`${fs}px 'Courier New',monospace`;
  ctx.textAlign='center'; ctx.textBaseline='top';
  for (let c=0;c<GRID_W;c++){const {x}=hexToPixel(c,0);ctx.fillText(hexLabel(c),x,OY/2-6);}
  ctx.textAlign='right'; ctx.textBaseline='middle';
  for (let r=0;r<GRID_H;r++){const {y}=hexToPixel(0,r);ctx.fillText(r+1,OX-6,y);}
  ctx.shadowBlur=0;
}

function drawHover() {
  const {col,row}=hoverHex;
  if (col<0||col>=GRID_W||row<0||row>=GRID_H) return;
  const {x,y}=hexToPixel(col,row);
  drawHex(ctx,x,y,'rgba(255,255,255,0.08)','rgba(255,255,255,0.35)',1.2);
}

// ─── Utility ──────────────────────────────────────────────────────────────────────
function flashError(msg) {
  const el=$('error-flash');
  el.textContent=msg; el.classList.remove('hidden');
  clearTimeout(flashError._t);
  flashError._t=setTimeout(()=>el.classList.add('hidden'),3500);
}
function showLobbyErr(msg) {
  const lobbyErr=$('lobby-err');
  lobbyErr.textContent=msg; lobbyErr.classList.remove('hidden');
  setTimeout(()=>lobbyErr.classList.add('hidden'),4000);
}

// ─── Painel de Resultados de Combate ───────────────────────────────────
// Cada engajamento é resolvido em um único pulso da equação de salva — sem
// rodadas, decisões de continuar/parar ou contra-ataques. O painel apenas
// exibe os resultados, um de cada vez, com um botão OK/Próximo.
let brQueue=[];

function closeBrPanel() {
  $('br-panel').classList.add('hidden');
  brQueue=[];
}
function onBrOk() {
  if (brQueue.length>0) renderResultPanel(brQueue.shift());
  else closeBrPanel();
}
function handleCombatResults({results}) {
  brQueue=[...(results||[])];
  if (brQueue.length>0) renderResultPanel(brQueue.shift());
}
function buildResultHtml(eng) {
  if (!eng) return '<div class="br-row br-miss">⚠ Unidade já destruída — engajamento cancelado.</div>';
  if (!eng.ok) return `<div class="br-row br-miss">⚠ ${eng.reason||'Sem armamento válido.'}</div>`;
  const intStr=eng.interception?.pDefenseTotal>0
    ?`<span class="br-int"> [interceptação −${eng.interception.pDefenseTotal.toFixed(2)}]</span>`:'';
  const wpnTag=eng.weaponLabel?`<span class="br-wpn">[${eng.weaponLabel}]</span> `:'';
  let cls,icon,detail;
  if (eng.destroyed){cls='br-destroyed';icon='💥';detail=`−${eng.expectedLoss.toFixed(2)}SP <strong>DESTRUÍDO!</strong>`;}
  else if (eng.expectedLoss>1e-3){cls='br-hit';icon='✓';detail=`−${eng.expectedLoss.toFixed(2)}SP  (restante: ${eng.remainingHp.toFixed(2)}SP)`;}
  else{cls='br-miss';icon='✗';detail=`sem efeito  (restante: ${eng.remainingHp.toFixed(2)}SP)`;}
  return `<div class="br-row ${cls}">${icon} ${wpnTag}
    <span class="br-launched">Disparados: ${eng.launched}</span>${intStr}
    <div class="br-detail">${detail}</div>
  </div>`;
}
function renderResultPanel(engagement) {
  $('br-panel-header').textContent=`── ${engagement.id} ──`;
  let html='';
  const att=gameState?.units.find(u=>u.id===engagement.attackerId);
  const def=gameState?.units.find(u=>u.id===engagement.targetId);
  const attName=att?.name||engagement.attackerId,defName=def?.name||engagement.targetId;
  const attCls=att?.team==='blue'?'cm-blue':'cm-red';
  const defCls=def?.team==='blue'?'cm-blue':'cm-red';
  html+=`<div class="br-combatants"><span class="${attCls}">${attName}</span><span class="br-arrow"> → </span><span class="${defCls}">${defName}</span><span class="br-wpn-tag"> [${(engagement.weaponType||'').toUpperCase()}]</span></div>`;
  html+=buildResultHtml(engagement.result);
  $('br-panel-body').innerHTML=html;
  $('br-btn-ok').textContent=brQueue.length>0?'Próximo ▶':'OK ✓';
  $('br-ok-area').classList.remove('hidden');
  $('br-panel').classList.remove('hidden');
}
