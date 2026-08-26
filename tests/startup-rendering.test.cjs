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

test('storage statistics reconcile external output changes automatically', () => {
  const main = read('electron/main.cjs');
  const preload = read('electron/preload.cjs');
  const app = read('src/app.mjs');
  assert.match(main, /fs\.watch\(artifactRoot, \{ persistent: false \}/);
  assert.match(main, /studio:storage-status-changed/);
  assert.match(preload, /onStorageStatusChanged: \(callback\)/);
  assert.match(app, /if \(name === 'settings' && state\.bootstrap\) void refreshStorage\(\)/);
  assert.match(app, /if \(storageStatusPromise\) return storageStatusPromise/);
  assert.match(app, /window\.addEventListener\('focus', refreshVisibleStorage\)/);
  assert.match(app, /window\.voiceStudio\.onStorageStatusChanged\(\(storage\)/);
});

test('completed model downloads hide their progress panels', () => {
  const app = read('src/app.mjs');
  assert.match(app, /function modelDownloadProgressHidden\(download\)[\s\S]*\['idle', 'completed'\]\.includes\(download\?\.stage\)/);
  assert.match(app, /root\.classList\.toggle\('hidden', modelDownloadProgressHidden\(download\)\)/);
});

test('bottom preview restores the last saved voice and falls back to the newest library voice', () => {
  const app = read('src/app.mjs');
  assert.match(app, /const remembered = saved\?\.output[\s\S]*state\.library\.find\(\(voice\) => voice\.url && sameOutput\(voice\.output, saved\.output\)\)/);
  assert.match(app, /const result = remembered \|\| state\.library\.find\(\(voice\) => voice\.url && voice\.output\) \|\| null/);
  assert.doesNotMatch(app, /else if \(!state\.result\.savedVoiceId\) clearPersistedSelection\(\)/);
});

test('packaged workers launch from the actual asar-unpacked Python directory', () => {
  const main = read('electron/main.cjs');
  assert.match(main, /path\.join\(process\.resourcesPath, 'app\.asar\.unpacked', 'python'\)/);
  assert.doesNotMatch(main, /'app\.asar\.unpacked', 'voice-studio', 'python'/);
  assert.match(main, /if \(!exists\(this\.config\.python\)\) throw new Error/);
  assert.match(main, /if \(!exists\(this\.config\.script\)\) throw new Error/);
  assert.match(main, /if \(!exists\(pythonRoot\)\) throw new Error/);
});

test('bottom preview actions expose hover, pressed and keyboard focus feedback', () => {
  const css = read('src/enhancements.css');
  assert.match(css, /\.result-actions \.secondary:hover:not\(:disabled\)/);
  assert.match(css, /\.result-actions \.primary:hover:not\(:disabled\)/);
  assert.match(css, /\.result-actions button:active:not\(:disabled\)/);
  assert.match(css, /\.result-actions button:focus-visible/);
});
