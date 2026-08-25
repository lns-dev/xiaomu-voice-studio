const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readManifest, removeDownloadedBundles, validateExtractor, verifyComponentFiles } = require('../electron/runtime-installer.cjs');

test('ships a valid 7-Zip runtime extractor', async () => {
  await validateExtractor(path.resolve(__dirname, '..', 'release', 'tools', '7za.exe'));
});

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

test('removes downloaded runtime archives only from the managed download directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-runtime-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'downloads', 'runtime', 'test-version');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'core.7z.001'), 'fixture');
  removeDownloadedBundles(root, bundle);
  assert.equal(fs.existsSync(bundle), false);
  assert.equal(fs.existsSync(path.join(root, 'downloads')), false);
  assert.throws(() => removeDownloadedBundles(root, path.join(root, 'models')), /拒绝清理/);
});
