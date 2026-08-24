const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverModels, findModelDirectory } = require('../electron/model-locations.cjs');

test('detects IndexTTS and Qwen models from a parent model directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-studio-models-'));
  try {
    const index = path.join(root, 'IndexTTS-2.5');
    const qwen = path.join(root, 'Qwen3-TTS-12Hz-1.7B-VoiceDesign');
    fs.mkdirSync(index); fs.mkdirSync(qwen);
    fs.writeFileSync(path.join(index, 'config.yaml'), 'model: index');
    fs.writeFileSync(path.join(qwen, 'config.json'), '{}');
    const detected = discoverModels({ roots: [root] });
    assert.equal(detected.index, index);
    assert.equal(detected.qwen, qwen);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepts a directly selected model directory and rejects incomplete folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-studio-model-direct-'));
  try {
    const complete = path.join(root, 'custom-index');
    const incomplete = path.join(root, 'incomplete');
    fs.mkdirSync(complete); fs.mkdirSync(incomplete);
    fs.writeFileSync(path.join(complete, 'config.yaml'), 'model: index');
    assert.equal(findModelDirectory('index', [complete]), complete);
    assert.equal(findModelDirectory('index', [incomplete]), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
