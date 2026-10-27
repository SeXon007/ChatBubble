const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clampBounds, canSubmit } = require('../dist/window-state.js');
test('disconnected monitor position is moved into remaining work area', () => {
  assert.deepEqual(clampBounds({ x: 2400, y: 1300, width: 354, height: 490 }, { x: 0, y: 0, width: 1920, height: 1040 }), { x: 1566, y: 550, width: 354, height: 490 });
});
test('negative monitor coordinates and smaller work areas are supported', () => {
  assert.deepEqual(clampBounds({ x: 100, y: -400, width: 354, height: 490 }, { x: -300, y: -200, width: 300, height: 400 }), { x: -300, y: -200, width: 300, height: 400 });
});
test('blank text and active IME composition cannot submit', () => {
  assert.equal(canSubmit('  \n ', false), false);
  assert.equal(canSubmit('中文', true), false);
  assert.equal(canSubmit('中文', false), true);
});
