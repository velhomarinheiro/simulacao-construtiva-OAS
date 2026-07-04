'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCSV, obFromCsv, validateOB } = require('../ob_io');

test('parseCSV handles quoted fields with embedded newlines and escaped quotes', () => {
  const csv = 'a,b,c\n1,"line1\nline2","he said ""hi"""\n2,x,y';
  const rows = parseCSV(csv);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], ['a', 'b', 'c']);
  assert.equal(rows[1][1], 'line1\nline2', 'quoted newline stays in one field');
  assert.equal(rows[1][2], 'he said "hi"');
  assert.deepEqual(rows[2], ['2', 'x', 'y']);
});

test('obFromCsv keeps a legit 0 instead of substituting the default', () => {
  const csv = [
    'team,id,name,category,stayingPower,movement,col,row',
    'blue,B1,Frag,surface,4,0,3,3',   // movement 0 must NOT become 2
  ].join('\n');
  const ob = obFromCsv(csv);
  assert.equal(ob.forces.blue.length, 1);
  assert.equal(ob.forces.blue[0].movement, 0, '0 preserved (not defaulted to 2)');
  assert.equal(ob.forces.blue[0].stayingPower, 4);
  assert.equal(ob.forces.blue[0].position.col, 3);
});

test('obFromCsv round-trips weapons/composition JSON even with embedded newlines', () => {
  const csv = 'team,name,category,col,row,weapons_json\n' +
    'red,Dest,surface,5,5,"{""ascm"":{""quantity"":14,\n""range"":6}}"';
  const ob = obFromCsv(csv);
  assert.equal(ob.forces.red[0].weapons.ascm.quantity, 14);
  assert.equal(ob.forces.red[0].weapons.ascm.range, 6);
});

test('obFromCsv throws on missing required columns', () => {
  assert.throws(() => obFromCsv('team,name\nblue,X'), /coluna obrigatória/);
});

test('validateOB accepts a well-formed OB', () => {
  const ob = { forces: { blue: [
    { id: 'B1', name: 'Frag', category: 'surface', stayingPower: 4, movement: 2, position: { col: 3, row: 3 }, weapons: {}, capabilities: {} },
  ] } };
  assert.deepEqual(validateOB(ob), { ok: true, errors: [] });
});

test('validateOB flags every structural problem', () => {
  const ob = { forces: { blue: [
    { id: 'B1', name: 'A', category: 'banana', stayingPower: 0, movement: 2, position: { col: 3, row: 3 } },
    { id: 'B1', name: '', category: 'surface', stayingPower: 4, movement: -1, position: { col: 99, row: 3 } },
  ] } };
  const { ok, errors } = validateOB(ob);
  assert.equal(ok, false);
  assert.ok(errors.some(e => /category/.test(e)), 'bad category');
  assert.ok(errors.some(e => /stayingPower/.test(e)), 'sp<=0');
  assert.ok(errors.some(e => /id duplicado/.test(e)), 'dup id');
  assert.ok(errors.some(e => /movement/.test(e)), 'movement<0');
  assert.ok(errors.some(e => /fora do tabuleiro/.test(e)), 'out of bounds');
});

test('validateOB rejects a non-OB', () => {
  assert.equal(validateOB(null).ok, false);
  assert.equal(validateOB({}).ok, false);
  assert.equal(validateOB({ forces: {} }).ok, false); // no units
});
