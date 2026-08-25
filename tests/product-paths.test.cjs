const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createProductPaths } = require('../electron/product-paths.cjs');

test('packaged model and output paths follow the selected installation directory', () => {
  const paths = createProductPaths({
    isPackaged: true,
    softwareRoot: 'G:/Program Files/XiaoMuVoiceStudio',
    developmentRoot: 'C:/source/voice-studio'
  });
  assert.equal(paths.productDataRoot, path.resolve('G:/Program Files/XiaoMuVoiceStudio'));
  assert.equal(paths.modelRoot, path.resolve('G:/Program Files/XiaoMuVoiceStudio/models'));
  assert.equal(paths.artifactRoot, path.resolve('G:/Program Files/XiaoMuVoiceStudio/outputs'));
});

test('development paths remain inside the source workspace', () => {
  const paths = createProductPaths({
    isPackaged: false,
    softwareRoot: 'G:/Program Files/XiaoMuVoiceStudio',
    developmentRoot: 'C:/source/voice-studio'
  });
  assert.equal(paths.productDataRoot, path.resolve('C:/source/voice-studio'));
});
