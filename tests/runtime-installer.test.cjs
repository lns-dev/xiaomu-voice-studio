const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readManifest, verifyComponentFiles } = require('../electron/runtime-installer.cjs');

test('validates runtime bundle size and sha256', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-runtime-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'core.7z.001');
  fs.writeFileSync(bundle, 'fixture');
  const sha256 = crypto.createHash('sha256').update('fixture').digest('hex');
  const result = await verifyComponentFiles({ files: [{ name: path.basename(bundle), bytes: 7, sha256 }] }, root);
  assert.deepEqual(result, [bundle]);
});

test('rejects an invalid runtime manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-runtime-manifest-'));
  const file = path.join(root, 'manifest.json');
  fs.writeFileSync(file, '{}');
  assert.throws(() => readManifest(file), /清单无效/);
  fs.rmSync(root, { recursive: true, force: true });
});
