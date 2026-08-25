const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const expectedSha256 = '223b873c50380fe9a39f1a22b6abf8d46db506e1c08d08312902f6f3cd1f7ac3';
const executable = path.resolve(__dirname, '..', 'release', 'tools', '7za.exe');

if (!fs.existsSync(executable)) throw new Error(`缺少发布解压工具：${executable}`);
const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
if (actualSha256 !== expectedSha256) throw new Error(`发布解压工具校验失败：${actualSha256}`);

const identity = execFileSync(executable, ['i'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
if (!/7-Zip/i.test(identity)) throw new Error('发布解压工具身份检查失败：不是 7-Zip');

console.log(`7-Zip 发布工具校验通过：${actualSha256}`);
