'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const {
  newGame,
  GRID_W,
  GRID_H,
  commitMoves,
  finalizeMovementPhase,
  applyMovementApproval,
  declareAttacks,
  buildCombatQueue,
  resolveCombatQueue,
  finishCombatPhase,
  applyCombatApproval,
  stateFor,
  applyFactorAblation,
} = require('./shared/game_engine');

const { decideMovement, decideAttacks } = require('./shared/bot/decision_engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

const rooms = new Map();

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function roomSummary(room) {
  return {
    id: room.id,
    blueConnected: !!room.players.blue,
    redConnected: !!room.players.red,
    bots: { ...room.bots },
  };
}

function broadcastState(room) {
  for (const role of ['blue', 'red', 'facilitator']) {
    const socketId = room.players[role];
    if (!socketId) continue;
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    sock.emit('state_update', {
      state: stateFor(room.state, role),
      bots: { ...room.bots },
    });
  }
}

function broadcastSummary(room) {
  for (const role of ['blue', 'red', 'facilitator']) {
    const socketId = room.players[role];
    if (!socketId) continue;
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    sock.emit('room_summary', roomSummary(room));
  }
}

function commitMovesForTeam(room, team, moves) {
  room.state = commitMoves(room.state, team, moves);
}

function declareAttacksForTeam(room, team, attacks) {
  room.state = declareAttacks(room.state, team, attacks);
}

function runBotsForPhase(room) {
  const state = room.state;
  if (state.phase === 'movement') {
    for (const team of ['blue', 'red']) {
      if (room.bots[team] && !state.movesCommitted?.[team]) {
        const filtered = stateFor(state, team);
        const moves = decideMovement(filtered, team);
        commitMovesForTeam(room, team, moves);
      }
    }
    maybeFinalizeMovement(room);
  } else if (state.phase === 'combat') {
    for (const team of ['blue', 'red']) {
      if (room.bots[team] && !state.attacksDeclared?.[team]) {
        const filtered = stateFor(state, team);
        const attacks = decideAttacks(filtered, team);
        declareAttacksForTeam(room, team, attacks);
      }
    }
    maybeResolveCombat(room);
  }
}

function maybeFinalizeMovement(room) {
  const state = room.state;
  if (state.phase !== 'movement') return;
  if (state.movesCommitted?.blue && state.movesCommitted?.red) {
    room.state = finalizeMovementPhase(room.state);
  }
}

function maybeResolveCombat(room) {
  const state = room.state;
  if (state.phase !== 'combat') return;
  if (state.attacksDeclared?.blue && state.attacksDeclared?.red) {
    room.state = buildCombatQueue(room.state);
    const { state: newState, results } = resolveCombatQueue(room.state);
    room.state = newState;
    room.pendingCombatResults = results;
  }
}

io.on('connection', (socket) => {
  socket.on('create_room', () => {
    const id = genRoomCode();
    const room = {
      id,
      players: { blue: null, red: null, facilitator: socket.id },
      state: null,
      baseOB: null,
      customOB: null,
      capabilityFactors: null,
      seed: null,
      bots: { blue: false, red: false },
      pendingCombatResults: null,
    };
    rooms.set(id, room);
    socket.data.roomId = id;
    socket.data.role = 'facilitator';
    socket.join(id);
    socket.emit('room_created', { roomId: id });
    broadcastSummary(room);
  });

  socket.on('join_room', ({ roomId, role }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('join_error', { message: 'Sala não encontrada.' });
      return;
    }
    if (role !== 'blue' && role !== 'red') {
      socket.emit('join_error', { message: 'Papel inválido.' });
      return;
    }
    if (room.players[role]) {
      socket.emit('join_error', { message: 'Equipe já conectada.' });
      return;
    }
    room.players[role] = socket.id;
    room.bots[role] = false;
    socket.data.roomId = roomId;
    socket.data.role = role;
    socket.join(roomId);
    socket.emit('joined', { roomId, role });
    if (room.state) {
      broadcastState(room);
    }
    broadcastSummary(room);
  });

  socket.on('facilitator_config', ({ roomId, baseOB, customOB, capabilityFactors, seed }) => {
    const room = rooms.get(roomId);
    if (!room || room.players.facilitator !== socket.id) return;
    room.baseOB = baseOB;
    room.customOB = customOB;
    room.capabilityFactors = capabilityFactors;
    room.seed = seed;
  });

  socket.on('start_game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.players.facilitator !== socket.id) return;

    room.bots.blue = !room.players.blue;
    room.bots.red = !room.players.red;

    let ob = room.customOB || room.baseOB;
    if (room.capabilityFactors) {
      ob = applyFactorAblation(ob, room.capabilityFactors);
    }
    room.state = newGame(ob, { seed: room.seed });
    room.pendingCombatResults = null;

    runBotsForPhase(room);

    broadcastState(room);
    broadcastSummary(room);
  });

  socket.on('commit_moves', ({ roomId, moves }) => {
    const room = rooms.get(roomId);
    if (!room || !room.state) return;
    const team = socket.data.role;
    if (team !== 'blue' && team !== 'red') return;
    if (room.state.phase !== 'movement') return;
    if (room.state.movesCommitted?.[team]) return;

    commitMovesForTeam(room, team, moves);
    maybeFinalizeMovement(room);

    if (room.state.phase === 'movement') {
      runBotsForPhase(room);
    }

    broadcastState(room);
  });

  socket.on('approve_movements', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.state || room.players.facilitator !== socket.id) return;
    if (room.state.phase !== 'movement_approval') return;

    room.state = applyMovementApproval(room.state);
    runBotsForPhase(room);

    broadcastState(room);
  });

  socket.on('declare_attacks', ({ roomId, attacks }) => {
    const room = rooms.get(roomId);
    if (!room || !room.state) return;
    const team = socket.data.role;
    if (team !== 'blue' && team !== 'red') return;
    if (room.state.phase !== 'combat') return;
    if (room.state.attacksDeclared?.[team]) return;

    declareAttacksForTeam(room, team, attacks);
    maybeResolveCombat(room);

    if (room.state.phase === 'combat') {
      runBotsForPhase(room);
    }

    broadcastState(room);

    if (room.pendingCombatResults) {
      for (const role of ['blue', 'red', 'facilitator']) {
        const socketId = room.players[role];
        if (!socketId) continue;
        const sock = io.sockets.sockets.get(socketId);
        if (!sock) continue;
        sock.emit('combat_results', { results: room.pendingCombatResults });
      }
      room.pendingCombatResults = null;
    }
  });

  socket.on('approve_combat', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.state || room.players.facilitator !== socket.id) return;
    if (room.state.phase !== 'combat_approval') return;

    room.state = finishCombatPhase(room.state);
    room.state = applyCombatApproval(room.state);

    if (room.state.phase === 'movement') {
      runBotsForPhase(room);
    }

    broadcastState(room);
  });

  socket.on('facilitator_reposition', ({ roomId, unitId, col, row }) => {
    const room = rooms.get(roomId);
    if (!room || !room.state || room.players.facilitator !== socket.id) return;
    if(col<0||col>=GRID_W||row<0||row>=GRID_H) return;
    const unit = room.state.units.find(u => u.id === unitId);
    if (!unit) return;
    unit.col = col;
    unit.row = row;
    broadcastState(room);
  });

  socket.on('facilitator_message', ({ roomId, to, text }) => {
    const room = rooms.get(roomId);
    if (!room || room.players.facilitator !== socket.id) return;
    const targets = to === 'all' ? ['blue', 'red'] : [to];
    for (const role of targets) {
      const socketId = room.players[role];
      if (!socketId) continue;
      const sock = io.sockets.sockets.get(socketId);
      if (!sock) continue;
      sock.emit('facilitator_message', { from: 'facilitator', text });
    }
  });

  socket.on('player_message_reply', ({ roomId, text }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const role = socket.data.role;
    if (role !== 'blue' && role !== 'red') return;
    const facSocketId = room.players.facilitator;
    if (!facSocketId) return;
    const sock = io.sockets.sockets.get(facSocketId);
    if (!sock) return;
    sock.emit('player_message_reply', { from: role, text });
  });

  socket.on('restart', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.players.facilitator !== socket.id) return;

    room.bots.blue = !room.players.blue;
    room.bots.red = !room.players.red;

    let ob = room.customOB || room.baseOB;
    if (room.capabilityFactors) {
      ob = applyFactorAblation(ob, room.capabilityFactors);
    }
    room.state = newGame(ob, { seed: room.seed });
    room.pendingCombatResults = null;

    runBotsForPhase(room);

    broadcastState(room);
    broadcastSummary(room);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const role = socket.data.role;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (role === 'facilitator') {
      rooms.delete(roomId);
      return;
    }

    if (room.players[role] === socket.id) {
      room.players[role] = null;
      if (room.state) {
        room.bots[role] = true;
        runBotsForPhase(room);
        broadcastState(room);
      }
      broadcastSummary(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
