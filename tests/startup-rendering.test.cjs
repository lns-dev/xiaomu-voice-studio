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

test('completed model downloads hide their progress panels', () => {
  const app = read('src/app.mjs');
  assert.match(app, /function modelDownloadProgressHidden\(download\)[\s\S]*\['idle', 'completed'\]\.includes\(download\?\.stage\)/);
  assert.match(app, /root\.classList\.toggle\('hidden', modelDownloadProgressHidden\(download\)\)/);
});

test('packaged workers launch from the actual asar-unpacked Python directory', () => {
  const main = read('electron/main.cjs');
  assert.match(main, /path\.join\(process\.resourcesPath, 'app\.asar\.unpacked', 'python'\)/);
  assert.doesNotMatch(main, /'app\.asar\.unpacked', 'voice-studio', 'python'/);
  assert.match(main, /if \(!exists\(this\.config\.python\)\) throw new Error/);
  assert.match(main, /if \(!exists\(this\.config\.script\)\) throw new Error/);
  assert.match(main, /if \(!exists\(pythonRoot\)\) throw new Error/);
});
