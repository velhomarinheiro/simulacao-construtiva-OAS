'use strict';

// End-to-end socket tests for the P2 resilience + async-batch changes.
// Starts the real server on an ephemeral port and drives it with socket.io
// clients, asserting against the exported `rooms` map.

const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const { io: Client } = require('socket.io-client');

const { server, rooms } = require('../../server.js');

let port;
const clients = [];
function connect() {
  const c = Client(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
  clients.push(c);
  return c;
}
const once = (sock, ev) => new Promise(res => sock.once(ev, res));
const ready = sock => once(sock, 'connect');
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

before(async () => {
  await new Promise(res => server.listen(0, res));
  port = server.address().port;
});

after(async () => {
  for (const c of clients) c.close();
  await new Promise(res => server.close(res));
});

test('facilitator disconnect keeps the room alive; rejoin_room reclaims it', async () => {
  const fac = connect();
  await ready(fac);
  fac.emit('create_room');
  const rc = await once(fac, 'room_created');
  const roomId = rc.roomId;
  assert.ok(rooms.has(roomId));

  fac.disconnect();
  await tick();
  assert.ok(rooms.has(roomId), 'room NOT deleted on facilitator drop (grace period)');
  assert.equal(rooms.get(roomId).players.facilitator, null);

  const fac2 = connect();
  await ready(fac2);
  fac2.emit('rejoin_room', { roomId });
  const rc2 = await once(fac2, 'room_created');
  assert.equal(rc2.rejoined, true);
  assert.ok(rooms.get(roomId).players.facilitator, 'facilitator seat reclaimed');
});

test('human player disconnect hands the team to the bot (no stall)', async () => {
  const fac = connect();
  await ready(fac);
  fac.emit('create_room');
  const { roomId } = await once(fac, 'room_created');

  const blue = connect();
  await ready(blue);
  blue.emit('join_room', { roomId, team: 'blue' });
  await once(blue, 'join_success');

  fac.emit('start_game', {});
  await once(fac, 'game_start');
  assert.equal(rooms.get(roomId).bots.blue, false, 'blue is human at start');

  const takeover = once(fac, 'player_ai_takeover');
  blue.disconnect();
  const ev = await takeover;
  assert.equal(ev.team, 'blue');
  assert.equal(rooms.get(roomId).bots.blue, true, 'blue handed to the digital player');
});

test('batch simulation runs in chunks with progress and returns all rows', async () => {
  const fac = connect();
  await ready(fac);
  fac.emit('create_room');
  await once(fac, 'room_created');

  let progressSeen = 0;
  fac.on('batch_progress', () => { progressSeen++; });
  fac.emit('run_batch_simulations', { replicas: 12, maxTurns: 6 });
  const res = await once(fac, 'batch_simulation_results');

  assert.equal(res.rows.length, 12);
  assert.ok(progressSeen >= 1, 'emitted at least one batch_progress (12 replicas > chunk of 5)');
  assert.equal(res.summary.n, 12);
});

test('update_ob rejects a malformed order of battle', async () => {
  const fac = connect();
  await ready(fac);
  fac.emit('create_room');
  await once(fac, 'room_created');

  fac.emit('update_ob', { ob: { forces: { blue: [{ id: 'X', name: 'X', category: 'banana', stayingPower: 0, movement: 1, position: { col: 1, row: 1 } }] } } });
  const r = await once(fac, 'ob_updated');
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
});
