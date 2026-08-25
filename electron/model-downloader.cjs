const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const HUB_BASES = Object.freeze(['https://huggingface.co', 'https://hf-mirror.com']);

const MODEL_DOWNLOAD_DEFINITIONS = Object.freeze({
  qwen: Object.freeze({
    label: 'Qwen3-TTS 1.7B VoiceDesign',
    repositories: Object.freeze([
      Object.freeze({ repoId: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', localRoot: '', files: null })
    ])
  }),
  index: Object.freeze({
    label: 'IndexTTS 2.5（含辅助模型）',
    repositories: Object.freeze([
      Object.freeze({ repoId: 'IndexTeam/IndexTTS-2.5', localRoot: '', files: null }),
      Object.freeze({ repoId: 'facebook/w2v-bert-2.0', localRoot: 'hf_cache/w2v-bert-2.0', files: null }),
      Object.freeze({ repoId: 'amphion/MaskGCT', files: Object.freeze({ 'semantic_codec/model.safetensors': 'hf_cache/semantic_codec_model.safetensors' }) }),
      Object.freeze({ repoId: 'funasr/campplus', files: Object.freeze({ 'campplus_cn_common.bin': 'hf_cache/campplus_cn_common.bin' }) }),
      Object.freeze({ repoId: 'nvidia/bigvgan_v2_22khz_80band_256x', files: Object.freeze({
        'config.json': 'hf_cache/bigvgan/config.json',
        'bigvgan_generator.pt': 'hf_cache/bigvgan/bigvgan_generator.pt'
      }) })
    ])
  })
});

function normalizeRelativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`模型清单包含无效路径：${value}`);
  }
  return normalized;
}

function safeTarget(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...normalizeRelativePath(relativePath).split('/'));
  if (target === resolvedRoot || !target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('模型文件目标超出模型目录');
  return target;
}

function resolveUrl(base, repoId, revision, remotePath) {
  const encodedPath = normalizeRelativePath(remotePath).split('/').map(encodeURIComponent).join('/');
  return `${base}/${repoId}/resolve/${encodeURIComponent(revision || 'main')}/${encodedPath}?download=true`;
}

async function fetchRepoMetadata(repoId, fetchImpl, signal) {
  let lastError;
  for (const base of HUB_BASES) {
    try {
      const response = await fetchImpl(`${base}/api/models/${repoId}?blobs=true`, { signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const metadata = await response.json();
      if (!Array.isArray(metadata.siblings) || !metadata.siblings.length) throw new Error('模型仓库未返回文件清单');
      return { base, revision: metadata.sha || 'main', siblings: metadata.siblings };
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw new Error(`无法读取 ${repoId} 的文件清单：${lastError?.message || '网络不可用'}`);
}

function selectRepositoryFiles(repository, metadata) {
  const selected = [];
  const mapping = repository.files;
  for (const sibling of metadata.siblings) {
    const remotePath = normalizeRelativePath(sibling.rfilename);
    if (mapping && !Object.hasOwn(mapping, remotePath)) continue;
    const relativePath = mapping
      ? mapping[remotePath]
      : [repository.localRoot, remotePath].filter(Boolean).join('/');
    const size = Number(sibling.size ?? sibling.lfs?.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${repository.repoId}/${remotePath} 缺少可信文件大小`);
    selected.push({
      repoId: repository.repoId,
      revision: metadata.revision,
      remotePath,
      relativePath: normalizeRelativePath(relativePath),
      size,
      sha256: typeof sibling.lfs?.sha256 === 'string' ? sibling.lfs.sha256.toLowerCase() : null,
      preferredBase: metadata.base
    });
  }
  if (mapping) {
    const found = new Set(selected.map((file) => file.remotePath));
    const missing = Object.keys(mapping).filter((file) => !found.has(file));
    if (missing.length) throw new Error(`${repository.repoId} 缺少官方必需文件：${missing.join(', ')}`);
  }
  return selected;
}

function existingBytesFor(file, targetRoot) {
  const target = safeTarget(targetRoot, file.relativePath);
  try { if (fs.statSync(target).size === file.size) return file.size; } catch { /* not complete */ }
  try { return Math.min(file.size, fs.statSync(`${target}.part`).size); } catch { return 0; }
}

async function prepareModelDownload(engine, targetRoot, options = {}) {
  const definition = MODEL_DOWNLOAD_DEFINITIONS[engine];
  if (!definition) throw new Error('未知模型类型');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络下载');
  await fsp.mkdir(targetRoot, { recursive: true });
  const files = [];
  for (const repository of definition.repositories) {
    options.onProgress?.({ engine, stage: 'planning', percent: 0, message: `正在读取 ${repository.repoId} 文件清单` });
    const metadata = await fetchRepoMetadata(repository.repoId, fetchImpl, options.signal);
    files.push(...selectRepositoryFiles(repository, metadata));
  }
  const uniqueTargets = new Set();
  for (const file of files) {
    const key = file.relativePath.toLowerCase();
    if (uniqueTargets.has(key)) throw new Error(`模型清单目标冲突：${file.relativePath}`);
    uniqueTargets.add(key);
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const existing = files.reduce((sum, file) => sum + existingBytesFor(file, targetRoot), 0);
  const required = Math.max(0, total - existing);
  if (typeof fs.statfsSync === 'function') {
    const disk = fs.statfsSync(targetRoot);
    const free = Number(disk.bavail) * Number(disk.bsize);
    const reserve = 512 * 1024 * 1024;
    if (free < required + reserve) {
      throw new Error(`模型需要继续下载约 ${formatBytes(required)}，目标磁盘仅剩 ${formatBytes(free)}，请释放空间后重试`);
    }
  }
  return { engine, label: definition.label, targetRoot: path.resolve(targetRoot), files, total, existing, required };
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 1024 ? 0 : 1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

async function sha256File(filePath, signal) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    if (signal?.aborted) { stream.destroy(); throw signal.reason || new Error('下载已取消'); }
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function delay(milliseconds, signal) {
  if (!milliseconds) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new Error('下载已取消')); }, { once: true });
  });
}

async function downloadFile(file, targetRoot, options) {
  const target = safeTarget(targetRoot, file.relativePath);
  const partial = `${target}.part`;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    if (fs.statSync(target).size === file.size) {
      if (!file.sha256 || await sha256File(target, options.signal) === file.sha256) return { bytes: file.size, reused: true };
    }
  } catch { /* download or repair below */ }

  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      let offset = 0;
      try { offset = Math.min(file.size, fs.statSync(partial).size); } catch { /* no partial */ }
      if (offset === file.size) {
        const valid = !file.sha256 || await sha256File(partial, options.signal) === file.sha256;
        if (valid) {
          await fsp.rm(target, { force: true });
          await fsp.rename(partial, target);
          return { bytes: file.size, reused: false };
        }
        await fsp.rm(partial, { force: true });
        offset = 0;
      }
      const bases = [file.preferredBase, ...HUB_BASES.filter((base) => base !== file.preferredBase)];
      const base = bases[attempt % bases.length];
      const headers = { 'Accept-Encoding': 'identity' };
      if (offset > 0) headers.Range = `bytes=${offset}-`;
      const response = await options.fetchImpl(resolveUrl(base, file.repoId, file.revision, file.remotePath), { signal: options.signal, headers, redirect: 'follow' });
      if (!(response.ok || response.status === 206)) throw new Error(`HTTP ${response.status}`);
      const append = offset > 0 && response.status === 206;
      if (!append) offset = 0;
      const handle = await fsp.open(partial, append ? 'a' : 'w');
      try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (options.signal?.aborted) throw options.signal.reason || new Error('下载已取消');
          await handle.write(value);
          offset += value.byteLength;
          options.onChunk?.(value.byteLength, file, offset);
        }
      } finally { await handle.close(); }
      const actualSize = fs.statSync(partial).size;
      if (actualSize !== file.size) throw new Error(`文件大小不完整：${actualSize}/${file.size}`);
      if (file.sha256) {
        options.onVerify?.(file);
        const actualHash = await sha256File(partial, options.signal);
        if (actualHash !== file.sha256) throw new Error('SHA256 校验失败');
      }
      await fsp.rm(target, { force: true });
      await fsp.rename(partial, target);
      return { bytes: file.size, reused: false };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error;
      await delay((attempt + 1) * 750, options.signal);
    }
  }
  throw new Error(`下载 ${file.repoId}/${file.remotePath} 失败：${lastError?.message || '未知错误'}`);
}

async function downloadPreparedModel(prepared, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const signal = options.signal;
  let completedBytes = 0;
  let lastReportAt = 0;
  const report = (event, force = false) => {
    const now = Date.now();
    if (!force && now - lastReportAt < 160) return;
    lastReportAt = now;
    const received = Math.min(prepared.total, Math.max(0, event.received ?? completedBytes));
    options.onProgress?.({
      engine: prepared.engine,
      total: prepared.total,
      received,
      percent: prepared.total ? Math.min(100, Math.floor((received / prepared.total) * 100)) : 100,
      ...event
    });
  };
  for (let index = 0; index < prepared.files.length; index += 1) {
    const file = prepared.files[index];
    let fileProgress = 0;
    report({ stage: 'downloading', file: file.relativePath, fileIndex: index + 1, fileCount: prepared.files.length, received: completedBytes, message: `正在下载 ${file.relativePath}` }, true);
    const result = await downloadFile(file, prepared.targetRoot, {
      fetchImpl,
      signal,
      onChunk: (bytes, currentFile, offset) => {
        fileProgress += bytes;
        report({ stage: 'downloading', file: currentFile.relativePath, fileIndex: index + 1, fileCount: prepared.files.length, received: completedBytes + Math.min(offset, currentFile.size), message: `正在下载 ${currentFile.relativePath}` });
      },
      onVerify: (currentFile) => report({ stage: 'verifying', file: currentFile.relativePath, fileIndex: index + 1, fileCount: prepared.files.length, received: completedBytes + currentFile.size, message: `正在校验 ${currentFile.relativePath}` }, true)
    });
    completedBytes += result.bytes;
    if (result.reused || fileProgress === 0) report({ stage: 'downloading', file: file.relativePath, fileIndex: index + 1, fileCount: prepared.files.length, received: completedBytes, message: `已确认 ${file.relativePath}` }, true);
  }
  const manifest = {
    schemaVersion: 1,
    engine: prepared.engine,
    completedAt: new Date().toISOString(),
    totalBytes: prepared.total,
    files: prepared.files.map(({ repoId, revision, remotePath, relativePath, size, sha256 }) => ({ repoId, revision, remotePath, relativePath, size, sha256 }))
  };
  await fsp.writeFile(path.join(prepared.targetRoot, '.xiaomu-model-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  report({ stage: 'completed', received: prepared.total, percent: 100, message: `${prepared.label} 下载并校验完成` }, true);
  return { targetRoot: prepared.targetRoot, total: prepared.total, fileCount: prepared.files.length };
}

module.exports = {
  MODEL_DOWNLOAD_DEFINITIONS,
  downloadPreparedModel,
  formatBytes,
  normalizeRelativePath,
  prepareModelDownload,
  safeTarget,
  selectRepositoryFiles
};
