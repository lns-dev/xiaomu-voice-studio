const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

function readManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest?.schemaVersion !== 1 || !manifest?.components) throw new Error('运行时资源清单无效');
  return manifest;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function run(executable, args, timeout = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`运行时解压失败：${String(stderr || error.message).trim().slice(-500)}`));
      resolve(stdout);
    });
  });
}

function safeRemove(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`拒绝清理非运行时目录：${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function verifyComponentFiles(component, bundleDirectory, onProgress) {
  const files = Array.isArray(component?.files) ? component.files : [];
  if (!files.length) throw new Error('运行时资源清单缺少文件');
  const verified = [];
  for (const item of files) {
    const candidate = path.join(bundleDirectory, path.basename(item.name));
    if (!fs.existsSync(candidate)) throw new Error(`缺少运行时资源：${item.name}`);
    const stat = fs.statSync(candidate);
    if (Number(item.bytes) !== stat.size) throw new Error(`运行时资源大小不匹配：${item.name}`);
    onProgress?.({ stage: 'verifying', message: `正在校验 ${item.name}` });
    const actual = await hashFile(candidate);
    if (actual.toLowerCase() !== String(item.sha256).toLowerCase()) throw new Error(`运行时资源校验失败：${item.name}`);
    verified.push(candidate);
  }
  return verified;
}

function downloadFile(url, target, onProgress, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('运行时下载重定向次数过多'));
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') return Promise.reject(new Error('运行时下载地址必须使用 HTTPS'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.part`;
  fs.rmSync(temporary, { force: true });
  return new Promise((resolve, reject) => {
    const request = https.get(parsed, { headers: { 'User-Agent': 'XiaoMuVoiceStudio/0.1' } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return resolve(downloadFile(new URL(response.headers.location, parsed).href, target, onProgress, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`运行时下载失败：HTTP ${response.statusCode}`));
      }
      const total = Number(response.headers['content-length']) || null;
      let received = 0;
      const output = fs.createWriteStream(temporary, { flags: 'wx' });
      response.on('data', (chunk) => {
        received += chunk.length;
        onProgress?.({ received, total });
      });
      response.once('error', reject);
      output.once('error', reject);
      output.once('finish', () => {
        output.close(() => {
          fs.renameSync(temporary, target);
          resolve(target);
        });
      });
      response.pipe(output);
    });
    request.setTimeout(120000, () => request.destroy(new Error('运行时下载连接超时')));
    request.once('error', (error) => {
      fs.rmSync(temporary, { force: true });
      reject(error);
    });
  });
}

async function downloadRuntimeBundles(manifest, targetDirectory, onProgress) {
  const base = String(manifest?.downloadBaseUrl || '').trim();
  if (!base) throw new Error('尚未配置运行时下载地址');
  if (!base.startsWith('https://')) throw new Error('运行时下载地址必须使用 HTTPS');
  const files = Object.values(manifest.components).flatMap((component) => component.files || []);
  const totalBytes = files.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
  let completedBytes = 0;
  for (const item of files) {
    const target = path.join(targetDirectory, path.basename(item.name));
    if (fs.existsSync(target) && fs.statSync(target).size === Number(item.bytes)) {
      completedBytes += Number(item.bytes);
      continue;
    }
    await downloadFile(`${base.replace(/\/$/, '')}/${encodeURIComponent(path.basename(item.name))}`, target, ({ received, total }) => {
      const known = total || Number(item.bytes) || 0;
      const percent = totalBytes ? Math.min(35, Math.round(((completedBytes + Math.min(received, known)) / totalBytes) * 35)) : null;
      onProgress?.({ stage: 'downloading', percent, message: `正在下载 ${item.name}` });
    });
    completedBytes += Number(item.bytes || 0);
  }
  return targetDirectory;
}

async function installRuntimeBundles(options) {
  const { manifestPath, bundleDirectory, extractorPath, dataRoot, onProgress } = options;
  const manifest = readManifest(manifestPath);
  if (!fs.existsSync(extractorPath)) throw new Error('运行时解压工具缺失，请重新安装软件');
  const componentOrder = ['core', 'indextts25', 'qwen3-tts-voicedesign', 'ffmpeg'];
  const verified = {};
  let progress = 4;
  for (const componentId of componentOrder) {
    const component = manifest.components[componentId];
    if (!component) throw new Error(`运行时资源清单缺少 ${componentId}`);
    verified[componentId] = await verifyComponentFiles(component, bundleDirectory, onProgress);
    progress += 8;
    onProgress?.({ stage: 'verifying', percent: progress, message: `${componentId} 校验通过` });
  }

  const temporaryRoot = path.join(dataRoot, `.runtime-install-${Date.now()}-${process.pid}`);
  safeRemove(dataRoot, temporaryRoot);
  fs.mkdirSync(temporaryRoot, { recursive: true });
  try {
    for (const [index, componentId] of componentOrder.entries()) {
      const output = componentId === 'core' ? path.join(temporaryRoot, 'runtime', 'core') : temporaryRoot;
      fs.mkdirSync(output, { recursive: true });
      onProgress?.({ stage: 'extracting', percent: 38 + index * 12, message: `正在安装 ${componentId}` });
      await run(extractorPath, ['x', '-y', `-o${output}`, verified[componentId][0]]);
    }
    const required = [
      path.join(temporaryRoot, 'runtime', 'core', 'python.exe'),
      path.join(temporaryRoot, 'runtime', 'core', 'Lib', 'site-packages', 'torch', '__init__.py'),
      path.join(temporaryRoot, 'engines', 'IndexTTS-2.5', 'indextts'),
      path.join(temporaryRoot, 'engines', 'Qwen3-TTS-VoiceDesign', 'site-packages', 'qwen_tts'),
      path.join(temporaryRoot, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(temporaryRoot, 'tools', 'ffmpeg', 'bin', 'ffprobe.exe')
    ];
    const missing = required.find((candidate) => !fs.existsSync(candidate));
    if (missing) throw new Error(`运行时安装内容不完整：${path.relative(temporaryRoot, missing)}`);

    const targets = [
      ['runtime/core', 'runtime/core'],
      ['engines/IndexTTS-2.5', 'engines/IndexTTS-2.5'],
      ['engines/Qwen3-TTS-VoiceDesign', 'engines/Qwen3-TTS-VoiceDesign'],
      ['tools/ffmpeg', 'tools/ffmpeg']
    ];
    const installed = [];
    try {
      for (const [sourceRelative, targetRelative] of targets) {
        const source = path.join(temporaryRoot, sourceRelative);
        const target = path.join(dataRoot, targetRelative);
        const backup = `${target}.previous`;
        safeRemove(dataRoot, backup);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (fs.existsSync(target)) fs.renameSync(target, backup);
        fs.renameSync(source, target);
        installed.push({ target, backup });
      }
    } catch (error) {
      for (const { target, backup } of installed.reverse()) {
        safeRemove(dataRoot, target);
        if (fs.existsSync(backup)) fs.renameSync(backup, target);
      }
      throw error;
    }
    for (const { backup } of installed) safeRemove(dataRoot, backup);
    onProgress?.({ stage: 'completed', percent: 100, message: '公共运行环境安装完成' });
    return { version: manifest.version, python: path.join(dataRoot, 'runtime', 'core', 'python.exe') };
  } finally {
    safeRemove(dataRoot, temporaryRoot);
  }
}

module.exports = { downloadFile, downloadRuntimeBundles, hashFile, installRuntimeBundles, readManifest, verifyComponentFiles };
