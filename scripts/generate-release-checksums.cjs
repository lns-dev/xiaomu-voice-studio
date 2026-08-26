const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const studioRoot = path.resolve(__dirname, '..');
const releaseRoot = path.join(studioRoot, 'dist', 'voice-studio-release');
const packageMetadata = JSON.parse(fs.readFileSync(path.join(studioRoot, 'package.json'), 'utf8'));
const runtimeManifest = JSON.parse(fs.readFileSync(path.join(studioRoot, 'release', 'runtime-manifest.json'), 'utf8'));
const runtimeRoot = path.join(studioRoot, 'dist', 'voice-studio-runtime', runtimeManifest.runtimeVersion);
const releaseStagingRoot = path.join(studioRoot, 'dist', 'release-staging', `v${packageMetadata.version}`);
const outputs = [
  path.join(releaseRoot, `XiaoMuVoiceStudio-${packageMetadata.version}-win-x64-Setup.exe`)
];
const builtRuntimeBundleRoot = path.join(runtimeRoot, 'bundles');
const runtimeBundleRoot = fs.existsSync(builtRuntimeBundleRoot) ? builtRuntimeBundleRoot : releaseStagingRoot;
if (fs.existsSync(runtimeBundleRoot)) {
  outputs.push(...fs.readdirSync(runtimeBundleRoot)
    .filter((name) => /\.7z\.\d+$/i.test(name))
    .sort()
    .map((name) => path.join(runtimeBundleRoot, name)));
}
const runtimeAssets = path.join(runtimeRoot, 'runtime-assets.json');
outputs.push(fs.existsSync(runtimeAssets) ? runtimeAssets : path.join(studioRoot, 'release', 'runtime-assets.json'));
async function digest(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}
(async () => {
  const lines = [];
  for (const file of outputs) lines.push(`${await digest(file)}  ${path.basename(file)}`);
  fs.writeFileSync(path.join(releaseRoot, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8');
  console.log(lines.join('\n'));
})().catch((error) => { console.error(error); process.exitCode = 1; });
