const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('overwrite installer preserves all user-owned software-root directories', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  for (const directory of ['models', 'outputs', 'runtime', 'engines', 'tools']) {
    assert.match(installer, new RegExp(`preserveUpgradeDirectory "${directory}"`));
    assert.match(installer, new RegExp(`restoreUpgradeDirectory "${directory}"`));
  }
  assert.match(installer, /Function \.onGUIEnd[\s\S]*Call restoreXiaoMuUpgradeData/);
});
