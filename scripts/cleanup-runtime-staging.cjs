const fs = require('node:fs');
const path = require('node:path');

const studioRoot = path.resolve(__dirname, '..');
const releaseRoot = path.join(studioRoot, 'dist', 'voice-studio-runtime', '0.1.0-alpha.3');
const stagingRoot = path.join(releaseRoot, 'staging');
const resolved = path.resolve(stagingRoot);
if (!resolved.startsWith(`${path.resolve(releaseRoot)}${path.sep}`) || path.basename(resolved) !== 'staging') {
  throw new Error(`Refusing to remove unsafe path: ${resolved}`);
}
function sizeOf(root) {
  if (!fs.existsSync(root)) return 0;
  return fs.readdirSync(root, { withFileTypes: true }).reduce((total, entry) => {
    const candidate = path.join(root, entry.name);
    return total + (entry.isDirectory() ? sizeOf(candidate) : fs.statSync(candidate).size);
  }, 0);
}
const bytes = sizeOf(resolved);
fs.rmSync(resolved, { recursive: true, force: true });
console.log(JSON.stringify({ removed: resolved, freedBytes: bytes, rebuildable: true }));
