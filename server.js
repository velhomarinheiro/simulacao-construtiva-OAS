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

const PORT   = process.env.PORT || 3000;
const { GRID_W, GRID_H } = require('./shared/hexgrid');

// ─── Server ───────────────────────────────────────────────────────────────────
const app=express();
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:'*'}});

app.use(express.static(path.join(__dirname,'public')));
app.get('/',(_, res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/game',(_, res)=>res.sendFile(path.join(__dirname,'public','game.html')));

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
}

function facBroadcast(room){
  if(!room.state||!room.players.facilitator) return;
  io.to(room.players.facilitator).emit('game_update',stateFor(room.state,'facilitator'));
}

// ─── Combat resolution wrappers (pure logic in shared/game_engine, I/O here) ──
function endCombatPhase(room){
  const state=room.state;
  const{winner}=finishCombatPhase(state);
  if(winner){
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

// ─── Socket connections ───────────────────────────────────────────────────────
io.on('connection',socket=>{
  console.log('+ connect',socket.id);

  // ── Facilitador cria a sala ──────────────────────────────────────────────
  socket.on('create_room',()=>{
    const id=genId();
    const room={
      id,
      players:{blue:null,red:null,facilitator:socket.id},
      state:null,
      customOB:JSON.parse(JSON.stringify(ORDER_OF_BATTLE)),
    };
    rooms.set(id,room);
    socket.data.roomId=id; socket.data.role='facilitator';
    socket.join(id);
    socket.emit('room_created',{roomId:id,role:'facilitator',ob:room.customOB});
  });

  // ── Jogadores entram com escolha de equipe ───────────────────────────────
  socket.on('join_room',({roomId,team})=>{
    const room=rooms.get(roomId?.toUpperCase?.());
    if(!room){socket.emit('join_error','Sala não encontrada.');return;}
    if(!team||!['blue','red'].includes(team)){socket.emit('join_error','Selecione Azul ou Vermelho.');return;}
    if(room.players[team]){socket.emit('join_error',`Equipe ${team==='blue'?'Azul':'Vermelha'} já ocupada.`);return;}

    room.players[team]=socket.id;
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
    // Se o jogo já começou, envia estado atual ao novo jogador
    if(room.state){
      socket.emit('game_start',{role:team,state:stateFor(room.state,team)});
    }
  });

  // ── Config: facilitador atualiza a OB ────────────────────────────────────
  socket.on('update_ob',({ob})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room||socket.data.role!=='facilitator') return;
    room.customOB=ob;
    socket.emit('ob_updated',{ok:true});
  });

  // ── Config: facilitador inicia o jogo ────────────────────────────────────
  socket.on('start_game',()=>{
    const room=rooms.get(socket.data.roomId);
    if(!room||socket.data.role!=='facilitator') return;
    if(!room.players.blue||!room.players.red){
      socket.emit('action_error','Aguardando os dois jogadores conectarem.');return;
    }
    room.state=newGame(room.customOB);
    io.to(room.players.blue).emit('game_start',{role:'blue',state:stateFor(room.state,'blue')});
    io.to(room.players.red ).emit('game_start',{role:'red', state:stateFor(room.state,'red')});
    socket.emit('game_start',{role:'facilitator',state:stateFor(room.state,'facilitator')});
  });

  // ── Movimentação ─────────────────────────────────────────────────────────
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

    applyMoves(state,team,moves);

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
  });

  // ── Facilitador aprova movimentos (com opção de reposicionamento) ─────────
  socket.on('approve_movements',({overrides})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room?.state||socket.data.role!=='facilitator') return;
    const{state}=room;
    if(state.phase!=='movement_approval'){socket.emit('action_error','Não é a fase de aprovação de movimentos.');return;}

    applyMovementApproval(state,overrides);
    broadcast(room);
  });

  // ── Combate: declaração de ataques ───────────────────────────────────────
  socket.on('declare_attacks',attacks=>{
    const room=rooms.get(socket.data.roomId);
    if(!room?.state) return;
    const{state}=room,{role}=socket.data;
    const team=role;
    if(!['blue','red'].includes(team)) return;
    if(state.phase!=='combat'){socket.emit('action_error','Não é a fase de combate.');return;}
    if(team==='blue') state.blueAttacks=attacks||[];else state.redAttacks=attacks||[];
    state.log.unshift(`${team==='blue'?'Força Azul':'Força Vermelha'} confirmou ${(attacks||[]).length} ataque(s).`);
    if(state.blueAttacks!==null&&state.redAttacks!==null){
      state.log.unshift('── Resolução de Combate ──');
      state.combatQueue=buildCombatQueue(state);
      broadcast(room);
      if(state.combatQueue.length===0) endCombatPhase(room);
      else runCombatQueue(room);
    }else{broadcast(room);}
  });

  // ── Facilitador aprova resultados de combate ──────────────────────────────
  socket.on('approve_combat',({hpChanges})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room?.state||socket.data.role!=='facilitator') return;
    const{state}=room;
    if(state.phase!=='combat_approval'){socket.emit('action_error','Não é a fase de aprovação de combate.');return;}

    const{winner}=applyCombatApproval(state,hpChanges);
    if(winner){
      broadcast(room,'game_over');
      return;
    }
    broadcast(room);
  });

  // ── Mensagens do Facilitador ──────────────────────────────────────────────
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

  // ── Gerenciamento de unidades pelo facilitador ────────────────────────────
  socket.on('facilitator_manage_unit',({action,unitId,data})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room?.state||socket.data.role!=='facilitator') return;
    const{state}=room;

    if(action==='add'){
      // data = spec object
      const team=data.team||'neutral';
      const newId=genUnitId(team);
      const spec={...data,id:newId,position:{col:data.col??8,row:data.row??5}};
      const unit=makeUnit(team,spec);
      state.units.push(unit);
      state.log.unshift(`➕ Facilitador adicionou ${unit.name} (${team})`);
      broadcast(room);
    }else if(action==='edit'&&unitId){
      const unit=state.units.find(u=>u.id===unitId);
      if(!unit) return;
      if(data.hp!=null) unit.hp=Math.max(0,Math.min(unit.maxHp,Number(data.hp)));
      if(data.col!=null&&data.row!=null){unit.col=Number(data.col);unit.row=Number(data.row);}
      if(data.name) unit.name=data.name;
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

  // ── Facilitador reposiciona unidade no mapa ───────────────────────────────
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

  // ── Restart ───────────────────────────────────────────────────────────────
  socket.on('restart',()=>{
    const room=rooms.get(socket.data.roomId);
    if(!room||socket.data.role!=='facilitator') return;
    room.state=newGame(room.customOB);
    if(room.players.blue) io.to(room.players.blue).emit('game_start',{role:'blue',state:stateFor(room.state,'blue')});
    if(room.players.red)  io.to(room.players.red ).emit('game_start',{role:'red', state:stateFor(room.state,'red')});
    socket.emit('game_start',{role:'facilitator',state:stateFor(room.state,'facilitator')});
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect',()=>{
    const{roomId,role}=socket.data;if(!roomId) return;
    const room=rooms.get(roomId);if(!room) return;
    console.log(`- disconnect ${role} from ${roomId}`);
    room.players[role]=null;
    // Notify remaining players
    const notify=pid=>{if(pid) io.to(pid).emit('player_disconnected',{role});};
    if(role==='facilitator'){notify(room.players.blue);notify(room.players.red);}
    else{notify(room.players.facilitator);notify(room.players[role==='blue'?'red':'blue']);}
    // Limpar sala se facilitador saiu
    if(role==='facilitator') rooms.delete(roomId);
  });
});

server.listen(PORT,()=>console.log(`Servidor em http://localhost:${PORT}`));
