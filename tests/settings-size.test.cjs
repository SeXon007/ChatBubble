const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

test('settings fit resets manual/maximized sizing, bounds content, and rejects malformed requests', () => {
  const source = ts.createSourceFile('main.js', fs.readFileSync(path.join(__dirname, '../dist/main.js'), 'utf8'), ts.ScriptTarget.ES2022, true);
  let handler, maximized = true, size = [1000, 800], bounds = { x: -1600, y: 600, width: 1016, height: 839 }, validation = 0;
  const context = { settingsManuallySized: true,
    validate: (_event, settingsOnly) => { assert.equal(settingsOnly, true); validation++; },
    settingsWindow: { isMaximized: () => maximized, unmaximize: () => { maximized = false; }, getContentSize: () => size,
      getBounds: () => bounds, setContentSize: (w, h) => { size = [w, h]; bounds = { ...bounds, width: w + 16, height: h + 39 }; }, setBounds: value => { bounds = value; } },
    electron_1: { ipcMain: { handle: (_key, value) => { handler = value; } }, screen: { getDisplayMatching: () => ({ workArea: { x: -1280, y: 0, width: 1280, height: 720 } }) } },
    window_state_1: require('../dist/window-state') };
  vm.createContext(context);
  function visit(n) { if (ts.isCallExpression(n) && /ipcMain.handle$/.test(n.expression.getText(source)) && n.arguments[0]?.text === 'settings:resize') vm.runInContext(n.getText(source), context); ts.forEachChild(n, visit); } visit(source);
  handler({}, 500); assert.deepEqual(size, [1000, 800]);
  handler({}, 500, true); assert.deepEqual(size, [420, 500]); assert.equal(maximized, false); assert.equal(context.settingsManuallySized, false);
  assert.ok(bounds.x >= -1280 && bounds.x + bounds.width <= 0 && bounds.y + bounds.height <= 720);
  handler({}, 2000); assert.deepEqual(size, [420, 640]);
  const before = [...size]; for (const args of [[NaN], [Infinity], [-1], [2401], [300, 'true']]) assert.throws(() => handler({}, ...args), /Invalid settings size/);
  assert.deepEqual(size, before); assert.equal(validation, 8);
});
