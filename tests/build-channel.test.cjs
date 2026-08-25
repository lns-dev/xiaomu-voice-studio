const test = require('node:test');
const assert = require('node:assert/strict');
const { detectBuildChannel } = require('../electron/build-channel.cjs');

test('distinguishes Debug, Alpha and formal Release builds', () => {
  assert.equal(detectBuildChannel({ isPackaged: false, version: '0.1.0' }), 'debug');
  assert.equal(detectBuildChannel({ isPackaged: true, version: '0.1.0-debug' }), 'debug');
  assert.equal(detectBuildChannel({ isPackaged: true, version: '0.1.0-alpha.5' }), 'alpha');
  assert.equal(detectBuildChannel({ isPackaged: true, version: '1.0.0' }), 'release');
});
