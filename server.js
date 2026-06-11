'use strict';
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const { ORDER_OF_BATTLE }  = require('./shared/order_of_battle');
const { COMBAT_CONFIG }    = require('./shared/combat_config');
const { resolveEngagement, getWeaponQuantity, getWeaponRange } = require('./shared/combat_engine');
const {
  initializeFuel, isFuelDisabled,
  navalMoveCost, spendNavalFuel, spendAirFuel,
  spendEngagementFuel, spendDamageFuel,
  markRefuelEligibility, recoverNavalFuel,
  checkNavalFuelZero, checkAirFuelLosses,
  recoverAircraft, resetFuelTurnCounters,
} = require('./fuel_model');

const PORT   = process.env.PORT || 3000;
const {
  GRID_W, GRID_H,
  T_DEEP,
  getTerrain, canEnterTerrain, rangeAgainst, hexDist,
} = require('./shared/hexgrid');

// ─── Display type mapping ─────────────────────────────────────────────────────
const COMP_DISPLAY_TYPE={
  'navio_aeródromo':'carrier','navio_doca':'amphib','navio_desembarque':'amphib',
  'fragata':'fragata','corveta':'corveta','destroier':'destroier','destroyer':'destroier',
  'cruzador':'cruzador','navio_patoc':'patrulha_oc','navio_patrulha':'patrulha_c',
  'navio_logistico':'logistico','navio_tanque':'tanque','submarino_nuclear':'sub_nuclear',
  'submarino_convencional':'submarino','patrulha_maritima':'patrulha','caca':'caca',
  'ataque':'ataque','aew':'aew','helicoptero_ASW':'helicoptero','helicoptero_ASup':'helicoptero',
  'bateria_costeira':'bateria_costeira','bateria_ada':'bateria_ada','base_naval':'bateria_ada',
  'plataforma':'fpso','porto':'porto','aeroporto':'aeroporto',
  'navio_mercante':'logistico','apoio_offshore':'logistico','barco_pesqueiro':'patrulha_c',
  'veleiro':'patrulha_c','helicoptero_transporte':'helicoptero','aviacao_civil':'patrulha',
};
const DISPLAY_TYPE_FALLBACK={surface:'fragata',submarine:'submarino',air:'patrulha',land:'corveta',neutral:'logistico'};

// ─── Air refuel ───────────────────────────────────────────────────────────────
function isAirRefuelLocation(unit,state){
  return state.units.some(o=>o.id!==unit.id&&o.team===unit.team&&(o.hp??0)>0&&(o.type==='aeroporto'||o.type==='carrier')&&o.col===unit.col&&o.row===unit.row);
}

// ─── Fog of war ───────────────────────────────────────────────────────────────
function saveMovementSnapshot(state){
  state.movementSnapshot={};
  for(const u of state.units) state.movementSnapshot[u.id]={col:u.col,row:u.row};
}

function stateFor(state,role){
  if(role==='facilitator'){
    const{combatQueue:_cq,...rest}=state;
    return{...rest,isFacilitator:true};
  }
  const team=role;
  const night=state.period==='night';
  const{combatQueue:_cq,...stateRest}=state;

  const neutralUnits=state.units.filter(u=>u.team==='neutral'&&u.hp>0);
  const enemyActual=state.units.filter(u=>u.team!==team&&u.team!=='neutral'&&u.hp>0);
  const enemies=(state.phase==='movement'&&state.movementSnapshot)
    ?enemyActual.map(u=>{const snap=state.movementSnapshot[u.id];return snap?{...u,col:snap.col,row:snap.row}:u;})
    :enemyActual;
  const mine=state.units.filter(u=>u.team===team&&u.hp>0);
  const mineForDetection=(state.phase==='movement'&&state.movementSnapshot)
    ?mine.map(u=>{const snap=state.movementSnapshot[u.id];return snap?{...u,col:snap.col,row:snap.row}:u;})
    :mine;

  const detected=enemies.filter(enemy=>{
    const stealthy=!!enemy.stealthy;
    const deepBonus=getTerrain(enemy.col,enemy.row)===T_DEEP?1:0;
    return mineForDetection.some(f=>{
      let range=stealthy?rangeAgainst(f.detectionRange,'submarine')-deepBonus:rangeAgainst(f.detectionRange,enemy.category);
      if(night&&f.category!=='submarine') range-=stealthy?1:2;
      return range>=1&&hexDist(f.col,f.row,enemy.col,enemy.row)<=range;
    });
  }).map(e=>({...e,detected:true}));

  return{
    ...stateRest,
    units:[...mine,...detected,...neutralUnits],
    blueAttacks:team==='blue'?state.blueAttacks:(state.blueAttacks!==null?'✓':null),
    redAttacks: team==='red' ?state.redAttacks :(state.redAttacks !==null?'✓':null),
    isFacilitator:false,
  };
}

// ─── Weapon priority / combat helpers ────────────────────────────────────────
const WEAPON_PRIORITY={
  surface:['ascm','asbm','mss','torpedo','airAttack','navalGun'],
  submarine:['asw','torpedo'],
  air:['airDefense','airAttack'],
  land:['lacm','airAttack','navalGun'],
};
function selectBestWeapon(attacker,target,dist){
  const priority=WEAPON_PRIORITY[target.category]||[];
  for(const wpnType of priority){
    const qty=getWeaponQuantity(attacker,wpnType);
    if(qty<=0) continue;
    const profile=COMBAT_CONFIG.weaponProfiles?.[wpnType];
    if(!profile) continue;
    if(!profile.targets.includes(target.category)) continue;
    const range=getWeaponRange(attacker,wpnType);
    if(dist<=range) return wpnType;
  }
  return null;
}

// ─── Unit factory ─────────────────────────────────────────────────────────────
function makeUnit(team,spec){
  const pos=spec.position||spec.start||{col:0,row:0};
  const weapons=spec.weapons?JSON.parse(JSON.stringify(spec.weapons)):{};
  const unit={
    id:spec.id,team,name:spec.name,category:spec.category,
    type:(spec.composition&&spec.composition[0]&&COMP_DISPLAY_TYPE[spec.composition[0].type])||DISPLAY_TYPE_FALLBACK[spec.category]||'fragata',
    composition:spec.composition||[],movement:spec.movement,
    detectionRange:spec.detectionRange,attackRange:spec.attackRange,
    col:pos.col,row:pos.row,hp:spec.stayingPower,maxHp:spec.stayingPower,
    stealthy:spec.category==='submarine',moved:false,weapons,
    initWeapons:JSON.parse(JSON.stringify(weapons)),
    capabilities:spec.capabilities?{...spec.capabilities}:{},
    notes:spec.notes||'',
  };
  initializeFuel(unit);
  return unit;
}

let _unitSeed=1000;
function genUnitId(team){return `${team.toUpperCase()}-FAC-${_unitSeed++}`;}

function initialUnits(customOB){
  const ob=customOB||ORDER_OF_BATTLE;
  const units=[];
  for(const spec of(ob.forces.blue||[])) units.push(makeUnit('blue',spec));
  for(const spec of(ob.forces.red||[])) units.push(makeUnit('red',spec));
  for(const spec of(ob.forces.neutral||[])) units.push(makeUnit('neutral',spec));
  return units;
}

function newGame(customOB){
  const state={
    turn:1,period:'day',phase:'movement',
    blueDone:false,redDone:false,
    blueAttacks:null,redAttacks:null,
    units:initialUnits(customOB),
    log:['──── Turno 1 · Período Diurno ────','Fase de Movimentação iniciada.'],
    messages:[],
    winner:null,
    movementSnapshot:{},
    combatQueue:[],
  };
  saveMovementSnapshot(state);
  markRefuelEligibility(state);
  return state;
}

// ─── Combat system (resolução em pulso único pela equação de salva) ──────────
const SALVO_SIZE={ascm:2,mss:2,torpedo:1,lacm:1,asbm:1};

function buildCombatQueue(state){
  const all=[...(state.blueAttacks||[]),...(state.redAttacks||[])];
  return all.map((atk,i)=>{
    const att=state.units.find(u=>u.id===atk.attackerId&&u.hp>0);
    const def=state.units.find(u=>u.id===atk.targetId&&u.hp>0);
    if(!att||!def) return null;
    const dist=hexDist(att.col,att.row,def.col,def.row);
    const wpnType=selectBestWeapon(att,def,dist);
    if(!wpnType) return null;
    const profile=COMBAT_CONFIG.weaponProfiles?.[wpnType];
    const qty=getWeaponQuantity(att,wpnType);
    const requested=atk.amount??(SALVO_SIZE[wpnType]||1);
    const amount=profile?.expendable?Math.min(qty,Math.max(1,requested)):1;
    return{id:`ENG-${String(i+1).padStart(2,'0')}`,attackerId:atk.attackerId,targetId:atk.targetId,
      weaponType:wpnType,amount,status:'pending',result:null};
  }).filter(Boolean);
}

// Resolves a single declared engagement with one salvo-equation pulse and
// logs the outcome. Mutates engagement.status/result and defender.hp.
function resolveQueuedEngagement(state,engagement){
  const att=state.units.find(u=>u.id===engagement.attackerId&&u.hp>0);
  const def=state.units.find(u=>u.id===engagement.targetId&&u.hp>0);
  if(!att||!def){
    engagement.status='ended';
    state.log.unshift(`[${engagement.id}] Unidade destruída — engajamento cancelado.`);
    return;
  }
  if(isFuelDisabled(att)){
    engagement.status='ended';
    engagement.result={ok:false,reason:'Atacante sem combustível'};
    state.log.unshift(`⛽ ${att.name} sem combustível — engajamento cancelado.`);
    return;
  }

  state.log.unshift(`──── ${engagement.id} ────`);
  const dist=hexDist(att.col,att.row,def.col,def.row);
  const eng=resolveEngagement({attacker:att,defender:def,weaponType:engagement.weaponType,
    amount:engagement.amount,distance:dist,defenderDisabled:isFuelDisabled(def)});

  if(!eng.ok){
    state.log.unshift(`⚠ ${att.name} → ${def.name}: ${eng.reason}`);
  }else{
    spendEngagementFuel(att);
    const interceptStr=eng.interception.pDefenseTotal>0
      ?` (interceptação −${eng.interception.pDefenseTotal.toFixed(2)})`:'';
    if(eng.destroyed){
      state.log.unshift(`💥 ${def.name} DESTRUÍDO por ${att.name} [${eng.weaponLabel}]`);
    }else if(eng.expectedLoss>1e-3){
      state.log.unshift(`✓ ${att.name} → ${def.name} −${eng.expectedLoss.toFixed(2)}SP [${eng.weaponLabel}${interceptStr}]`);
      spendDamageFuel(def);
    }else{
      state.log.unshift(`✗ ${att.name} → ${def.name} sem efeito [${eng.weaponLabel}${interceptStr}]`);
    }
  }
  if(state.log.length>80) state.log=state.log.slice(0,80);
  engagement.status='ended';
  engagement.result=eng;
}

function resolveCombatQueue(room){
  const state=room.state;
  for(const engagement of state.combatQueue) resolveQueuedEngagement(state,engagement);
  if(room.players.blue) io.to(room.players.blue).emit('combat_results',{results:state.combatQueue});
  if(room.players.red)  io.to(room.players.red ).emit('combat_results',{results:state.combatQueue});
  if(room.players.facilitator) io.to(room.players.facilitator).emit('combat_results',{results:state.combatQueue});
  finishCombatPhase(room);
}

function finishCombatPhase(room){
  const state=room.state;
  state.log.unshift('── Fase de Combate encerrada. ──');
  state.combatQueue=[];

  const winner=checkWinner(state);
  if(winner){
    state.winner=winner;
    state.log.unshift(`🏆 ${winner==='blue'?'Força Azul':'Força Vermelha'} VENCEU!`);
    broadcast(room,'game_over',{winner,state:null});
    return;
  }

  // Enter combat_approval: facilitator reviews final HP before next turn
  state.phase='combat_approval';
  state.log.unshift('Aguardando confirmação do Facilitador para o próximo turno...');
  if(room.players.facilitator) io.to(room.players.facilitator).emit('combat_approval_needed',stateFor(state,'facilitator'));
  broadcast(room);
}

function checkWinner(state){
  const hasOffense=u=>Object.values(u.attackRange||{}).some(v=>v>0)||Object.values(u.weapons||{}).some(w=>w.quantity>0)||Object.values(u.capabilities||{}).some(v=>v>0);
  const b=state.units.some(u=>u.team==='blue'&&u.hp>0&&hasOffense(u));
  const r=state.units.some(u=>u.team==='red' &&u.hp>0&&hasOffense(u));
  if(!b) return 'red';if(!r) return 'blue';return null;
}

function nextTurn(state){
  const portHexes=new Set(state.units.filter(u=>u.team==='blue'&&u.hp>0&&u.type==='porto').map(u=>`${u.col},${u.row}`));
  for(const u of state.units){
    if(u.hp<=0) continue;
    if(!u.initWeapons||Object.keys(u.initWeapons).length===0) continue;
    const hexKey=`${u.col},${u.row}`;
    let reload=false;
    if(u.team==='blue'){
      if(u.category==='land') reload=true;
      else if(u.category==='air') reload=u.fuel?.wasAtRefuelLocation===true;
      else if(!u.moved&&(u.category==='surface'||u.category==='submarine')) reload=portHexes.has(hexKey);
    }else if(u.team==='red'){
      if(u.category==='air') reload=u.fuel?.wasAtRefuelLocation===true;
    }
    if(reload){
      const restored=[];
      for(const[wpn,init]of Object.entries(u.initWeapons)){
        const cur=u.weapons[wpn]?.quantity??0;
        if(cur<init.quantity){u.weapons[wpn]={...init};restored.push(wpn.toUpperCase());}
      }
      if(restored.length>0) state.log.unshift(`🔄 ${u.name} recompletou: ${restored.join(', ')}`);
    }
  }
  const fuelReports=recoverNavalFuel(state);
  for(const{unit:u}of fuelReports) state.log.unshift(`⛽ ${u.name}(${u.team}) reabasteceu: ${u.fuel.current}/${u.fuel.max} FP.`);
  recoverAircraft(state);
  state.units.forEach(u=>{u.moved=false;});
  resetFuelTurnCounters(state);
  state.period=state.period==='day'?'night':'day';
  if(state.period==='day') state.turn++;
  state.phase='movement';
  state.blueDone=state.redDone=false;
  state.blueAttacks=state.redAttacks=null;
  const per=state.period==='day'?'Diurno':'Noturno';
  state.log.unshift(`──── Turno ${state.turn} · Período ${per} ────`);
  state.log.unshift('Fase de Movimentação iniciada.');
  if(state.log.length>50) state.log=state.log.slice(0,50);
  saveMovementSnapshot(state);
  markRefuelEligibility(state);
}

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

    // Validate
    for(const{unitId,path}of(moves||[])){
      if(!Array.isArray(path)||path.length<2) continue;
      const unit=state.units.find(u=>u.id===unitId&&u.team===team&&u.hp>0);
      if(!unit){socket.emit('action_error',`Unidade ${unitId} inválida.`);return;}
      if(unit.movement===0){socket.emit('action_error',`${unit.name}: unidade fixa.`);return;}
      if(isFuelDisabled(unit)){socket.emit('action_error',`${unit.name}: sem combustível.`);return;}
      if(path[0].col!==unit.col||path[0].row!==unit.row){socket.emit('action_error',`Caminho inválido para ${unit.name}.`);return;}
      if(path.length-1>unit.movement){socket.emit('action_error',`${unit.name}: caminho excede alcance.`);return;}
      for(let i=1;i<path.length;i++){
        const{col,row}=path[i];
        if(col<0||col>=GRID_W||row<0||row>=GRID_H){socket.emit('action_error',`${unit.name}: fora do tabuleiro.`);return;}
        if(hexDist(path[i-1].col,path[i-1].row,col,row)!==1){socket.emit('action_error',`${unit.name}: passo não adjacente.`);return;}
        if(!canEnterTerrain(unit.category,getTerrain(col,row))){socket.emit('action_error',`${unit.name}: terreno intransponível.`);return;}
      }
    }

    // Apply
    for(const{unitId,path}of(moves||[])){
      if(!Array.isArray(path)||path.length<2) continue;
      const unit=state.units.find(u=>u.id===unitId&&u.team===team&&u.hp>0);
      if(!unit) continue;
      const dest=path[path.length-1];
      unit.col=dest.col;unit.row=dest.row;unit.moved=true;
      state.log.unshift(`${unit.name}(${team}) → ${String.fromCharCode(65+dest.col)}${dest.row+1}`);
      const dist=path.length-1;
      if(unit.category!=='air'){spendNavalFuel(unit,navalMoveCost(dist));}
      else{unit.airStatus='airborne';spendAirFuel(unit,dist);if(isAirRefuelLocation(unit,state)) unit.fuel.wasAtRefuelLocation=true;}
    }

    // Stationary fuel
    for(const u of state.units){
      if(u.hp<=0||u.team!==team||u.moved) continue;
      if(u.category==='air'){
        if(u.airStatus==='airborne'){if(isAirRefuelLocation(u,state)) u.fuel.wasAtRefuelLocation=true;else spendAirFuel(u,1);}
      }else{spendNavalFuel(u,navalMoveCost(0));}
    }

    if(team==='blue') state.blueDone=true;else state.redDone=true;

    if(state.blueDone&&state.redDone){
      // Fuel alerts
      const navalEmpty=checkNavalFuelZero(state);
      for(const u of navalEmpty){
        const pid=room.players[u.team];
        if(pid) io.to(pid).emit('fuel_alert',{unitId:u.id,name:u.name,type:'naval_empty'});
        state.log.unshift(`⛽ ${u.name}(${u.team}) sem combustível.`);
      }
      const airLost=checkAirFuelLosses(state);
      for(const u of airLost){
        const pid=room.players[u.team];
        if(pid) io.to(pid).emit('fuel_alert',{unitId:u.id,name:u.name,type:'air_lost'});
        state.log.unshift(`✈ ${u.name}(${u.team}) perdida por falta de combustível.`);
      }

      // Entrar em movement_approval
      state.phase='movement_approval';
      state.log.unshift('Movimentos concluídos. Aguardando aprovação do Facilitador...');
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

    // Aplicar overrides de posição
    for(const{unitId,col,row}of(overrides||[])){
      if(col<0||col>=GRID_W||row<0||row>=GRID_H) continue;
      const unit=state.units.find(u=>u.id===unitId);
      if(unit){
        unit.col=col;unit.row=row;
        state.log.unshift(`📍 Facilitador reposicionou ${unit.name} → ${String.fromCharCode(65+col)}${row+1}`);
      }
    }

    state.phase='combat';
    state.log.unshift('Movimentos aprovados. Fase de Combate iniciada. Declare seus ataques.');
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
      if(state.combatQueue.length===0) finishCombatPhase(room);
      else resolveCombatQueue(room);
    }else{broadcast(room);}
  });

  // ── Facilitador aprova resultados de combate ──────────────────────────────
  socket.on('approve_combat',({hpChanges})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room?.state||socket.data.role!=='facilitator') return;
    const{state}=room;
    if(state.phase!=='combat_approval'){socket.emit('action_error','Não é a fase de aprovação de combate.');return;}

    // Aplicar modificações de HP
    for(const{unitId,hp}of(hpChanges||[])){
      const unit=state.units.find(u=>u.id===unitId);
      if(!unit) continue;
      const oldHp=unit.hp;
      unit.hp=Math.max(0,Math.min(unit.maxHp,Number(hp)||0));
      if(unit.hp!==oldHp) state.log.unshift(`📝 Facilitador ajustou SP de ${unit.name}: ${oldHp}→${unit.hp}`);
    }

    // Re-check winner after adjustments
    const winner=checkWinner(state);
    if(winner){
      state.winner=winner;
      state.log.unshift(`🏆 ${winner==='blue'?'Força Azul':'Força Vermelha'} VENCEU!`);
      broadcast(room,'game_over');
      return;
    }

    nextTurn(state);
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
