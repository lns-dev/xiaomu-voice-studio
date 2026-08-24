const fs = require('node:fs');
const path = require('node:path');

const MODEL_DEFINITIONS = Object.freeze({
  index: Object.freeze({ folder: 'IndexTTS-2.5', marker: 'config.yaml' }),
  qwen: Object.freeze({ folder: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign', marker: 'config.json' })
});

function uniqueDirectories(entries) {
  const seen = new Set();
  const directories = [];
  for (const entry of entries ?? []) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const resolved = path.resolve(entry);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    directories.push(resolved);
  }
  return directories;
}

function isModelDirectory(engine, candidate) {
  const definition = MODEL_DEFINITIONS[engine];
  if (!definition || !candidate) return false;
  try {
    return fs.statSync(candidate).isDirectory() && fs.existsSync(path.join(candidate, definition.marker));
  } catch {
    return false;
  }
}

function candidatesFromRoot(engine, root) {
  const definition = MODEL_DEFINITIONS[engine];
  if (!definition || !root) return [];
  const candidates = [root, path.join(root, definition.folder)];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).slice(0, 200)) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) candidates.push(path.join(root, entry.name));
    }
  } catch { /* missing or inaccessible search roots are ignored */ }
  return uniqueDirectories(candidates);
}

function findModelDirectory(engine, roots, preferred = null) {
  const ordered = uniqueDirectories([preferred, ...(roots ?? [])]);
  for (const root of ordered) {
    for (const candidate of candidatesFromRoot(engine, root)) {
      if (isModelDirectory(engine, candidate)) return candidate;
    }
  }
  return null;
}

function discoverModels({ roots = [], preferred = {} } = {}) {
  const checkedRoots = uniqueDirectories(roots);
  return {
    index: findModelDirectory('index', checkedRoots, preferred.index),
    qwen: findModelDirectory('qwen', checkedRoots, preferred.qwen),
    checkedRoots
  };
}

module.exports = { MODEL_DEFINITIONS, uniqueDirectories, isModelDirectory, findModelDirectory, discoverModels };
