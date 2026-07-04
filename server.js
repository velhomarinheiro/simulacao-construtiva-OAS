'use strict';
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const { ORDER_OF_BATTLE }  = require('./shared/order_of_battle');
const {
  newGame, stateFor, genUnitId, makeUnit,
  validateMoves, applyMoves, finalizeMovementPhase, applyMovementApproval,
  buildCombatQueue, resolveCombatQueue, finishCombatPhase, applyCombatApproval,
} = require('./shared/game_engine');
const {
  applyCapabilityConfig, CAPABILITY_FACTORS, FACTOR_KEYS, totalCost, countActive,
} = require('./shared/capability_factors');
const { decideMovement, decideAttacks } = require('./shared/bot/decision_engine');
const { createCulminationTracker, computeFinalMetrics } = require('./shared/metrics');
const { validateOB } = require('./shared/ob_io');
const persistence = require('./shared/persistence');

const PORT   = process.env.PORT || 3000;
const { GRID_W, GRID_H } = require('./shared/hexgrid');

// How long a room survives with no facilitator connected before it is reclaimed
// (grace period for a facilitator reload/reconnect). Overridable for tests.
const ROOM_GRACE_MS = Number(process.env.ROOM_GRACE_MS) || 15 * 60 * 1000;
// On-disk snapshot of rooms so in-progress games survive a server restart.
const PERSIST_FILE = process.env.PERSIST_FILE || path.join(__dirname, 'data', 'rooms.json');

// ─── Server ──────────────────────────────────────────────────────────
const app=express();
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:'*'}});

app.use(express.static(path.join(__dirname,'public')));
app.get('/',(_, res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/game',(_, res)=>res.sendFile(path.join(__dirname,'public','game.html')));
app.get('/favicon.ico',(_, res)=>res.status(204).end());
// Shared OB import/validation module, reused verbatim by the browser importer.
app.get('/shared/ob_io.js',(_, res)=>res.sendFile(path.join(__dirname,'shared','ob_io.js')));

const rooms=new Map();
function genId(){return Math.random().toString(36).slice(2,8).toUpperCase();}

function broadcast(room,event='game_update',extraPayload=null){
  if(!room.state) return;
  const emit=(pid,role)=>{
    if(!pid) return;
    const state=stateFor(room.state,role);
    if(event==='game_update') io.to(pid).emit('game_update',state);
    else if(event==='game_over'){io.to(pid).emit('game_over',{winner:room.state.winner,state});}
  };
  emit(room.players.blue,'blue');
  emit(room.players.red,'red');
  emit(room.players.facilitator,'facilitator');
  persistence.markDirty();
}

function facBroadcast(room){
  if(!room.state||!room.players.facilitator) return;
  io.to(room.players.facilitator).emit('game_update',stateFor(room.state,'facilitator'));
  persistence.markDirty();
}

// ─── Combat resolution wrappers (pure logic in shared/game_engine, I/O here) ──
function endCombatPhase(room){
  const state=room.state;
  const{winner}=finishCombatPhase(state);
  if(winner){
    clearTurnTimer(room);
    broadcast(room,'game_over',{winner,state:null});
    return;
  }
  if(room.players.facilitator) io.to(room.players.facilitator).emit('combat_approval_needed',stateFor(state,'facilitator'));
  broadcast(room);
}

function runCombatQueue(room){
  const state=room.state;
  resolveCombatQueue(state);
  if(room.players.blue) io.to(room.players.blue).emit('combat_results',{results:state.combatQueue});
  if(room.players.red)  io.to(room.players.red ).emit('combat_results',{results:state.combatQueue});
  if(room.players.facilitator) io.to(room.players.facilitator).emit('combat_results',{results:state.combatQueue});
  endCombatPhase(room);
}

// ─── Jogador digital (IA) — assume equipes sem jogador humano conectado ───
function commitMovesForTeam(room,team,moves){
  const{state}=room;
  const validation=validateMoves(state,team,moves);
  applyMoves(state,team,validation.ok?moves:[]);

  if(state.blueDone&&state.redDone){
    const{navalEmpty,airLost}=finalizeMovementPhase(state);
    for(const u of navalEmpty){
      const pid=room.players[u.team];
      if(pid) io.to(pid).emit('fuel_alert',{unitId:u.id,name:u.name,type:'naval_empty'});
    }
    for(const u of airLost){
      const pid=room.players[u.team];
      if(pid) io.to(pid).emit('fuel_alert',{unitId:u.id,name:u.name,type:'air_lost'});
    }
    if(room.players.facilitator) io.to(room.players.facilitator).emit('movement_approval_needed',stateFor(state,'facilitator'));
  }else{
    const waiting=team==='blue'?'Força Vermelha':'Força Azul';
    state.log.unshift(`${team==='blue'?'Força Azul':'Força Vermelha'} encerrou movimentação. Aguardando ${waiting}...`);
  }
  if(state.log.length>50) state.log=state.log.slice(0,50);
  broadcast(room);
}

function declareAttacksForTeam(room,team,attacks){
  const{state}=room;
  if(team==='blue') state.blueAttacks=attacks||[];else state.redAttacks=attacks||[];
  state.log.unshift(`${team==='blue'?'Força Azul':'Força Vermelha'} confirmou ${(attacks||[]).length} ataque(s).`);
  if(state.blueAttacks!==null&&state.redAttacks!==null){
    state.log.unshift('── Resolução de Combate ──');
    state.combatQueue=buildCombatQueue(state);
    broadcast(room);
    if(state.combatQueue.length===0) endCombatPhase(room);
    else runCombatQueue(room);
  }else{broadcast(room);}
}

// Executa as ações do(s) jogador(es) digitais para a fase atual, se houver
// equipe(s) sem jogador humano conectado (room.bots).
function runBotsForPhase(room){
  const{state}=room;
  if(!state) return;
  if(state.phase==='movement'){
    for(const team of ['blue','red']){
      if(!room.bots[team]) continue;
      if(state[team==='blue'?'blueDone':'redDone']) continue;
      commitMovesForTeam(room,team,decideMovement(stateFor(state,team),team));
    }
  }else if(state.phase==='combat'){
    for(const team of ['blue','red']){
      if(!room.bots[team]) continue;
      if(state[team==='blue'?'blueAttacks':'redAttacks']!==null) continue;
      declareAttacksForTeam(room,team,decideAttacks(stateFor(state,team),team));
    }
  }
}

// ─── Timer de turno (opcional) ───────────────────────────────────────────────
// Se o facilitador configurar um limite de tempo por fase, cada fase que aguarda
// uma equipe HUMANA recebe um prazo; ao expirar, a IA age pela(s) equipe(s)
// pendente(s), evitando que um jogador lento trave a partida.
function clearTurnTimer(room){ if(room.turnTimer){clearTimeout(room.turnTimer);room.turnTimer=null;} }
function emitToRoom(room,ev,payload){
  for(const pid of [room.players.blue,room.players.red,room.players.facilitator]) if(pid) io.to(pid).emit(ev,payload);
}
function pendingHumanTeams(room){
  const s=room.state; if(!s) return [];
  const out=[];
  for(const t of ['blue','red']){
    if(!room.players[t]) continue; // sem humano => IA já cobre
    if(s.phase==='movement'&&!s[t==='blue'?'blueDone':'redDone']) out.push(t);
    else if(s.phase==='combat'&&s[t==='blue'?'blueAttacks':'redAttacks']===null) out.push(t);
  }
  return out;
}
function armTurnTimer(room){
  clearTurnTimer(room);
  const s=room.state;
  if(!s||s.winner||!room.turnTimerSec){ emitToRoom(room,'turn_deadline',{deadline:null}); return; }
  if((s.phase!=='movement'&&s.phase!=='combat')||pendingHumanTeams(room).length===0){
    emitToRoom(room,'turn_deadline',{deadline:null}); return;
  }
  const ms=room.turnTimerSec*1000, deadline=Date.now()+ms;
  emitToRoom(room,'turn_deadline',{deadline,phase:s.phase});
  room.turnTimer=setTimeout(()=>forcePendingActions(room),ms);
  if(room.turnTimer.unref) room.turnTimer.unref();
}
function forcePendingActions(room){
  room.turnTimer=null;
  const s=room.state;
  if(!s||s.winner) return;
  const pend=pendingHumanTeams(room);
  if(pend.length===0){ emitToRoom(room,'turn_deadline',{deadline:null}); return; }
  s.log.unshift(`⏱ Tempo esgotado — IA agiu por ${pend.map(t=>t==='blue'?'Azul':'Vermelho').join(', ')}.`);
  emitToRoom(room,'turn_timeout',{teams:pend});
  if(s.phase==='movement'){ for(const t of pend) commitMovesForTeam(room,t,decideMovement(stateFor(s,t),t)); }
  else if(s.phase==='combat'){ for(const t of pend) declareAttacksForTeam(room,t,decideAttacks(stateFor(s,t),t)); }
  armTurnTimer(room); // rearma para a próxima fase que aguarde humano
}

// ─── Simulações em lote (IA × IA), conforme tools/batch_runner.js ─────────
// Joga uma partida completa headless (movimento+combate, ambos os lados via IA,
// sem intervenção do facilitador) com a OB já ajustada pelos fatores PBC.
function runBatchGame(customOB,seed,maxTurns){
  const state=newGame(customOB,{seed});
  const culmination=createCulminationTracker();
  culmination.update(state);

  const maxPhases=maxTurns*2; // dia + noite por turno
  let winner=null;
  for(let phase=0;phase<maxPhases&&!winner;phase++){
    const blueMoves=decideMovement(stateFor(state,'blue'),'blue');
    const redMoves=decideMovement(stateFor(state,'red'),'red');
    applyMoves(state,'blue',blueMoves);
    applyMoves(state,'red',redMoves);
    finalizeMovementPhase(state);
    applyMovementApproval(state,[]);

    state.blueAttacks=decideAttacks(stateFor(state,'blue'),'blue');
    state.redAttacks=decideAttacks(stateFor(state,'red'),'red');
    state.combatQueue=buildCombatQueue(state);
    resolveCombatQueue(state);

    let result=finishCombatPhase(state);
    winner=result.winner;
    if(!winner){
      result=applyCombatApproval(state,[]);
      winner=result.winner;
    }
    culmination.update(state);
  }

  const metrics=computeFinalMetrics(state,culmination.turn);
  return{winner,metrics,turns:state.turn};
}

// Agrega os resultados de várias réplicas em estatísticas-resumo.
function summarizeBatch(rows){
  const n=rows.length;
  let winsBlue=0,winsRed=0,winsNone=0;
  let sE1=0,sVp=0,sSloc=0,nSloc=0,sAtritoAzul=0,sKcv=0,sTurns=0,sCulm=0,nCulm=0;
  for(const r of rows){
    if(r.winner==='blue') winsBlue++;
    else if(r.winner==='red') winsRed++;
    else winsNone++;
    sE1+=r.metrics.E1_atrito||0;
    sVp+=r.metrics.E2_vp||0;
    if(r.metrics.E2_sloc!=null){sSloc+=r.metrics.E2_sloc;nSloc++;}
    sAtritoAzul+=r.metrics.atrito_azul||0;
    sKcv+=r.metrics.E1_kcv||0;
    sTurns+=r.turns||0;
    if(r.metrics.E3_culminancia!=null){sCulm+=r.metrics.E3_culminancia;nCulm++;}
  }
  return{
    n,winsBlue,winsRed,winsNone,
    avgE1_atrito:n?sE1/n:0,
    avgE2_vp:n?sVp/n:0,
    avgE2_sloc:nSloc?sSloc/nSloc:null,
    avgAtritoAzul:n?sAtritoAzul/n:0,
    pctKcv:n?sKcv/n:0,
    avgCulminancia:nCulm?sCulm/nCulm:null,
    avgTurns:n?sTurns/n:0,
  };
}

// ─── Socket connections ──────────────────────────────────────────
io.on('connection',socket=>{
  console.log('+ connect',socket.id);

  // ── Facilitador cria a sala ──────────────────────────────────
  socket.on('create_room',()=>{
    const id=genId();
    const baseOB=JSON.parse(JSON.stringify(ORDER_OF_BATTLE));
    const capabilityFactors=Object.fromEntries(FACTOR_KEYS.map(k=>[k,true]));
    const room={
      id,
      players:{blue:null,red:null,facilitator:socket.id},
      state:null,
      baseOB,
      customOB:JSON.parse(JSON.stringify(baseOB)),
      capabilityFactors,
      seed:undefined,
      bots:{blue:false,red:false},
    };
    rooms.set(id,room);
    socket.data.roomId=id; socket.data.role='facilitator';
    socket.join(id);
    socket.emit('room_created',{
      roomId:id,role:'facilitator',ob:room.customOB,
      capabilityFactors,capabilityFactorDefs:CAPABILITY_FACTORS,
    });
  });

  // ── Jogadores entram com escolha de equipe ────────────────────────
  socket.on('join_room',({roomId,team})=>{
    const room=rooms.get(roomId?.toUpperCase?.());
    if(!room){socket.emit('join_error','Sala não encontrada.');return;}
    if(!team||!['blue','red'].includes(team)){socket.emit('join_error','Selecione Azul ou Vermelho.');return;}
    if(room.players[team]){socket.emit('join_error',`Equipe ${team==='blue'?'Azul':'Vermelha'} já ocupada.`);return;}

    room.players[team]=socket.id;
    if(room.bots) room.bots[team]=false; // jogador humano assume a equipe controlada pela IA
    socket.data.roomId=room.id; socket.data.role=team;
    socket.join(room.id);
    socket.emit('join_success',{role:team,roomId:room.id});

    // Notifica facilitador
    if(room.players.facilitator){
      io.to(room.players.facilitator).emit('player_joined',{
        team,
        blueReady:!!room.players.blue,
        redReady:!!room.players.red,
      });
    }
    // Se o jogo já comecou, envia estado atual ao novo jogador
    if(room.state){
      socket.emit('game_start',{role:team,state:stateFor(room.state,team)});
    }
  });

  // ── Config: facilitador atualiza a OB ──────────────────────────
  socket.on('update_ob',({ob})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room||socket.data.role!=='facilitator') return;
    const{ok,errors}=validateOB(ob);
    if(!ok){socket.emit('ob_updated',{ok:false,errors});return;}
    room.customOB=ob;
    socket.emit('ob_updated',{ok:true});
    persistence.markDirty();
  });

  // ── Config: facilitador ajusta os fatores de capacidade (PBC) ────────────
  socket.on('set_capability_factors',({factors})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room||socket.data.role!=='facilitator') return;
    room.capabilityFactors={...room.capabilityFactors,...(factors||{})};
    room.customOB=applyCapabilityConfig(room.baseOB,room.capabilityFactors);
    socket.emit('ob_updated',{
      ok:true,ob:room.customOB,
      custoTotal:totalCost(room.capabilityFactors),
      nCapacidades:countActive(room.capabilityFactors),
    });
    persistence.markDirty();
  });

  // ── Config: facilitador gera simulações em lote (IA × IA) ────────────
  socket.on('run_batch_simulations',({replicas,maxTurns,seed}={})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room||socket.data.role!=='facilitator') return;

    const nReplicas=Math.max(1,Math.min(200,Math.round(Number(replicas))||10));
    const nMaxTurns=Math.max(1,Math.min(60,Math.round(Number(maxTurns))||30));
    const parsedSeed=Number(seed);
    const hasSeed=!(seed===null||seed===undefined||seed===''||Number.isNaN(parsedSeed));
    // Sem semente informada: gera uma base aleatória para que cada réplica
    // produza uma trajetória diferente (núcleo estocástico). Com semente
    // informada, as réplicas usam seed+i (reprodutível).
    const baseSeed=hasSeed?parsedSeed:Math.floor(Math.random()*1e9);

    // Run in chunks, yielding to the event loop between them (setImmediate) so a
    // large batch does not block every other room/socket, and emit progress.
    const customOB=room.customOB;
    const rows=[];
    const CHUNK=5;
    let i=0;
    const runChunk=()=>{
      // Bail if the facilitator left mid-run (room gone or role changed).
      const cur=rooms.get(socket.data.roomId);
      if(!cur||socket.data.role!=='facilitator') return;
      const end=Math.min(i+CHUNK,nReplicas);
      for(;i<end;i++){
        const runSeed=baseSeed+i;
        const{winner,metrics,turns}=runBatchGame(customOB,runSeed,nMaxTurns);
        rows.push({replica:i+1,seed:runSeed,winner,turns,metrics});
      }
      if(i<nReplicas){
        socket.emit('batch_progress',{done:i,total:nReplicas});
        setImmediate(runChunk);
        return;
      }
      const summary=summarizeBatch(rows);
      socket.emit('batch_simulation_results',{
        rows,summary,
        capabilityFactors:cur.capabilityFactors,
        nCapacidades:countActive(cur.capabilityFactors),
        custoTotal:totalCost(cur.capabilityFactors),
      });
    };
    runChunk();
  });

  // ── Config: facilitador inicia o jogo ──────────────────────────
  socket.on('start_game',({seed,turnTimer}={})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room||socket.data.role!=='facilitator') return;
    room.bots={blue:!room.players.blue,red:!room.players.red};
    const parsedSeed=Number(seed);
    room.seed=(seed===null||seed===undefined||seed===''||Number.isNaN(parsedSeed))?undefined:parsedSeed;
    const t=Math.floor(Number(turnTimer));
    room.turnTimerSec=(Number.isFinite(t)&&t>0)?Math.min(3600,t):0;
    room.state=newGame(room.customOB,{seed:room.seed});
    if(room.players.blue) io.to(room.players.blue).emit('game_start',{role:'blue',state:stateFor(room.state,'blue')});
    if(room.players.red ) io.to(room.players.red ).emit('game_start',{role:'red', state:stateFor(room.state,'red')});
    socket.emit('game_start',{role:'facilitator',state:stateFor(room.state,'facilitator')});
    runBotsForPhase(room);
    armTurnTimer(room);
    persistence.markDirty();
  });

  // ── Movimentação ────────────────────────────────────────────
  socket.on('commit_moves',({moves})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room?.state) return;
    const{state}=room,{role}=socket.data;
    const team=role; // 'blue' or 'red'
    if(!['blue','red'].includes(team)) return;

    if(state.phase!=='movement'){socket.emit('action_error','Não é a fase de movimentação.');return;}
    if(state[team==='blue'?'blueDone':'redDone']){socket.emit('action_error','Você já encerrou a movimentação.');return;}

    const validation=validateMoves(state,team,moves);
    if(!validation.ok){socket.emit('action_error',validation.error);return;}

    commitMovesForTeam(room,team,moves);
    armTurnTimer(room);
  });

  // ── Facilitador aprova movimentos (com opção de reposicionamento) ─────────
  socket.on('approve_movements',({overrides})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room?.state||socket.data.role!=='facilitator') return;
    const{state}=room;
    if(state.phase!=='movement_approval'){socket.emit('action_error','Não é a fase de aprovação de movimentos.');return;}

    applyMovementApproval(state,overrides);
    broadcast(room);
    runBotsForPhase(room);
    armTurnTimer(room);
  });

  // ── Combate: declaração de ataques ─────────────────────────────
  socket.on('declare_attacks',attacks=>{
    const room=rooms.get(socket.data.roomId);
    if(!room?.state) return;
    const{state}=room,{role}=socket.data;
    const team=role;
    if(!['blue','red'].includes(team)) return;
    if(state.phase!=='combat'){socket.emit('action_error','Não é a fase de combate.');return;}
    declareAttacksForTeam(room,team,attacks);
    armTurnTimer(room);
  });

  // ── Facilitador aprova resultados de combate ─────────────────────
  socket.on('approve_combat',({hpChanges})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room?.state||socket.data.role!=='facilitator') return;
    const{state}=room;
    if(state.phase!=='combat_approval'){socket.emit('action_error','Não é a fase de aprovação de combate.');return;}

    const{winner}=applyCombatApproval(state,hpChanges);
    if(winner){
      clearTurnTimer(room);
      broadcast(room,'game_over');
      return;
    }
    broadcast(room);
    runBotsForPhase(room);
    armTurnTimer(room);
  });

  // ── Mensagens do Facilitador ──────────────────────────────────
  socket.on('facilitator_message',({to,text})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room?.state||socket.data.role!=='facilitator') return;
    if(!text?.trim()) return;

    const msg={
      id:`MSG-${Date.now()}`,
      from:'facilitator',to,
      text:text.trim(),
      timestamp:new Date().toISOString(),
      replies:[],
    };
    room.state.messages.push(msg);
    room.state.log.unshift(`📢 Facilitador → ${to==='all'?'Todos':to==='blue'?'Azul':'Vermelho'}: "${text.trim().slice(0,40)}"`);

    const sendTo=(pid)=>{if(pid) io.to(pid).emit('facilitator_message',msg);};
    if(to==='all'||to==='blue') sendTo(room.players.blue);
    if(to==='all'||to==='red')  sendTo(room.players.red);
    socket.emit('message_sent',{msgId:msg.id});
    facBroadcast(room);
  });

  socket.on('player_reply',({messageId,text})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room?.state) return;
    const{role}=socket.data;
    if(!['blue','red'].includes(role)) return;
    if(!text?.trim()) return;
    const msg=room.state.messages.find(m=>m.id===messageId);
    if(!msg) return;
    const reply={from:role,text:text.trim(),timestamp:new Date().toISOString()};
    msg.replies.push(reply);
    room.state.log.unshift(`↩ ${role==='blue'?'Azul':'Vermelho'}: "${text.trim().slice(0,40)}"`);
    if(room.players.facilitator) io.to(room.players.facilitator).emit('player_reply',{messageId,reply});
    facBroadcast(room);
  });

  // ── Jogador inicia mensagem ao facilitador ──────────────────────────
  socket.on('player_message',({text})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room?.state) return;
    const{role}=socket.data;
    if(!['blue','red'].includes(role)) return;
    if(!text?.trim()) return;
    const msg={
      id:`PMSG-${Date.now()}`,
      from:role,to:'facilitator',
      text:text.trim(),
      timestamp:new Date().toISOString(),
      replies:[],
    };
    room.state.messages.push(msg);
    room.state.log.unshift(`✉ ${role==='blue'?'Azul':'Vermelho'} → Facilitador: "${text.trim().slice(0,40)}"`);
    if(room.players.facilitator) io.to(room.players.facilitator).emit('player_message',msg);
    socket.emit('message_sent',{msgId:msg.id});
    facBroadcast(room);
  });

  // ── Gerenciamento de unidades pelo facilitador ──────────────────────
  socket.on('facilitator_manage_unit',({action,unitId,data})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room?.state||socket.data.role!=='facilitator') return;
    const{state}=room;

    const clampCol=c=>Math.max(0,Math.min(GRID_W-1,Number(c)||0));
    const clampRow=r=>Math.max(0,Math.min(GRID_H-1,Number(r)||0));

    if(action==='add'){
      // data = spec object
      const team=['blue','red','neutral'].includes(data.team)?data.team:'neutral';
      const newId=genUnitId(team);
      const col=clampCol(data.col??8),row=clampRow(data.row??5);
      const spec={...data,id:newId,position:{col,row}};
      const unit=makeUnit(team,spec);
      state.units.push(unit);
      state.log.unshift(`➕ Facilitador adicionou ${unit.name} (${team})`);
      broadcast(room);
    }else if(action==='edit'&&unitId){
      const unit=state.units.find(u=>u.id===unitId);
      if(!unit) return;
      if(data.name) unit.name=data.name;
      if(data.category) unit.category=data.category;
      if(data.movement!=null) unit.movement=Math.max(0,Number(data.movement)||0);
      if(data.stayingPower!=null){const sp=Math.max(1,Number(data.stayingPower)||1);unit.maxHp=sp;unit.hp=Math.min(unit.hp,sp);}
      if(data.hp!=null) unit.hp=Math.max(0,Math.min(unit.maxHp,Number(data.hp)));
      if(data.col!=null&&data.row!=null){unit.col=clampCol(data.col);unit.row=clampRow(data.row);}
      if(data.detectionRange&&typeof data.detectionRange==='object') unit.detectionRange=data.detectionRange;
      if(data.attackRange&&typeof data.attackRange==='object') unit.attackRange=data.attackRange;
      if(data.weapons&&typeof data.weapons==='object') unit.weapons=data.weapons;
      if(data.capabilities&&typeof data.capabilities==='object') unit.capabilities=data.capabilities;
      if(data.status) unit.customStatus=data.status;
      state.log.unshift(`✏ Facilitador editou ${unit.name}`);
      broadcast(room);
    }else if(action==='remove'&&unitId){
      const unit=state.units.find(u=>u.id===unitId);
      if(!unit) return;
      unit.hp=0;
      state.log.unshift(`❌ Facilitador removeu ${unit.name}`);
      broadcast(room);
    }
  });

  // ── Facilitador reposiciona unidade no mapa ───────────────────────
  socket.on('facilitator_reposition',({unitId,col,row})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room?.state||socket.data.role!=='facilitator') return;
    if(col<0||col>=GRID_W||row<0||row>=GRID_H) return;
    const unit=room.state.units.find(u=>u.id===unitId&&u.hp>0);
    if(!unit) return;
    unit.col=col;unit.row=row;
    room.state.log.unshift(`📍 Facilitador moveu ${unit.name} → ${String.fromCharCode(65+col)}${row+1}`);
    broadcast(room);
  });

  // ── Restart ─────────────────────────────────────────────────────────────
  socket.on('restart',()=>{
    const room=rooms.get(socket.data.roomId);
    if(!room||socket.data.role!=='facilitator') return;
    room.bots={blue:!room.players.blue,red:!room.players.red};
    room.state=newGame(room.customOB,{seed:room.seed});
    if(room.players.blue) io.to(room.players.blue).emit('game_start',{role:'blue',state:stateFor(room.state,'blue')});
    if(room.players.red)  io.to(room.players.red ).emit('game_start',{role:'red', state:stateFor(room.state,'red')});
    socket.emit('game_start',{role:'facilitator',state:stateFor(room.state,'facilitator')});
    runBotsForPhase(room);
    armTurnTimer(room);
    persistence.markDirty();
  });

  // ── Facilitador reassume uma sala após reload/reconexão ──────────────────
  socket.on('rejoin_room',({roomId})=>{
    const room=rooms.get(roomId?.toUpperCase?.());
    if(!room){socket.emit('join_error','Sala não encontrada ou expirada.');return;}
    if(room.players.facilitator){socket.emit('join_error','Facilitador já conectado nesta sala.');return;}
    if(room.cleanupTimer){clearTimeout(room.cleanupTimer);room.cleanupTimer=null;}
    room.players.facilitator=socket.id;
    socket.data.roomId=room.id; socket.data.role='facilitator';
    socket.join(room.id);
    socket.emit('room_created',{
      roomId:room.id,role:'facilitator',ob:room.customOB,
      capabilityFactors:room.capabilityFactors,capabilityFactorDefs:CAPABILITY_FACTORS,
      blueReady:!!room.players.blue,redReady:!!room.players.red,rejoined:true,
    });
    if(room.state) socket.emit('game_start',{role:'facilitator',state:stateFor(room.state,'facilitator')});
    if(room.players.blue) io.to(room.players.blue).emit('player_joined',{team:'facilitator',blueReady:!!room.players.blue,redReady:!!room.players.red});
    if(room.players.red)  io.to(room.players.red ).emit('player_joined',{team:'facilitator',blueReady:!!room.players.blue,redReady:!!room.players.red});
  });

  // ── Disconnect ───────────────────────────────────────────────────────
  socket.on('disconnect',()=>{
    const{roomId,role}=socket.data;if(!roomId) return;
    const room=rooms.get(roomId);if(!room) return;
    console.log(`- disconnect ${role} from ${roomId}`);
    room.players[role]=null;
    const notify=pid=>{if(pid) io.to(pid).emit('player_disconnected',{role});};

    if(role==='facilitator'){
      // Do NOT destroy the room — keep it alive for a grace period so the
      // facilitator can reload/reconnect (rejoin_room). Only reclaim it if
      // nobody has taken the seat by the time the timer fires.
      notify(room.players.blue);notify(room.players.red);
      if(room.cleanupTimer) clearTimeout(room.cleanupTimer);
      room.cleanupTimer=setTimeout(()=>{
        const r=rooms.get(roomId);
        if(r&&!r.players.facilitator){clearTurnTimer(r);rooms.delete(roomId);}
      },ROOM_GRACE_MS);
      if(room.cleanupTimer.unref) room.cleanupTimer.unref();
      return;
    }

    // A human player dropped: hand their team to the digital player (IA) so the
    // game does not stall waiting for a commit that will never come, and, if it
    // is currently that team's turn, run the bot for the pending phase.
    notify(room.players.facilitator);notify(room.players[role==='blue'?'red':'blue']);
    if(room.bots) room.bots[role]=true;
    if(room.state&&!room.state.winner){
      if(room.players.facilitator) io.to(room.players.facilitator).emit('player_ai_takeover',{team:role});
      runBotsForPhase(room);
    }
  });
});

if(require.main===module){
  const restored=persistence.loadRooms(rooms,PERSIST_FILE);
  if(restored>0) console.log(`Salas restauradas do disco: ${restored}`);
  persistence.startAutosave(rooms,PERSIST_FILE);
  server.listen(PORT,()=>console.log(`Servidor em http://localhost:${PORT}`));
}

module.exports={app,server,io,rooms,ROOM_GRACE_MS,PERSIST_FILE,runBatchGame};
