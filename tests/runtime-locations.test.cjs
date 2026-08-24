const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntimeLocations, pythonFromRoot, uniquePaths } = require('../electron/runtime-locations.cjs');

test('pythonFromRoot supports a runtime root and direct executable', () => {
  assert.equal(path.basename(pythonFromRoot('C:/runtime')), 'python.exe');
  assert.equal(pythonFromRoot('C:/runtime/python.exe'), path.resolve('C:/runtime/python.exe'));
});

test('uniquePaths removes case-insensitive duplicates', () => {
  assert.equal(uniquePaths(['C:/Runtime', 'c:/runtime']).length, 1);
});

test('packaged discovery never includes development-only candidates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-runtime-'));
  const dev = path.join(root, 'dev');
  fs.mkdirSync(dev, { recursive: true });
  fs.writeFileSync(path.join(dev, 'python.exe'), 'fixture');
  const runtime = createRuntimeLocations({
    isPackaged: true,
    programRoot: path.join(root, 'program'),
    dataRoot: path.join(root, 'data'),
    userDataRoot: path.join(root, 'state'),
    localAppData: '',
    pathValue: '',
    developmentCandidates: [dev]
  });
  assert.equal(runtime.candidates().length, 0);
});
