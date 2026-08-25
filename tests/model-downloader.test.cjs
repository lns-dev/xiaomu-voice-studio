const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MODEL_DOWNLOAD_DEFINITIONS,
  downloadPreparedModel,
  normalizeRelativePath,
  prepareModelDownload,
  safeTarget,
  selectRepositoryFiles
} = require('../electron/model-downloader.cjs');

test('IndexTTS complete download includes every official auxiliary model', () => {
  const repositories = MODEL_DOWNLOAD_DEFINITIONS.index.repositories;
  assert.deepEqual(repositories.map((item) => item.repoId), [
    'IndexTeam/IndexTTS-2.5',
    'facebook/w2v-bert-2.0',
    'amphion/MaskGCT',
    'funasr/campplus',
    'nvidia/bigvgan_v2_22khz_80band_256x'
  ]);
});

test('model paths cannot escape the selected model directory', () => {
  const root = path.resolve(os.tmpdir(), 'voice-studio-model-root');
  assert.throws(() => normalizeRelativePath('../escape.bin'));
  assert.throws(() => safeTarget(root, '../escape.bin'));
  assert.equal(safeTarget(root, 'nested/model.bin'), path.join(root, 'nested', 'model.bin'));
});

test('mapped auxiliary files are placed in the flat IndexTTS hf_cache layout', () => {
  const repository = MODEL_DOWNLOAD_DEFINITIONS.index.repositories.find((item) => item.repoId === 'amphion/MaskGCT');
  const selected = selectRepositoryFiles(repository, {
    base: 'https://huggingface.co', revision: 'fixture', siblings: [
      { rfilename: 'README.md', size: 10 },
      { rfilename: 'semantic_codec/model.safetensors', size: 20, lfs: { sha256: 'a'.repeat(64), size: 20 } }
    ]
  });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].relativePath, 'hf_cache/semantic_codec_model.safetensors');
});

test('small model downloads resume, verify and write a completion manifest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-studio-model-download-'));
  const content = Buffer.from('complete-model-fixture');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const metadata = { sha: 'fixture-revision', siblings: [{ rfilename: 'model.bin', size: content.length, lfs: { size: content.length, sha256 } }] };
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('/api/models/')) return new Response(JSON.stringify(metadata), { status: 200, headers: { 'content-type': 'application/json' } });
    const range = options.headers?.Range;
    const offset = range ? Number(range.match(/bytes=(\d+)-/)?.[1] || 0) : 0;
    return new Response(content.subarray(offset), { status: offset ? 206 : 200 });
  };
  try {
    const prepared = await prepareModelDownload('qwen', root, { fetchImpl });
    // The production definition expects all files returned by metadata; our
    // fixture therefore exercises the same generic full-snapshot path.
    fs.writeFileSync(path.join(root, 'model.bin.part'), content.subarray(0, 7));
    const result = await downloadPreparedModel(prepared, { fetchImpl });
    assert.equal(result.fileCount, 1);
    assert.deepEqual(fs.readFileSync(path.join(root, 'model.bin')), content);
    assert.ok(fs.existsSync(path.join(root, '.xiaomu-model-manifest.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
