'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Admissibility,
  BattleState,
  DirectionalParameters,
  EngagementParameters,
  Force,
  PairParameters,
  UnitType,
  salvoStep,
} = require('../index');

function simpleHomogeneous({
  A0 = 4.0,
  B0 = 3.0,
  alpha = 2.0,
  beta = 2.0,
  z = 1.0,
  y = 1.0,
  w = 2.0,
  x = 2.0,
} = {}) {
  const blue = new Force('Blue', [
    new UnitType({ name: 'B', domain: 'S', stayingPower: w, initialStrength: B0 }),
  ]);
  const red = new Force('Red', [
    new UnitType({ name: 'A', domain: 'S', stayingPower: x, initialStrength: A0 }),
  ]);
  const bar = DirectionalParameters.zeros(blue, red);
  bar.set('B', 'A', new PairParameters({ pOffense: beta, pDefense: y }));
  const rab = DirectionalParameters.zeros(red, blue);
  rab.set('A', 'B', new PairParameters({ pOffense: alpha, pDefense: z }));
  const ep = new EngagementParameters({ blue, red, blueAttacksRed: bar, redAttacksBlue: rab });
  const bs = new BattleState(blue, red);
  const adm = Admissibility.degenerate();
  return { bs, ep, adm };
}

test('basic: pre-strengths match initial', () => {
  const { bs, ep, adm } = simpleHomogeneous({ A0: 5, B0: 7 });
  const out = salvoStep(bs, ep, adm, { apply: false });
  assert.deepEqual(out.redStrengthPre, [5.0]);
  assert.deepEqual(out.blueStrengthPre, [7.0]);
});

test('basic: apply=false does not mutate', () => {
  const { bs, ep, adm } = simpleHomogeneous({ A0: 5, B0: 7 });
  salvoStep(bs, ep, adm, { apply: false });
  assert.deepEqual(bs.blue.strengthVector(), [7.0]);
  assert.deepEqual(bs.red.strengthVector(), [5.0]);
});

test('basic: apply=true mutates per Hughes equation', () => {
  // ΔA = -(βB - yA)/x = -(4*3 - 1*4)/2 = -4 -> A_post = max(0, 4-4) = 0
  const { bs, ep, adm } = simpleHomogeneous({
    A0: 4, B0: 3, alpha: 4.0, beta: 4.0, z: 1.0, y: 1.0, w: 2.0, x: 2.0,
  });
  salvoStep(bs, ep, adm, { apply: true });
  assert.ok(Math.abs(bs.red.strengthVector()[0] - 0.0) < 1e-9);
});

test('basic: record_time appends to salvoTimes', () => {
  const { bs, ep, adm } = simpleHomogeneous();
  assert.deepEqual(bs.salvoTimes, []);
  salvoStep(bs, ep, adm, { apply: true, recordTime: 1.5 });
  assert.deepEqual(bs.salvoTimes, [1.5]);
});

test('edge: no offense -> no losses', () => {
  const { bs, ep, adm } = simpleHomogeneous({ alpha: 0.0, beta: 0.0 });
  const out = salvoStep(bs, ep, adm, { apply: false });
  assert.deepEqual(out.blueLosses, [0.0]);
  assert.deepEqual(out.redLosses, [0.0]);
});

test('edge: defense dominates -> no loss', () => {
  // beta*B = 1*3 = 3 vs y*A = 5*4 = 20 -> max(0,-17) = 0
  const { bs, ep, adm } = simpleHomogeneous({ beta: 1.0, y: 5.0 });
  const out = salvoStep(bs, ep, adm, { apply: false });
  assert.deepEqual(out.redLosses, [0.0]);
});

test('edge: loss capped at initial strength', () => {
  const { bs, ep, adm } = simpleHomogeneous({
    A0: 4.0, B0: 3.0, alpha: 0.0, beta: 1000.0, z: 0.0, y: 0.0, w: 1.0, x: 1.0,
  });
  const out = salvoStep(bs, ep, adm, { apply: false });
  assert.ok(Math.abs(out.redLosses[0] - 4.0) < 1e-9);
  assert.equal(out.redStrengthPost[0], 0.0);
});

test('edge: admissibility zero blocks attrition (U attacker -> A defender)', () => {
  const blue = new Force('Blue', [new UnitType({ name: 'BSub', domain: 'U', stayingPower: 2.0, initialStrength: 1 })]);
  const red = new Force('Red', [new UnitType({ name: 'RAir', domain: 'A', stayingPower: 2.0, initialStrength: 1 })]);
  const bar = DirectionalParameters.zeros(blue, red);
  bar.set('BSub', 'RAir', new PairParameters({ pOffense: 10.0, pDefense: 0.0 }));
  const rab = DirectionalParameters.zeros(red, blue);
  rab.set('RAir', 'BSub', new PairParameters({ pOffense: 10.0, pDefense: 0.0 }));
  const ep = new EngagementParameters({ blue, red, blueAttacksRed: bar, redAttacksBlue: rab });
  const bs = new BattleState(blue, red);
  const adm = Admissibility.canonical();
  const out = salvoStep(bs, ep, adm, { apply: false });
  // Blue (U) -> Red (A) is admissibility 0; Red suffers nothing.
  assert.deepEqual(out.redLosses, [0.0]);
});

test('edge: admissibility chi scales kernel linearly', () => {
  function scenario(chiValue) {
    const blue = new Force('Blue', [new UnitType({ name: 'BS', domain: 'S', stayingPower: 2.0, initialStrength: 4 })]);
    const red = new Force('Red', [new UnitType({ name: 'RU', domain: 'U', stayingPower: 2.0, initialStrength: 4 })]);
    const bar = DirectionalParameters.zeros(blue, red);
    bar.set('BS', 'RU', new PairParameters({ pOffense: 5.0, pDefense: 0.0 }));
    const rab = DirectionalParameters.zeros(red, blue);
    rab.set('RU', 'BS', new PairParameters({ pOffense: 0.0, pDefense: 0.0 }));
    const ep = new EngagementParameters({ blue, red, blueAttacksRed: bar, redAttacksBlue: rab });
    const bs = new BattleState(blue, red);
    const M = Array.from({ length: 5 }, () => Array(5).fill(0.0));
    M[0][1] = chiValue; // S -> U
    const adm = Admissibility.fromArray(M);
    return { bs, ep, adm };
  }
  const s1 = scenario(1.0);
  const s2 = scenario(0.3);
  const out1 = salvoStep(s1.bs, s1.ep, s1.adm, { apply: false });
  const out2 = salvoStep(s2.bs, s2.ep, s2.adm, { apply: false });
  assert.ok(Math.abs(out2.redRawKernel[0] - 0.3 * out1.redRawKernel[0]) < 1e-9);
});

test('simultaneity: first strike does not get full credit', () => {
  const { bs, ep, adm } = simpleHomogeneous({
    A0: 5.0, B0: 2.0, alpha: 0.0, beta: 10.0, z: 0.0, y: 0.0, w: 1.0, x: 1.0,
  });
  salvoStep(bs, ep, adm, { apply: true });
  assert.deepEqual(bs.blue.strengthVector(), [2.0]);
  assert.deepEqual(bs.red.strengthVector(), [0.0]);
});

test('simultaneity: mutual kill possible', () => {
  const { bs, ep, adm } = simpleHomogeneous({
    A0: 2.0, B0: 2.0, alpha: 10.0, beta: 10.0, z: 0.0, y: 0.0, w: 1.0, x: 1.0,
  });
  salvoStep(bs, ep, adm, { apply: true });
  assert.deepEqual(bs.blue.strengthVector(), [0.0]);
  assert.deepEqual(bs.red.strengthVector(), [0.0]);
});

test('sanity: monotonic in offensive throughput', () => {
  const s1 = simpleHomogeneous({ beta: 2.0 });
  const s2 = simpleHomogeneous({ beta: 4.0 });
  const out1 = salvoStep(s1.bs, s1.ep, s1.adm, { apply: false });
  const out2 = salvoStep(s2.bs, s2.ep, s2.adm, { apply: false });
  assert.ok(out2.redLosses[0] >= out1.redLosses[0]);
});

test('sanity: monotonic in defensive throughput (inverse)', () => {
  const s1 = simpleHomogeneous({ y: 0.5 });
  const s2 = simpleHomogeneous({ y: 2.0 });
  const out1 = salvoStep(s1.bs, s1.ep, s1.adm, { apply: false });
  const out2 = salvoStep(s2.bs, s2.ep, s2.adm, { apply: false });
  assert.ok(out2.redLosses[0] <= out1.redLosses[0]);
});

test('heterogeneous 2v2: locks in step1 integration value (kernel BF1 = 1.3)', () => {
  const blue = new Force('Blue', [
    new UnitType({ name: 'BF1', domain: 'S', stayingPower: 3.0, initialStrength: 4 }),
    new UnitType({ name: 'BF2', domain: 'S', stayingPower: 2.0, initialStrength: 2 }),
  ]);
  const red = new Force('Red', [
    new UnitType({ name: 'RF1', domain: 'S', stayingPower: 4.0, initialStrength: 3 }),
    new UnitType({ name: 'RF2', domain: 'S', stayingPower: 2.0, initialStrength: 2 }),
  ]);
  const bar = DirectionalParameters.zeros(blue, red);
  const rab = DirectionalParameters.zeros(red, blue);
  const params = new PairParameters({
    sigmaOffense: 0.5, etaOffense: 0.9, pOffense: 2.0,
    sigmaDefense: 0.5, etaDefense: 0.8, pDefense: 1.0,
  });
  for (const bj of ['BF1', 'BF2']) {
    for (const ri of ['RF1', 'RF2']) bar.set(bj, ri, params);
  }
  for (const rj of ['RF1', 'RF2']) {
    for (const bi of ['BF1', 'BF2']) rab.set(rj, bi, params);
  }
  const ep = new EngagementParameters({ blue, red, blueAttacksRed: bar, redAttacksBlue: rab });
  const bs = new BattleState(blue, red);
  const adm = Admissibility.degenerate();
  const out = salvoStep(bs, ep, adm, { apply: true });
  assert.ok(Math.abs(out.blueRawKernel[0] - 1.3) < 1e-9);
  assert.ok(Math.abs(out.blueLosses[0] - 1.3 / 3.0) < 1e-9);
  assert.ok(Math.abs(bs.blue.strengthOf('BF1') - (4.0 - 1.3 / 3.0)) < 1e-9);
});
