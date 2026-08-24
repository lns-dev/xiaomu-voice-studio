const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const studioRoot = path.resolve(__dirname, '..');
const version = '0.1.0-alpha.3';
const releaseRoot = path.join(studioRoot, 'dist', 'voice-studio-runtime', version);
const stagingRoot = path.join(releaseRoot, 'staging');
const bundleRoot = path.join(releaseRoot, 'bundles');
const development = JSON.parse(fs.readFileSync(path.join(studioRoot, 'dev-locations.json'), 'utf8'));
const indexEnvironment = path.resolve(development.indexPython, '..', '..');
const qwenEnvironment = path.resolve(development.qwenPython, '..', '..');
const basePython = path.resolve(indexEnvironment, '..', '..', '..', 'runtimes', 'python', '3.11.9-x64');
const sevenZip = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', '7zip@1.0.0', '7zip-win-x64-a34pt', 'bin', '7za.exe');

function assertUnderRelease(candidate) {
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(`${path.resolve(releaseRoot)}${path.sep}`)) throw new Error(`Unsafe release path: ${resolved}`);
  return resolved;
}

function resetDirectory(candidate) {
  const resolved = assertUnderRelease(candidate);
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

function copy(source, target, filter = () => true) {
  if (!fs.existsSync(source)) throw new Error(`Missing source: ${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true, filter });
}

function remove(candidate) {
  const resolved = assertUnderRelease(candidate);
  fs.rmSync(resolved, { recursive: true, force: true });
}

function packageName(relative) {
  return relative.split(path.sep)[0].toLowerCase();
}

function isPythonCache(source) {
  const normalized = source.toLowerCase();
  return normalized.includes(`${path.sep}__pycache__${path.sep}`) || normalized.endsWith(`${path.sep}__pycache__`) || normalized.endsWith('.pyc') || normalized.endsWith('.pyo');
}

function copySitePackages(sourceRoot, targetRoot, excludedNames) {
  const excluded = new Set(excludedNames.map((name) => name.toLowerCase()));
  copy(sourceRoot, targetRoot, (source) => {
    if (source === sourceRoot) return true;
    const relative = path.relative(sourceRoot, source);
    if (excluded.has(packageName(relative))) return false;
    return !isPythonCache(source);
  });
}

function removeStaticDevelopmentFiles(root) {
  for (const candidate of [
    path.join(root, 'include'), path.join(root, 'libs'), path.join(root, 'Tools'),
    path.join(root, 'Lib', 'test'), path.join(root, 'Lib', 'ensurepip'),
    path.join(root, 'Lib', 'site-packages', 'torch', 'include'),
    path.join(root, 'Lib', 'site-packages', 'torch', 'share')
  ]) remove(candidate);
  const torchLib = path.join(root, 'Lib', 'site-packages', 'torch', 'lib');
  if (fs.existsSync(torchLib)) {
    for (const entry of fs.readdirSync(torchLib)) {
      if (/\.(?:lib|exp)$/i.test(entry)) remove(path.join(torchLib, entry));
    }
  }
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function sizeOf(root) {
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    total += entry.isDirectory() ? sizeOf(candidate) : fs.statSync(candidate).size;
  }
  return total;
}

function archive(component) {
  const source = path.join(stagingRoot, component);
  const destination = path.join(bundleRoot, `${component}-${version}-win-x64.7z`);
  for (const existing of fs.readdirSync(bundleRoot).filter((name) => name.startsWith(path.basename(destination)))) remove(path.join(bundleRoot, existing));
  execFileSync(sevenZip, ['a', '-t7z', '-mx=5', '-mmt=on', '-v1900m', destination, '.'], { cwd: source, stdio: 'inherit', windowsHide: true });
  return fs.readdirSync(bundleRoot).filter((name) => name.startsWith(path.basename(destination))).sort().map((name) => {
    const file = path.join(bundleRoot, name);
    return { name, bytes: fs.statSync(file).size, sha256: sha256(file) };
  });
}

if (!fs.existsSync(sevenZip)) throw new Error(`7-Zip build tool not found: ${sevenZip}`);
resetDirectory(stagingRoot);
resetDirectory(bundleRoot);

console.log('Staging shared Python and PyTorch runtime...');
const coreRoot = path.join(stagingRoot, 'core');
copy(basePython, coreRoot, (source) => !isPythonCache(source));
const indexSite = path.join(indexEnvironment, 'Lib', 'site-packages');
const coreSite = path.join(coreRoot, 'Lib', 'site-packages');
fs.mkdirSync(coreSite, { recursive: true });
const coreNames = [
  'torch', 'torch-2.8.0+cu128.dist-info', 'torchgen', 'functorch',
  'torchaudio', 'torchaudio-2.8.0+cu128.dist-info', 'torio',
  'filelock', 'filelock-3.18.0.dist-info', 'typing_extensions.py', 'typing_extensions-4.14.0.dist-info',
  'sympy', 'sympy-1.14.0.dist-info', 'mpmath', 'mpmath-1.3.0.dist-info',
  'networkx', 'networkx-3.5.dist-info', 'jinja2', 'jinja2-3.1.6.dist-info',
  'markupsafe', 'markupsafe-3.0.2.dist-info', 'fsspec', 'fsspec-2025.5.1.dist-info'
];
for (const name of coreNames) {
  const source = path.join(indexSite, name);
  if (fs.existsSync(source)) copy(source, path.join(coreSite, name), (candidate) => !isPythonCache(candidate));
}
removeStaticDevelopmentFiles(coreRoot);
fs.writeFileSync(path.join(coreRoot, 'XIAOMU_RUNTIME.json'), JSON.stringify({ version, python: '3.11.9', torch: '2.8.0+cu128', torchaudio: '2.8.0+cu128' }, null, 2));

const sharedExclusions = coreNames.concat(['pip', 'pip-25.1.1.dist-info', 'setuptools', 'setuptools-80.9.0.dist-info']);

console.log('Staging IndexTTS dependency layer...');
const indexRoot = path.join(stagingRoot, 'indextts25');
const indexLayer = path.join(indexRoot, 'engines', 'IndexTTS-2.5');
copySitePackages(indexSite, path.join(indexLayer, 'site-packages'), sharedExclusions);
for (const name of ['indextts', 'assets', 'backends', 'tools']) {
  const source = path.join(development.indexRepo, name);
  if (fs.existsSync(source)) copy(source, path.join(indexLayer, name), (candidate) => !isPythonCache(candidate));
}
for (const name of ['pyproject.toml', 'LICENSE', 'LICENSE_ZH.txt', 'DISCLAIMER']) {
  const source = path.join(development.indexRepo, name);
  if (fs.existsSync(source)) copy(source, path.join(indexLayer, name));
}

console.log('Staging Qwen3-TTS dependency layer...');
const qwenRoot = path.join(stagingRoot, 'qwen3-tts-voicedesign');
const qwenSite = path.join(qwenEnvironment, 'Lib', 'site-packages');
copySitePackages(qwenSite, path.join(qwenRoot, 'engines', 'Qwen3-TTS-VoiceDesign', 'site-packages'), sharedExclusions);

console.log('Staging FFmpeg tools...');
const ffmpegRoot = path.join(stagingRoot, 'ffmpeg', 'tools', 'ffmpeg', 'bin');
for (const name of ['ffmpeg.exe', 'ffprobe.exe']) copy(path.join(development.ffmpegRoot, name), path.join(ffmpegRoot, name));

const components = {};
for (const component of ['core', 'indextts25', 'qwen3-tts-voicedesign', 'ffmpeg']) {
  console.log(`Compressing ${component}...`);
  components[component] = { unpackedBytes: sizeOf(path.join(stagingRoot, component)), files: archive(component) };
}
const manifest = { schemaVersion: 1, version, architecture: 'win-x64', createdAt: new Date().toISOString(), components };
fs.writeFileSync(path.join(releaseRoot, 'runtime-assets.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(studioRoot, 'release', 'runtime-assets.json'), JSON.stringify({ ...manifest, downloadBaseUrl: null }, null, 2));
console.log(`Runtime bundles created at ${bundleRoot}`);
