const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { installRuntimeBundles } = require('../electron/runtime-installer.cjs');

const studioRoot = path.resolve(__dirname, '..');
const validationRoot = path.join(studioRoot, 'dist', 'runtime-install-validation');
const allowedRoot = path.join(studioRoot, 'dist');
if (!validationRoot.startsWith(`${allowedRoot}${path.sep}`)) throw new Error('Unsafe validation root');
fs.rmSync(validationRoot, { recursive: true, force: true });
fs.mkdirSync(validationRoot, { recursive: true });

const version = '0.1.0-alpha.3';
const bundleRoot = path.join(studioRoot, 'dist', 'voice-studio-runtime', version, 'bundles');
const manifestPath = path.join(studioRoot, 'dist', 'voice-studio-runtime', version, 'runtime-assets.json');
const extractorPath = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', '7zip@1.0.0', '7zip-win-x64-a34pt', 'bin', '7za.exe');

(async () => {
  try {
    const installed = await installRuntimeBundles({
      manifestPath,
      bundleDirectory: bundleRoot,
      extractorPath,
      dataRoot: validationRoot,
      onProgress: (event) => console.log(`${event.percent ?? '--'}% ${event.message}`)
    });
    const core = path.join(validationRoot, 'runtime', 'core');
    const index = path.join(validationRoot, 'engines', 'IndexTTS-2.5');
    const qwen = path.join(validationRoot, 'engines', 'Qwen3-TTS-VoiceDesign');
    const environment = {
      ...process.env,
      PYTHONNOUSERSITE: '1',
      PATH: [core, path.join(core, 'Lib', 'site-packages', 'torch', 'lib'), process.env.PATH].join(path.delimiter)
    };
    environment.PYTHONPATH = [path.join(index, 'site-packages'), index].join(path.delimiter);
    execFileSync(installed.python, ['-c', 'import torch,torchaudio; from indextts.infer_v2 import IndexTTS2; assert torch.cuda.is_available(); print("IndexTTS runtime OK")'], { env: environment, stdio: 'inherit', windowsHide: true });
    environment.PYTHONPATH = path.join(qwen, 'site-packages');
    execFileSync(installed.python, ['-c', 'import torch,torchaudio,qwen_tts; assert torch.cuda.is_available(); print("Qwen runtime OK")'], { env: environment, stdio: 'inherit', windowsHide: true });
    console.log('Runtime installation validation passed.');
  } finally {
    fs.rmSync(validationRoot, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
