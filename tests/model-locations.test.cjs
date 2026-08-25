const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MODEL_DEFINITIONS, discoverModels, findModelDirectory, missingModelFiles } = require('../electron/model-locations.cjs');

function createCompleteModel(engine, directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const relativePath of MODEL_DEFINITIONS[engine].requiredFiles) {
    const target = path.join(directory, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'fixture');
  }
}

test('detects IndexTTS and Qwen models from a parent model directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-studio-models-'));
  try {
    const index = path.join(root, 'IndexTTS-2.5');
    const qwen = path.join(root, 'Qwen3-TTS-12Hz-1.7B-VoiceDesign');
    createCompleteModel('index', index);
    createCompleteModel('qwen', qwen);
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
    createCompleteModel('index', complete);
    fs.mkdirSync(incomplete);
    fs.writeFileSync(path.join(incomplete, 'config.yaml'), 'model: index');
    assert.equal(findModelDirectory('index', [complete]), complete);
    assert.equal(findModelDirectory('index', [incomplete]), null);
    assert.ok(missingModelFiles('index', incomplete).includes('gpt.pth'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
