const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

test('startup bootstrap does not block the interface on runtime compatibility probing', () => {
  const main = read('electron/main.cjs');
  const bootstrapHandler = main.match(/ipcMain\.handle\('studio:bootstrap',[\s\S]*?\n\}\);/)?.[0] || '';
  assert.doesNotMatch(bootstrapHandler, /runtimeLocations\.probe/);
});

test('engine settings have structured first-paint content before bootstrap completes', () => {
  const html = read('src/index.html');
  for (const id of ['runtime-settings', 'qwen-settings', 'index-settings']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*>[\\s\\S]{0,400}settings-card-loading`));
  }
});

test('system and storage status restore snapshots before silent refresh', () => {
  const app = read('src/app.mjs');
  assert.match(app, /restoreStatusSnapshots\(\);[\s\S]*await window\.voiceStudio\.getBootstrap\(\)/);
  assert.match(app, /void pollSystemStatus\(\);[\s\S]*void refreshStorage\(\);/);
  assert.match(app, /void probeRuntimeInBackground\(\);/);
});
