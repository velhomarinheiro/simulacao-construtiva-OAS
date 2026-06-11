'use strict';

/**
 * bot_player.js
 * =============
 *
 * Headless socket.io client that plays one seat (blue, red, or
 * facilitator) using the shared CBP decision engine
 * (shared/bot/decision_engine.js). Used both as an AI opponent for a
 * human player (one bot joins an existing room) and to drive fully
 * autonomous bot-vs-bot matches for verification / Monte Carlo runs.
 *
 * Usage:
 *   node bot/bot_player.js <url> facilitator
 *   node bot/bot_player.js <url> <blue|red> <roomId>
 *   node bot/bot_player.js <url> match [maxTurns]
 *
 *   facilitator -> creates a room, starts the game once both seats are
 *                  filled, and auto-approves movement/combat each turn.
 *   blue|red    -> joins `roomId` and plays that seat using
 *                  decideMovement/decideAttacks each phase.
 *   match       -> runs an autonomous facilitator + blue + red bot in
 *                  one process (optionally capped at `maxTurns`).
 */

const { io } = require('socket.io-client');
const { decideMovement, decideAttacks } = require('../shared/bot/decision_engine');

function log(role, ...args) {
  console.log(`[${role}]`, ...args);
}

/**
 * Auto-facilitator: creates a room, starts the game once both seats are
 * filled, and auto-approves movement/combat each turn (no overrides,
 * accepts resolved HP as-is).
 */
function runFacilitator(url, { onRoomId, onGameOver, maxTurns } = {}) {
  const socket = io(url, { reconnection: false });
  socket.on('connect', () => socket.emit('create_room'));
  socket.on('room_created', ({ roomId }) => {
    log('facilitator', `room ${roomId} created`);
    onRoomId?.(roomId);
  });
  socket.on('player_joined', ({ blueReady, redReady }) => {
    if (blueReady && redReady) socket.emit('start_game');
  });
  socket.on('movement_approval_needed', state => {
    if (maxTurns && state.turn > maxTurns) {
      log('facilitator', `turn limit (${maxTurns}) reached, ending match`);
      socket.close();
      onGameOver?.({ winner: null, timedOut: true });
      return;
    }
    socket.emit('approve_movements', { overrides: [] });
  });
  socket.on('combat_approval_needed', () => socket.emit('approve_combat', { hpChanges: [] }));
  socket.on('game_over', ({ winner }) => {
    log('facilitator', `game over - ${winner} wins`);
    socket.close();
    onGameOver?.({ winner });
  });
  socket.on('action_error', msg => log('facilitator', 'error:', msg));
  return socket;
}

/**
 * Plays one seat (blue/red), joining `roomId` and acting on every
 * movement/combat phase via the shared decision engine.
 */
function runTeamBot(url, team, roomId) {
  const socket = io(url, { reconnection: false });
  let movedThisPhase = false;
  let attackedThisPhase = false;

  socket.on('connect', () => socket.emit('join_room', { roomId, team }));
  socket.on('join_error', msg => log(team, 'join error:', msg));
  socket.on('join_success', () => log(team, `joined room ${roomId}`));

  function act(state) {
    if (state.winner) return;

    if (state.phase === 'movement') {
      const done = team === 'blue' ? state.blueDone : state.redDone;
      if (!done && !movedThisPhase) {
        movedThisPhase = true;
        const moves = decideMovement(state, team);
        socket.emit('commit_moves', { moves });
        log(team, `turn ${state.turn}: committed ${moves.length} move(s)`);
      }
    } else {
      movedThisPhase = false;
    }

    if (state.phase === 'combat') {
      const declared = team === 'blue' ? state.blueAttacks : state.redAttacks;
      if (declared === null && !attackedThisPhase) {
        attackedThisPhase = true;
        const attacks = decideAttacks(state, team);
        socket.emit('declare_attacks', attacks);
        log(team, `turn ${state.turn}: declared ${attacks.length} attack(s)`);
      }
    } else {
      attackedThisPhase = false;
    }
  }

  socket.on('game_start', ({ state }) => act(state));
  socket.on('game_update', state => act(state));
  socket.on('game_over', ({ winner }) => {
    log(team, `game over - ${winner} wins`);
    socket.close();
  });
  socket.on('action_error', msg => log(team, 'error:', msg));
  return socket;
}

if (require.main === module) {
  const [, , url, role, arg] = process.argv;
  if (!url || !role) {
    console.error('Usage: node bot/bot_player.js <url> <facilitator|blue|red|match> [roomId|maxTurns]');
    process.exit(1);
  }
  if (role === 'facilitator') {
    runFacilitator(url);
  } else if (role === 'blue' || role === 'red') {
    if (!arg) { console.error('roomId required for blue/red'); process.exit(1); }
    runTeamBot(url, role, arg);
  } else if (role === 'match') {
    const maxTurns = Number(arg) || 30;
    runFacilitator(url, {
      maxTurns,
      onRoomId: roomId => {
        runTeamBot(url, 'blue', roomId);
        runTeamBot(url, 'red', roomId);
      },
    });
  } else {
    console.error(`unknown role: ${role}`);
    process.exit(1);
  }
}

module.exports = { runFacilitator, runTeamBot };
