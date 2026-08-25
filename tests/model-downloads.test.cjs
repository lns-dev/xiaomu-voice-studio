const assert = require('node:assert/strict');
const test = require('node:test');

const { MODEL_DOWNLOAD_URLS, isAllowedModelDownloadUrl } = require('../electron/model-downloads.cjs');

test('IndexTTS download points to the official 2.5 model', () => {
  assert.equal(MODEL_DOWNLOAD_URLS.index, 'https://huggingface.co/IndexTeam/IndexTTS-2.5');
  assert.equal(isAllowedModelDownloadUrl(MODEL_DOWNLOAD_URLS.index), true);
  assert.equal(isAllowedModelDownloadUrl('https://huggingface.co/IndexTeam/IndexTTS-2'), false);
});

test('only known model download links are accepted', () => {
  assert.equal(isAllowedModelDownloadUrl(MODEL_DOWNLOAD_URLS.qwen), true);
  assert.equal(isAllowedModelDownloadUrl('https://example.com/model'), false);
});
