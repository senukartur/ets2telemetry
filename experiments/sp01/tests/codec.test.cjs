'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Decoder, validate } = require('../app/codec.cjs');
const fixture = (changes = {}) => ({ v: 'sp01-1', session: 'a'.repeat(32), game: 'eut2', seq: '1', frame: '9', renderUs: '18446744073709551615', simulationUs: '900', dropped: '0', speedMps: 0, fuelLitres: 0, paused: false, timerRestart: false, window: { visible: true, x: -1920, y: 0, width: 1920, height: 1080 }, ...changes });
const bytes = (value) => Buffer.from(JSON.stringify(value) + '\n');
test('fragmentation preserves zero, unavailable, negative monitor coordinates and uint64 precision', () => {
  const decoder = new Decoder('eut2'); const input = bytes(fixture({ fuelLitres: null }));
  assert.deepEqual(decoder.push(input.subarray(0, 15)), []);
  assert.deepEqual(decoder.push(input.subarray(15)), [fixture({ fuelLitres: null })]);
});
test('multiple frames preserve order and reconnect decoder permits sequence continuation', () => {
  const decoder = new Decoder('eut2');
  assert.equal(decoder.push(Buffer.concat([bytes(fixture()), bytes(fixture({ seq: '4' }))])).length, 2);
  assert.equal(new Decoder('eut2').push(bytes(fixture({ seq: '5' })))[0].seq, '5');
});
test('duplicate, decreasing sequence and changed session are rejected', () => {
  for (const changes of [{}, { seq: '0' }, { seq: '2', session: 'b'.repeat(32) }]) {
    const decoder = new Decoder('eut2'); decoder.push(bytes(fixture()));
    assert.throws(() => decoder.push(bytes(fixture(changes))));
  }
});
test('unknown version/game, overflow and malformed fields are rejected', () => {
  for (const changes of [{ v: '1' }, { game: 'ats' }, { seq: '18446744073709551616' }, { seq: 1 }, { seq: '01' }, { fuelLitres: -1 }, { speedMps: Infinity }, { paused: 1 }, { session: {} }, { window: { visible: true, x: 0, y: 0, width: 0, height: 1 } }]) {
    assert.throws(() => validate(fixture(changes), 'eut2'));
  }
});
test('nonfinite serialization and oversized unterminated or complete frames fail closed', () => {
  assert.throws(() => new Decoder('eut2').push(Buffer.alloc(2049, 32)));
  assert.throws(() => new Decoder('eut2').push(Buffer.from(' '.repeat(2049) + '\n')));
  assert.throws(() => new Decoder('eut2').push(Buffer.alloc(65537)));
  assert.throws(() => new Decoder('eut2').push(Buffer.from([0xff, 10])));
  assert.throws(() => new Decoder('eut2').push(Buffer.from('\n')));
});
test('unavailable and valid zero differ; extra fields do not cross renderer boundary', () => {
  assert.equal(validate(fixture({ speedMps: null }), 'eut2').speedMps, null);
  assert.equal(validate(fixture(), 'eut2').speedMps, 0);
  assert.equal('unexpected' in validate(fixture({ unexpected: 'value' }), 'eut2'), false);
});
