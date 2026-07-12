'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const TAX = require('../force_taxonomy');
const JSON_DATA = require('../force_taxonomy.json');
const { ORDER_OF_BATTLE } = require('../order_of_battle');
const { FPSO_UNIT_IDS, PORT_UNIT_IDS } = require('../capability_factors');

const AERO_IDS = ['BLUE-AERO-RJ', 'BLUE-AERO-SP', 'BLUE-AERO-CF'];
const INFRA_IDS = new Set([...FPSO_UNIT_IDS, ...PORT_UNIT_IDS, ...AERO_IDS]);

test('the JS module mirrors force_taxonomy.json exactly (single source of truth)', () => {
  assert.deepEqual(TAX.TAXONOMY, JSON_DATA.taxonomia, 'force_taxonomy.js drifted from force_taxonomy.json');
});

test('classifyUnit maps known units and falls back to INFRA', () => {
  assert.deepEqual(TAX.classifyUnit('BLUE-SAG-P', 'blue'), { domain: '⚓ Naval — Superfície', sigla: 'INTERV', label: 'Intervenção (grupo aeronaval)' });
  assert.equal(TAX.classifyUnit('BLUE-SUB-N', 'blue').sigla, 'DISS');
  assert.equal(TAX.classifyUnit('RED-GE-1', 'red').sigla, 'INTERV', 'scenario decision: ESCCSG in INTERV');
  assert.equal(TAX.classifyUnit('RED-GE-2', 'red').sigla, 'VIG');
  // protected asset / unknown -> INFRA fallback
  assert.equal(TAX.classifyUnit('BLUE-FPSO1', 'blue').sigla, 'INFRA');
  assert.equal(TAX.classifyUnit('NEU-MERCANTE-1', 'blue').sigla, 'INFRA');
  assert.equal(TAX.classifyUnit('does-not-exist', 'red').sigla, 'INFRA');
});

test('taxonomyOrder follows domain -> group -> position, monotonically', () => {
  const ord = TAX.taxonomyOrder('blue');
  // NAV_SURF (INTERV) < NAV_SUB (DISS) < AIR (DAE) < LAND (DCOST)
  assert.ok(ord.get('BLUE-SAG-P') < ord.get('BLUE-SUB-N'));
  assert.ok(ord.get('BLUE-SUB-N') < ord.get('BLUE-CACA-1'));
  assert.ok(ord.get('BLUE-CACA-1') < ord.get('BLUE-DCOST1'));
  // within a group, list order is preserved
  assert.ok(ord.get('BLUE-SAG-S1') < ord.get('BLUE-SAG-S2'));
});

test('groupLabels lists taxonomy order and ends with INFRA', () => {
  const gl = TAX.groupLabels('blue');
  assert.equal(gl[0].sigla, 'INTERV');
  assert.equal(gl[gl.length - 1].sigla, 'INFRA');
  assert.ok(gl.some(g => g.sigla === 'OPESP'));
});

test('coverage: every combat OB unit classifies to a real group; protected assets -> INFRA', () => {
  for (const side of ['blue', 'red']) {
    for (const spec of (ORDER_OF_BATTLE.forces[side] || [])) {
      const c = TAX.classifyUnit(spec.id, side);
      if (INFRA_IDS.has(spec.id)) {
        assert.equal(c.sigla, 'INFRA', `${spec.id} should be INFRA`);
      } else {
        assert.notEqual(c.sigla, 'INFRA', `combat unit ${spec.id} is unclassified (fell to INFRA)`);
      }
    }
  }
});
