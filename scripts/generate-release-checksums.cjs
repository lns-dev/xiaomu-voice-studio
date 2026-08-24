const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const studioRoot = path.resolve(__dirname, '..');
const releaseRoot = path.join(studioRoot, 'dist', 'voice-studio-release');
const runtimeRoot = path.join(studioRoot, 'dist', 'voice-studio-runtime', '0.1.0-alpha.3');
const outputs = [
  path.join(releaseRoot, 'XiaoMuVoiceStudio-0.1.0-alpha.3-win-x64-Setup.exe'),
  ...fs.readdirSync(path.join(runtimeRoot, 'bundles')).sort().map((name) => path.join(runtimeRoot, 'bundles', name)),
  path.join(runtimeRoot, 'runtime-assets.json')
];
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
  fs.writeFileSync(path.join(runtimeRoot, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8');
  console.log(lines.join('\n'));
})().catch((error) => { console.error(error); process.exitCode = 1; });
