'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { updateOverlayBounds } = require('../app/overlay-window.cjs');
function windowAt(bounds) {
  let value = { ...bounds }; const writes = [];
  return { getBounds: () => ({ ...value }), setBounds: (next) => { value = { ...next }; writes.push(value); }, writes };
}
test('unchanged anchor avoids geometry writes; moving preserves the fixed size', () => {
  const win = windowAt({ x: 20, y: 20, width: 280, height: 96 });
  for (let index = 0; index < 100; index++) assert.equal(updateOverlayBounds(win, { x: 0, y: 0 }), false);
  assert.equal(win.writes.length, 0);
  assert.equal(updateOverlayBounds(win, { x: -200.6, y: 80.6 }), true);
  assert.deepEqual(win.getBounds(), { x: -181, y: 101, width: 280, height: 96 });
  assert.equal(win.writes.length, 1);
});
test('same anchor repairs oversized external bounds rather than caching position alone', () => {
  const win = windowAt({ x: 20, y: 20, width: 282, height: 1802 });
  assert.equal(updateOverlayBounds(win, { x: 0, y: 0 }), true);
  assert.deepEqual(win.getBounds(), { x: 20, y: 20, width: 280, height: 96 });
  assert.equal(updateOverlayBounds(win, { x: 0, y: 0 }), false);
  assert.equal(win.writes.length, 1);
});
