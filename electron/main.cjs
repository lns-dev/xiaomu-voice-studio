const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } = require('electron');
const { execFile, spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');
const { validateCloneRequest, validateDesignRequest } = require('./contract.cjs');
const { analyzeAudio, createReferenceCopy, configureAudioTools, resolveTool } = require('./audio-tools.cjs');
const { discoverModels, findModelDirectory, isModelDirectory, uniqueDirectories } = require('./model-locations.cjs');
const { createProductPaths } = require('./product-paths.cjs');
const { createRuntimeLocations } = require('./runtime-locations.cjs');
const { downloadRuntimeBundles, installRuntimeBundles, readManifest, removeDownloadedBundles } = require('./runtime-installer.cjs');
const { detectBuildChannel } = require('./build-channel.cjs');
const { MODEL_DOWNLOAD_URLS, isAllowedModelDownloadUrl } = require('./model-downloads.cjs');
const { downloadPreparedModel, formatBytes: formatDownloadBytes, prepareModelDownload } = require('./model-downloader.cjs');

if (process.argv.includes('--smoke') && process.env.XIAOMU_SMOKE_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.XIAOMU_SMOKE_USER_DATA));
}
const chromiumSessionRoot = path.join(app.getPath('userData'), 'chromium-session-v2');
fs.mkdirSync(chromiumSessionRoot, { recursive: true });
app.setPath('sessionData', chromiumSessionRoot);

const studioRoot = path.resolve(__dirname, '..');
function loadDevelopmentLocations() {
  if (app.isPackaged) return {};
  try { return JSON.parse(fs.readFileSync(path.join(studioRoot, 'dev-locations.json'), 'utf8')); }
  catch { return {}; }
}
const developmentLocations = loadDevelopmentLocations();
const rendererRoot = path.join(studioRoot, 'src');
const unpackedPythonRoot = path.join(process.resourcesPath, 'app.asar.unpacked', 'python');
const pythonRoot = app.isPackaged && fs.existsSync(unpackedPythonRoot)
  ? unpackedPythonRoot
  : path.join(studioRoot, 'python');
const softwareRoot = app.isPackaged ? path.dirname(process.execPath) : studioRoot;
// User-facing assets belong beside the installed application. This keeps
// models, generated audio and the managed runtime together when a custom
// installation directory is selected.
const { productDataRoot, artifactRoot, modelRoot } = createProductPaths({
  isPackaged: app.isPackaged,
  softwareRoot,
  developmentRoot: studioRoot
});
const legacyArtifactRoot = developmentLocations.legacyArtifactRoot;
const legacyModelRoot = developmentLocations.legacyModelRoot;
const managedArtifactRoots = uniqueDirectories([artifactRoot, ...(!app.isPackaged ? [legacyArtifactRoot] : [])]);
fs.mkdirSync(artifactRoot, { recursive: true });
fs.mkdirSync(modelRoot, { recursive: true });
const runtimeLocations = createRuntimeLocations({
  isPackaged: app.isPackaged,
  programRoot: softwareRoot,
  dataRoot: productDataRoot,
  userDataRoot: app.getPath('userData'),
  developmentCandidates: [
    developmentLocations.indexPython,
    developmentLocations.qwenPython
  ]
});
const packagedIndexRepo = path.join(runtimeLocations.engineRoot, 'IndexTTS-2.5');
const indexRepo = exists(packagedIndexRepo) ? packagedIndexRepo : (!app.isPackaged && developmentLocations.indexRepo ? developmentLocations.indexRepo : packagedIndexRepo);
const indexConfig = {
  python: app.isPackaged ? runtimeLocations.selectedPython() : (developmentLocations.indexPython || runtimeLocations.selectedPython()),
  repo: indexRepo,
  model: path.join(modelRoot, 'IndexTTS-2.5'),
  dependencyRoot: path.join(runtimeLocations.engineRoot, 'IndexTTS-2.5', 'site-packages'),
  script: path.join(pythonRoot, 'indextts_worker.py')
};
const qwenConfig = {
  python: app.isPackaged ? runtimeLocations.selectedPython() : (developmentLocations.qwenPython || runtimeLocations.selectedPython()),
  model: path.join(modelRoot, 'Qwen3-TTS-12Hz-1.7B-VoiceDesign'),
  dependencyRoot: path.join(runtimeLocations.engineRoot, 'Qwen3-TTS-VoiceDesign', 'site-packages'),
  script: path.join(pythonRoot, 'qwen_voice_design_worker.py')
};
configureAudioTools([
  path.join(runtimeLocations.toolRoot, 'ffmpeg', 'bin'),
  path.join(runtimeLocations.toolRoot, 'ffmpeg'),
  ...(!app.isPackaged ? [developmentLocations.ffmpegRoot] : [])
]);

let mainWindow;
let activeWorker = null;
let activeJob = null;
let activeModelDownload = null;
let runtimeInstallActive = false;
let storageWatcher = null;
let storageBroadcastTimer = null;
const approvedReferences = new Set();
const approvedOutputs = new Set();
const referenceAnalysisCache = new Map();
const workers = new Map();
const taskkillPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
const workerTaskTimeoutMs = 30 * 60 * 1000;
const defaultWorkerIdleMinutes = 10;
const minimumWorkerIdleMinutes = 1;
const maximumWorkerIdleMinutes = 120;

function exists(filePath) {
  try { return fs.existsSync(filePath); } catch { return false; }
}

function isUnder(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function isUnderManagedArtifactRoot(candidate) {
  return managedArtifactRoots.some((root) => isUnder(root, candidate));
}

function modelLocationsPath() {
  return path.join(app.getPath('userData'), 'model-locations.json');
}

function preferencesPath() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

function normalizeWorkerIdleMinutes(value) {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= minimumWorkerIdleMinutes && minutes <= maximumWorkerIdleMinutes
    ? minutes
    : defaultWorkerIdleMinutes;
}

function loadPreferences() {
  try {
    const stored = JSON.parse(fs.readFileSync(preferencesPath(), 'utf8'));
    return { workerIdleMinutes: normalizeWorkerIdleMinutes(stored?.workerIdleMinutes) };
  } catch {
    return { workerIdleMinutes: defaultWorkerIdleMinutes };
  }
}

let studioPreferences = loadPreferences();

function preferenceSummary() {
  return {
    workerIdleMinutes: studioPreferences.workerIdleMinutes,
    workerIdleMinimumMinutes: minimumWorkerIdleMinutes,
    workerIdleMaximumMinutes: maximumWorkerIdleMinutes
  };
}

function loadModelLocationState() {
  try {
    const stored = JSON.parse(fs.readFileSync(modelLocationsPath(), 'utf8'));
    return {
      manualRoots: uniqueDirectories(stored?.manualRoots),
      selected: {
        index: typeof stored?.selected?.index === 'string' ? path.resolve(stored.selected.index) : null,
        qwen: typeof stored?.selected?.qwen === 'string' ? path.resolve(stored.selected.qwen) : null
      }
    };
  } catch {
    return { manualRoots: [], selected: { index: null, qwen: null } };
  }
}

let modelLocationState = loadModelLocationState();
let modelDiscovery = { checkedRoots: [], index: null, qwen: null };

function modelSearchRoots(extraRoots = []) {
  return uniqueDirectories([
    ...extraRoots,
    ...modelLocationState.manualRoots,
    modelRoot,
    softwareRoot,
    ...(!app.isPackaged ? [legacyModelRoot] : [])
  ]);
}

function refreshModelLocations(preferred = modelLocationState.selected, extraRoots = []) {
  modelDiscovery = discoverModels({ roots: modelSearchRoots(extraRoots), preferred });
  indexConfig.model = modelDiscovery.index || path.join(modelRoot, 'IndexTTS-2.5');
  qwenConfig.model = modelDiscovery.qwen || path.join(modelRoot, 'Qwen3-TTS-12Hz-1.7B-VoiceDesign');
  modelLocationState.selected = { index: modelDiscovery.index, qwen: modelDiscovery.qwen };
  return modelDiscovery;
}

function saveModelLocationState() {
  atomicWriteJson(modelLocationsPath(), modelLocationState);
}

function modelPathSource(engine, modelPath) {
  if (!modelPath || !exists(modelPath)) return '默认位置（等待模型）';
  if (isUnder(modelRoot, modelPath)) return '软件目录';
  if (modelLocationState.manualRoots.some((root) => isUnder(root, modelPath))) return '手动添加';
  return '自动检测';
}

function modelLocationSummary() {
  return {
    softwareRoot,
    dataRoot: productDataRoot,
    modelRoot,
    outputRoot: artifactRoot,
    manualRoots: [...modelLocationState.manualRoots],
    checkedRoots: [...modelDiscovery.checkedRoots]
  };
}

refreshModelLocations();

function engineStatus() {
  const runtime = runtimeLocations.summary();
  const ffmpegReady = Boolean(resolveTool('ffmpeg.exe') && resolveTool('ffprobe.exe'));
  const packagedIndexDependencies = !app.isPackaged || exists(indexConfig.dependencyRoot);
  const packagedQwenDependencies = !app.isPackaged || exists(qwenConfig.dependencyRoot);
  return {
    index: {
      id: 'indextts25',
      label: 'IndexTTS 2.5',
      installed: exists(indexConfig.python) && exists(indexConfig.script) && packagedIndexDependencies && exists(indexConfig.repo) && isModelDirectory('index', indexConfig.model),
      runtimeReady: exists(indexConfig.python) && exists(indexConfig.script) && packagedIndexDependencies && exists(indexConfig.repo),
      modelReady: isModelDirectory('index', indexConfig.model),
      purpose: '音色克隆',
      modelPath: indexConfig.model,
      defaultModelPath: path.join(modelRoot, 'IndexTTS-2.5'),
      modelPathSource: modelPathSource('index', indexConfig.model),
      modelDownloadUrl: MODEL_DOWNLOAD_URLS.index
    },
    qwen: {
      id: 'qwen3-tts-voicedesign',
      label: 'Qwen3-TTS 1.7B VoiceDesign',
      installed: exists(qwenConfig.python) && exists(qwenConfig.script) && packagedQwenDependencies && isModelDirectory('qwen', qwenConfig.model),
      runtimeReady: exists(qwenConfig.python) && exists(qwenConfig.script) && packagedQwenDependencies,
      modelReady: isModelDirectory('qwen', qwenConfig.model),
      purpose: '音色设计',
      modelPath: qwenConfig.model,
      defaultModelPath: path.join(modelRoot, 'Qwen3-TTS-12Hz-1.7B-VoiceDesign'),
      modelPathSource: modelPathSource('qwen', qwenConfig.model),
      modelDownloadUrl: MODEL_DOWNLOAD_URLS.qwen
    },
    runtime: { ...runtime, ffmpegReady }
  };
}

function cleanChildEnvironment(config) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(_API_KEY|_TOKEN|^HTTP_PROXY$|^HTTPS_PROXY$|^ALL_PROXY$)/i.test(key)) delete env[key];
  }
  env.HF_HUB_OFFLINE = '1';
  env.TRANSFORMERS_OFFLINE = '1';
  env.PYTHONUTF8 = '1';
  env.PYTHONUNBUFFERED = '1';
  env.PYTHONNOUSERSITE = '1';
  const dependencyRoots = [config?.dependencyRoot, config?.repo].filter(exists);
  if (dependencyRoots.length) env.PYTHONPATH = dependencyRoots.join(path.delimiter);
  const pythonDirectory = config?.python ? path.dirname(config.python) : null;
  const torchLibrary = config?.dependencyRoot ? path.join(config.dependencyRoot, 'torch', 'lib') : null;
  env.PATH = [pythonDirectory, torchLibrary, env.PATH].filter(Boolean).join(path.delimiter);
  return env;
}

function terminateProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const killer = spawn(taskkillPath, ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore'
    });
    killer.once('error', () => resolve());
    killer.once('exit', () => resolve());
  });
}

function terminateProcessTreeSync(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  spawnSync(taskkillPath, ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
    timeout: 8000
  });
}

function queryGpu() {
  return new Promise((resolve) => {
    execFile('nvidia-smi.exe', ['--query-gpu=name,memory.used,memory.free,utilization.gpu', '--format=csv,noheader,nounits'], {
      windowsHide: true,
      timeout: 5000,
      encoding: 'utf8'
    }, (error, stdout) => {
      if (error) return resolve({ available: false, error: 'nvidia-smi unavailable' });
      const [name, used, free, utilization] = stdout.trim().split(',').map((value) => value.trim());
      resolve({ available: true, name, usedMiB: Number(used), freeMiB: Number(free), utilizationPercent: Number(utilization) });
    });
  });
}

async function querySystemResources() {
  const gpu = await queryGpu();
  return {
    gpu,
    memory: {
      freeGiB: Math.round((os.freemem() / 1024**3) * 100) / 100,
      totalGiB: Math.round((os.totalmem() / 1024**3) * 100) / 100
    },
    active: activeJob ? { id: activeJob.id, engine: activeJob.engine, name: activeJob.name } : null,
    sampledAt: new Date().toISOString()
  };
}

async function enforceColdStartResources(engine) {
  let resources;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    resources = await querySystemResources();
    if (resources.memory.freeGiB >= 4 && resources.gpu.available && resources.gpu.freeMiB >= 4096) break;
    if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (resources.memory.freeGiB < 4) {
    throw new Error(`可用内存仅 ${resources.memory.freeGiB}GB；请先关闭占用内存的软件再加载引擎`);
  }
  if (!resources.gpu.available) throw new Error('无法读取 NVIDIA 显卡状态');
  if (resources.gpu.freeMiB < 4096) {
    throw new Error(`可用显存仅 ${resources.gpu.freeMiB}MB；${engine === 'qwen' ? '音色设计引擎' : '音色克隆引擎'}冷启动至少需要约 4096MB`);
  }
  return resources;
}

class WorkerClient {
  constructor(engine, config) {
    this.engine = engine;
    this.config = config;
    this.child = null;
    this.pending = new Map();
    this.modelLoaded = false;
    this.idleTimer = null;
    this.warmPromise = null;
    this.warmedReference = null;
  }

  start() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.child && !this.child.killed) return;
    if (!exists(this.config.python)) throw new Error(`运行环境缺少 Python：${this.config.python}`);
    if (!exists(this.config.script)) throw new Error(`软件缺少引擎工作脚本：${this.config.script}`);
    if (!exists(pythonRoot)) throw new Error(`引擎工作目录不存在：${pythonRoot}`);
    const args = ['-u', this.config.script, '--model', this.config.model];
    if (this.config.repo) args.push('--repo', this.config.repo);
    const child = spawn(this.config.python, args, {
      cwd: pythonRoot,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanChildEnvironment(this.config)
    });
    this.child = child;
    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) console.error(`[${this.engine} worker] ${text}`);
    });
    child.on('error', (error) => {
      if (this.child !== child) return;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      this.pending.clear();
      this.child = null;
      this.modelLoaded = false;
      this.warmedReference = null;
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      const error = new Error(`本地${this.engine === 'qwen' ? '设计' : '克隆'}引擎进程异常退出（${code ?? signal}）`);
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      this.pending.clear();
      this.child = null;
      this.modelLoaded = false;
      this.warmedReference = null;
      if (activeWorker === this) activeWorker = null;
    });
  }

  handleLine(line) {
    const prefix = '@@VOICE_STUDIO@@';
    if (!line.startsWith(prefix)) {
      if (line.trim()) console.log(`[${this.engine} worker] ${line.slice(-2000)}`);
      return;
    }
    let message;
    try { message = JSON.parse(line.slice(prefix.length)); } catch { return; }
    const pending = message.id ? this.pending.get(message.id) : null;
    if (message.type === 'progress') {
      if (message.stage === 'model_ready') this.modelLoaded = true;
      if (!pending?.silentProgress) emitTaskEvent({ ...message, engine: this.engine });
    }
    if (!pending) return;
    if (message.type === 'result') {
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message.result);
      this.scheduleIdleStop();
    } else if (message.type === 'error') {
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      console.error(`[${this.engine} worker error]`, message.message, message.trace || '');
      pending.reject(new Error(`本地${this.engine === 'qwen' ? '设计' : '克隆'}引擎生成失败：${String(message.message || '未知错误').slice(0, 240)}`));
      this.scheduleIdleStop();
    }
  }

  scheduleIdleStop() {
    clearTimeout(this.idleTimer);
    const idleMinutes = studioPreferences.workerIdleMinutes;
    this.idleTimer = setTimeout(() => {
      if (this.pending.size || !this.child) return;
      emitTaskEvent({ type: 'log', engine: this.engine, level: 'info', message: `引擎空闲 ${idleMinutes} 分钟，已自动卸载并释放显存` });
      this.stop();
    }, idleMinutes * 60 * 1000);
  }

  run(command, options = {}) {
    this.start();
    if (!options.background) activeWorker = this;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(command.id);
        if (!pending) return;
        this.pending.delete(command.id);
        const error = new Error(`本地${this.engine === 'qwen' ? '设计' : '克隆'}任务超过 30 分钟，已自动停止`);
        error.code = 'TASK_TIMEOUT';
        pending.reject(error);
        const pid = this.child?.pid;
        this.child = null;
        this.modelLoaded = false;
        this.warmedReference = null;
        if (pid) terminateProcessTree(pid);
      }, workerTaskTimeoutMs);
      this.pending.set(command.id, { resolve, reject, timer, silentProgress: Boolean(options.silentProgress) });
      this.child.stdin.write(`${JSON.stringify(command)}\n`, 'utf8');
    });
  }

  warm(reference = null) {
    const normalizedReference = reference ? path.resolve(reference).toLowerCase() : null;
    const fullyWarm = this.modelLoaded && (this.engine !== 'index' || !normalizedReference || this.warmedReference === normalizedReference);
    if (fullyWarm) return Promise.resolve({ ready: true, reused: true, referencePrepared: Boolean(normalizedReference) });
    if (this.warmPromise) return this.warmPromise.then(() => this.warm(reference));
    this.warmPromise = this.run({ id: crypto.randomUUID(), type: 'warmup', reference }, { background: true, silentProgress: true })
      .then((result) => {
        if (this.engine === 'index' && normalizedReference && result.referencePrepared) this.warmedReference = normalizedReference;
        return result;
      })
      .finally(() => { this.warmPromise = null; });
    return this.warmPromise;
  }

  async stop() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.child) return;
    const pid = this.child.pid;
    const error = new Error(`${this.engine} worker was stopped`);
    error.code = 'TASK_CANCELLED';
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.child = null;
    this.modelLoaded = false;
    this.warmedReference = null;
    await terminateProcessTree(pid);
  }

  stopSync() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    if (!this.child) return;
    const pid = this.child.pid;
    this.child = null;
    this.modelLoaded = false;
    this.warmedReference = null;
    terminateProcessTreeSync(pid);
  }
}

function getWorker(engine) {
  if (workers.has(engine)) return workers.get(engine);
  const config = engine === 'index' ? indexConfig : qwenConfig;
  const worker = new WorkerClient(engine, config);
  workers.set(engine, worker);
  return worker;
}

async function resetWorkersForModelChange() {
  if (activeJob) throw new Error('当前有生成任务运行，完成或停止后才能更改模型位置');
  await Promise.all([...workers.values()].map((worker) => worker.stop()));
  workers.clear();
  activeWorker = null;
}

function emitTaskEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('studio:task-event', payload);
}

function uniqueOutput(name) {
  fs.mkdirSync(artifactRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const suffix = crypto.randomBytes(3).toString('hex');
  return path.join(artifactRoot, `${stamp}-${name}-${suffix}.wav`);
}

function uniqueReferenceOutput(name) {
  const root = path.join(artifactRoot, 'reference-previews');
  fs.mkdirSync(root, { recursive: true });
  const safeName = String(name || 'reference').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 48) || 'reference';
  return path.join(root, `${Date.now()}-${safeName}-${crypto.randomBytes(3).toString('hex')}.wav`);
}

function atomicWriteJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, target);
}

function taskHistoryPath() {
  return path.join(app.getPath('userData'), 'task-history.json');
}

function descriptionHistoryPath() {
  return path.join(app.getPath('userData'), 'description-history.json');
}

function loadDescriptionHistory() {
  try {
    const records = JSON.parse(fs.readFileSync(descriptionHistoryPath(), 'utf8'));
    return Array.isArray(records)
      ? records.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, 30)
      : [];
  } catch { return []; }
}

function addDescriptionHistory(description) {
  const normalized = String(description).replace(/\r\n/g, '\n').trim();
  const records = loadDescriptionHistory().filter((entry) => entry !== normalized);
  records.unshift(normalized);
  atomicWriteJson(descriptionHistoryPath(), records.slice(0, 30));
  return records.slice(0, 30);
}

function deleteDescriptionHistory(description) {
  const normalized = String(description ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) throw new Error('历史描述无效');
  const records = loadDescriptionHistory().filter((entry) => entry !== normalized);
  atomicWriteJson(descriptionHistoryPath(), records);
  return records;
}

function loadTaskHistory() {
  try {
    const records = JSON.parse(fs.readFileSync(taskHistoryPath(), 'utf8'));
    return Array.isArray(records) ? records.slice(0, 60) : [];
  } catch { return []; }
}

function upsertTask(task) {
  const records = loadTaskHistory();
  const index = records.findIndex((record) => record.id === task.id);
  if (index >= 0) records[index] = { ...records[index], ...task };
  else records.unshift(task);
  atomicWriteJson(taskHistoryPath(), records.slice(0, 60));
}

function recoverInterruptedTasks() {
  const records = loadTaskHistory();
  let changed = false;
  const recovered = records.map((record) => {
    if (record.status !== 'running') return record;
    changed = true;
    return { ...record, status: 'interrupted', error: '应用上次退出时任务仍在运行', completedAt: new Date().toISOString() };
  });
  if (changed) atomicWriteJson(taskHistoryPath(), recovered);
}

function writeOutputSidecar(engine, request, result, output) {
  const sidecar = output.replace(/\.wav$/i, '.json');
  const metadata = {
    schemaVersion: 1,
    engine: engine === 'qwen' ? 'Qwen3-TTS-12Hz-1.7B-VoiceDesign' : 'IndexTTS-2.5',
    name: request.name,
    text: request.text,
    language: request.language ?? 'Chinese',
    voiceDescription: request.description ?? null,
    designProfile: request.designProfile ?? null,
    resolvedVoiceInstruction: request.instruction ?? null,
    generationParameters: {
      temperature: request.temperature,
      topP: request.topP,
      topK: request.topK,
      repetitionPenalty: request.repetitionPenalty,
      requestedSeed: request.requestedSeed ?? request.seed,
      seed: request.seed,
      intervalSilence: request.intervalSilence ?? null,
      emotionStrength: request.emotionStrength ?? null,
      customEmotion: request.useCustomEmotion ?? null,
      batch: request.batchId ? { id: request.batchId, name: request.batchName, candidateCount: request.candidateCount, candidateIndex: request.candidateIndex, candidateLabel: request.candidateLabel } : null
    },
    reference: request.reference ? { path: request.reference, name: path.basename(request.reference) } : null,
    emotionPreset: request.emotionPreset ?? null,
    emotionMode: request.emotionMode ?? 'preset',
    emotionText: request.emotionText ?? null,
    emotionAudio: request.emotionAudio ? { path: request.emotionAudio, name: path.basename(request.emotionAudio) } : null,
    emotionVector: result.resolvedEmotionVector ?? request.emotionVector ?? null,
    emotionAnalyzer: result.emotionAnalyzer ?? null,
    durationFactor: request.durationFactor ?? null,
    speedRatio: request.durationFactor ? Number((1 / request.durationFactor).toFixed(4)) : null,
    output,
    audio: {
      durationSeconds: result.durationSeconds,
      sampleRate: result.sampleRate,
      generationSeconds: result.generationSeconds
    },
    createdAt: new Date().toISOString()
  };
  atomicWriteJson(sidecar, metadata);
  return sidecar;
}

async function runExclusive(engine, request) {
  if (activeJob) throw new Error('当前已有任务运行，请等待完成或先停止');
  if (activeModelDownload) throw new Error('当前正在下载模型，请等待下载完成或先取消下载');
  if (runtimeInstallActive) throw new Error('当前正在安装运行环境，请等待安装完成');
  const status = engineStatus();
  const targetStatus = engine === 'index' ? status.index : status.qwen;
  if (!targetStatus.installed) {
    const error = new Error(`${engine === 'qwen' ? '音色设计引擎' : '音色克隆引擎'}尚未安装，请在“引擎设置”中查看详情`);
    error.code = 'MODEL_NOT_INSTALLED';
    throw error;
  }
  for (const [otherEngine, worker] of workers.entries()) {
    if (otherEngine !== engine && worker.child) {
      emitTaskEvent({ type: 'log', engine, level: 'info', message: `正在卸载${otherEngine === 'qwen' ? '设计引擎' : '克隆引擎'}，释放显存` });
      await worker.stop();
    }
  }
  const worker = getWorker(engine);
  if (!worker.child || !worker.modelLoaded) await enforceColdStartResources(engine);
  const joiningWarmup = Boolean(worker.warmPromise && !worker.modelLoaded);
  const effectiveRequest = request.seed === -1
    ? { ...request, requestedSeed: -1, seed: crypto.randomInt(0, 2147483648) }
    : request;
  const id = crypto.randomUUID();
  const output = uniqueOutput(effectiveRequest.name);
  activeJob = { id, engine, name: effectiveRequest.name, output, startedAt: Date.now() };
  upsertTask({
    id,
    engine,
    name: effectiveRequest.name,
    status: 'running',
    requestedSeed: effectiveRequest.requestedSeed ?? effectiveRequest.seed,
    seed: effectiveRequest.seed,
    batchId: engine === 'qwen' ? effectiveRequest.batchId : null,
    batchName: engine === 'qwen' ? effectiveRequest.batchName : null,
    candidateCount: engine === 'qwen' ? effectiveRequest.candidateCount : null,
    candidateIndex: engine === 'qwen' ? effectiveRequest.candidateIndex : null,
    candidateLabel: engine === 'qwen' ? effectiveRequest.candidateLabel : null,
    retryRequest: effectiveRequest,
    createdAt: new Date().toISOString()
  });
  emitTaskEvent({ type: 'progress', id, engine, stage: 'queued', percent: 5, message: '任务已进入本地 GPU 队列' });
  if (joiningWarmup) {
    emitTaskEvent({ type: 'progress', id, engine, stage: 'loading_model', percent: 12, message: '正在等待后台预热完成，随后立即生成' });
  }
  const heartbeatTimer = setInterval(() => {
    if (activeJob?.id !== id) return;
    emitTaskEvent({ type: 'heartbeat', id, engine, elapsedSeconds: Math.round((Date.now() - activeJob.startedAt) / 1000) });
  }, 5000);
  try {
    const command = engine === 'index'
      ? { id, type: 'synthesize', output, ...effectiveRequest }
      : { id, type: 'design', output, ...effectiveRequest };
    const result = await worker.run(command);
    const resolvedOutput = path.resolve(result.output);
    if (!isUnder(artifactRoot, resolvedOutput) || !exists(resolvedOutput)) throw new Error('本地引擎返回了无效结果');
    approvedOutputs.add(resolvedOutput.toLowerCase());
    const sidecar = writeOutputSidecar(engine, effectiveRequest, result, resolvedOutput);
    const response = {
      ...result,
      id,
      engine,
      output: resolvedOutput,
      sidecar,
      seed: effectiveRequest.seed,
      requestedSeed: effectiveRequest.requestedSeed ?? effectiveRequest.seed,
      url: pathToFileURL(resolvedOutput).href
    };
    upsertTask({ id, status: 'completed', output: resolvedOutput, sidecar, completedAt: new Date().toISOString() });
    emitTaskEvent({ type: 'completed', percent: 100, ...response });
    return response;
  } catch (error) {
    try { if (exists(output)) fs.unlinkSync(output); } catch { /* failed outputs are unique; cleanup is best effort */ }
    if (error.code === 'TASK_CANCELLED') {
      upsertTask({ id, status: 'cancelled', completedAt: new Date().toISOString() });
    } else {
      upsertTask({ id, status: 'failed', error: error.message, completedAt: new Date().toISOString() });
      emitTaskEvent({ type: 'failed', id, engine, message: error.message });
    }
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    activeJob = null;
    activeWorker = null;
  }
}

function libraryPath() {
  return path.join(app.getPath('userData'), 'voice-library.json');
}

function loadLibrary() {
  const target = libraryPath();
  if (!exists(target)) return [];
  try {
    const records = JSON.parse(fs.readFileSync(target, 'utf8'));
    return Array.isArray(records) ? records.filter((record) => record && exists(record.output)) : [];
  } catch { return []; }
}

function writeLibrary(records) {
  atomicWriteJson(libraryPath(), records);
  scheduleStorageBroadcast();
}

function isManagedVoiceOutput(outputPath) {
  const output = path.resolve(String(outputPath ?? ''));
  if (!isUnderManagedArtifactRoot(output) || path.extname(output).toLowerCase() !== '.wav' || !exists(output)) return false;
  if (approvedOutputs.has(output.toLowerCase())) return true;
  if (loadLibrary().some((voice) => path.resolve(voice.output) === output)) return true;
  return loadTaskHistory().some((task) => task.status === 'completed' && task.output && path.resolve(task.output) === output);
}

function audioAnalysisSignature(inputPath) {
  const resolved = path.resolve(inputPath);
  const stat = fs.statSync(resolved);
  return `${stat.size}:${stat.mtimeMs}`;
}

function cachedAudioAnalysis(inputPath) {
  const resolved = path.resolve(inputPath);
  let signature;
  try { signature = audioAnalysisSignature(resolved); } catch { return null; }
  const cached = referenceAnalysisCache.get(resolved.toLowerCase());
  return cached?.signature === signature ? cached.result ?? null : null;
}

function rememberAudioAnalysis(inputPath, analysis) {
  const resolved = path.resolve(inputPath);
  referenceAnalysisCache.set(resolved.toLowerCase(), {
    signature: audioAnalysisSignature(resolved),
    result: analysis,
    promise: Promise.resolve(analysis)
  });
  return analysis;
}

function analyzeAudioCached(inputPath) {
  const resolved = path.resolve(inputPath);
  const key = resolved.toLowerCase();
  const signature = audioAnalysisSignature(resolved);
  const cached = referenceAnalysisCache.get(key);
  if (cached?.signature === signature) {
    if (cached.result) return Promise.resolve(cached.result);
    if (cached.promise) return cached.promise;
  }
  const entry = { signature, result: null, promise: null };
  entry.promise = analyzeAudio(resolved)
    .then((analysis) => {
      entry.result = analysis;
      return analysis;
    })
    .catch((error) => {
      if (referenceAnalysisCache.get(key) === entry) referenceAnalysisCache.delete(key);
      throw error;
    });
  referenceAnalysisCache.set(key, entry);
  return entry.promise;
}

function generatedReferencePlaceholder(outputPath) {
  const sidecar = path.resolve(outputPath).replace(/\.wav$/i, '.json');
  let audio = {};
  if (isUnderManagedArtifactRoot(sidecar) && exists(sidecar)) {
    try { audio = JSON.parse(fs.readFileSync(sidecar, 'utf8')).audio ?? {}; } catch { /* analysis will fill this in shortly */ }
  }
  return {
    durationSeconds: Number(audio.durationSeconds) || 0,
    sampleRate: Number(audio.sampleRate) || null,
    channels: 1,
    integratedLufs: null,
    truePeakDb: null,
    loudnessRangeLu: null,
    silenceSeconds: 0,
    silenceRatio: 0,
    waveform: [],
    status: 'analyzing',
    issues: []
  };
}

function taskForRenderer(task) {
  if (task.status !== 'completed' || !task.output) return task;
  const output = path.resolve(task.output);
  if (!isUnderManagedArtifactRoot(output) || path.extname(output).toLowerCase() !== '.wav' || !exists(output)) return task;
  approvedOutputs.add(output.toLowerCase());
  let audio = {};
  const sidecar = task.sidecar ? path.resolve(task.sidecar) : output.replace(/\.wav$/i, '.json');
  if (isUnderManagedArtifactRoot(sidecar) && exists(sidecar)) {
    try { audio = JSON.parse(fs.readFileSync(sidecar, 'utf8')).audio ?? {}; } catch { /* old result can still be replayed */ }
  }
  return {
    ...task,
    output,
    sidecar: exists(sidecar) ? sidecar : null,
    url: pathToFileURL(output).href,
    durationSeconds: audio.durationSeconds ?? task.durationSeconds,
    generationSeconds: audio.generationSeconds ?? task.generationSeconds
  };
}

function listArtifactFiles(root = artifactRoot) {
  if (!exists(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (!isUnder(artifactRoot, target) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...listArtifactFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function existingManagedPaths(record) {
  const paths = [];
  for (const [candidate, expectedExtension] of [[record?.output, '.wav'], [record?.sidecar, '.json']]) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (path.extname(resolved).toLowerCase() === expectedExtension && isUnderManagedArtifactRoot(resolved) && exists(resolved)) paths.push(resolved);
  }
  return paths;
}

function storageInventory() {
  const files = listArtifactFiles();
  const savedPaths = new Set(loadLibrary().flatMap(existingManagedPaths).map((file) => file.toLowerCase()));
  const taskRecords = loadTaskHistory().filter((task) => task.status === 'completed');
  const taskPaths = new Set(taskRecords.flatMap(existingManagedPaths).map((file) => file.toLowerCase()));
  const directResultFile = (file) => path.dirname(file) === path.resolve(artifactRoot) && ['.wav', '.json'].includes(path.extname(file).toLowerCase());
  const temporary = files.filter((file) => /\.(?:part|partial|tmp|download)$/i.test(file));
  const orphan = files.filter((file) => directResultFile(file) && !savedPaths.has(file.toLowerCase()) && !taskPaths.has(file.toLowerCase()));
  const saved = files.filter((file) => savedPaths.has(file.toLowerCase()));
  const unsaved = files.filter((file) => taskPaths.has(file.toLowerCase()) && !savedPaths.has(file.toLowerCase()));
  const bytes = (items) => items.reduce((total, file) => {
    try { return total + fs.statSync(file).size; } catch { return total; }
  }, 0);
  return {
    files,
    taskRecords,
    saved,
    unsaved,
    temporary,
    orphan,
    summary: {
      total: { count: files.length, bytes: bytes(files) },
      saved: { count: saved.length, bytes: bytes(saved) },
      unsaved: { count: unsaved.length, bytes: bytes(unsaved) },
      temporary: { count: temporary.length, bytes: bytes(temporary) },
      orphan: { count: orphan.length, bytes: bytes(orphan) }
    }
  };
}

function scheduleStorageBroadcast(delayMs = 350) {
  clearTimeout(storageBroadcastTimer);
  storageBroadcastTimer = setTimeout(() => {
    storageBroadcastTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('studio:storage-status-changed', storageInventory().summary);
  }, delayMs);
}

function startStorageWatcher() {
  if (storageWatcher) return;
  try {
    storageWatcher = fs.watch(artifactRoot, { persistent: false }, () => scheduleStorageBroadcast());
    storageWatcher.on('error', (error) => console.error('Storage watcher failed:', error));
  } catch (error) {
    console.error('Could not watch output directory:', error);
  }
}

async function cleanupStorage(input) {
  const scope = String(input?.scope ?? '');
  if (!['temporary', 'orphan', 'unsaved'].includes(scope)) throw new Error('不支持的清理范围');
  const inventory = storageInventory();
  const currentOutput = input?.currentOutput ? path.resolve(String(input.currentOutput)) : null;
  const protectedPaths = new Set();
  if (currentOutput && isManagedVoiceOutput(currentOutput)) {
    protectedPaths.add(currentOutput.toLowerCase());
    protectedPaths.add(currentOutput.replace(/\.wav$/i, '.json').toLowerCase());
  }
  const candidates = inventory[scope].filter((file) => !protectedPaths.has(file.toLowerCase()));
  const removed = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!isUnder(artifactRoot, resolved) || !exists(resolved) || !fs.statSync(resolved).isFile()) continue;
    await shell.trashItem(resolved);
    removed.push(resolved);
  }
  if (scope === 'unsaved' && removed.length) {
    const removedOutputs = new Set(removed.filter((file) => path.extname(file).toLowerCase() === '.wav').map((file) => file.toLowerCase()));
    atomicWriteJson(taskHistoryPath(), loadTaskHistory().filter((task) => !task.output || !removedOutputs.has(path.resolve(task.output).toLowerCase())));
  }
  return { removedCount: removed.length, protectedCurrent: candidates.length < inventory[scope].length, storage: storageInventory().summary };
}

ipcMain.handle('studio:bootstrap', async () => {
  return {
    engines: engineStatus(),
    library: loadLibrary().map((voice) => ({ ...voice, url: pathToFileURL(voice.output).href })),
    tasks: loadTaskHistory().map(taskForRenderer),
    descriptionHistory: loadDescriptionHistory(),
    artifactRoot,
    modelLocations: modelLocationSummary(),
    preferences: preferenceSummary(),
    build: { channel: detectBuildChannel({ isPackaged: app.isPackaged, version: app.getVersion() }), version: app.getVersion(), title: '小沐音色工坊' },
    busy: Boolean(activeJob)
  };
});

ipcMain.handle('studio:system-status', () => querySystemResources());
ipcMain.handle('studio:storage-status', () => storageInventory().summary);
ipcMain.handle('studio:cleanup-storage', (_event, input) => cleanupStorage(input));
ipcMain.handle('studio:set-worker-idle-minutes', (_event, requestedMinutes) => {
  const minutes = Number(requestedMinutes);
  if (!Number.isInteger(minutes) || minutes < minimumWorkerIdleMinutes || minutes > maximumWorkerIdleMinutes) {
    throw new Error(`空闲释放时间必须是 ${minimumWorkerIdleMinutes}–${maximumWorkerIdleMinutes} 分钟的整数`);
  }
  studioPreferences = { ...studioPreferences, workerIdleMinutes: minutes };
  atomicWriteJson(preferencesPath(), studioPreferences);
  for (const worker of workers.values()) {
    if (worker.child && worker.pending.size === 0) worker.scheduleIdleStop();
  }
  return preferenceSummary();
});
ipcMain.handle('studio:warm-engine', async (_event, requestedEngine, requestedReference) => {
  const engine = requestedEngine === 'index' ? 'index' : requestedEngine === 'qwen' ? 'qwen' : null;
  if (!engine) throw new Error('引擎类型无效');
  const reference = engine === 'index' && requestedReference ? path.resolve(requestedReference) : null;
  if (reference && (!approvedReferences.has(reference.toLowerCase()) || !exists(reference))) {
    throw new Error('预热使用的参考音频未经应用选择');
  }
  if (activeJob || activeModelDownload || runtimeInstallActive) return { ready: false, reason: 'busy' };
  const status = engineStatus()[engine];
  if (!status.installed) return { ready: false, reason: 'not-installed' };
  for (const [otherEngine, otherWorker] of workers.entries()) {
    if (otherEngine !== engine && otherWorker.child) await otherWorker.stop();
  }
  if (activeJob) return { ready: false, reason: 'busy' };
  const worker = getWorker(engine);
  const reused = Boolean(worker.child && worker.modelLoaded);
  if (!worker.child) await enforceColdStartResources(engine);
  if (activeJob) return { ready: false, reason: 'busy' };
  const result = await worker.warm(reference);
  return { ready: true, reused, referencePrepared: Boolean(result.referencePrepared) };
});
ipcMain.handle('studio:detect-models', async () => {
  if (activeModelDownload) throw new Error('模型正在下载，完成或取消后才能重新检测');
  await resetWorkersForModelChange();
  refreshModelLocations({ index: null, qwen: null });
  saveModelLocationState();
  return { engines: engineStatus(), modelLocations: modelLocationSummary() };
});
ipcMain.handle('studio:add-model-location', async (_event, requestedEngine) => {
  const engine = requestedEngine === 'index' ? 'index' : requestedEngine === 'qwen' ? 'qwen' : null;
  if (!engine) throw new Error('模型类型无效');
  if (activeJob) throw new Error('当前有生成任务运行，完成或停止后才能更改模型位置');
  if (activeModelDownload) throw new Error('模型正在下载，完成或取消后才能更改模型位置');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: engine === 'index' ? '添加 IndexTTS 2.5 模型位置' : '添加 Qwen3-TTS VoiceDesign 模型位置',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const selectedRoot = path.resolve(result.filePaths[0]);
  const modelPath = findModelDirectory(engine, [selectedRoot]);
  if (!modelPath) {
    throw new Error(engine === 'index'
      ? '所选目录中的 IndexTTS 2.5 文件不完整，请使用一键下载补齐主模型和辅助模型'
      : '所选目录中的 Qwen3-TTS VoiceDesign 文件不完整，请使用一键下载补齐模型');
  }
  await resetWorkersForModelChange();
  modelLocationState.manualRoots = uniqueDirectories([selectedRoot, ...modelLocationState.manualRoots]);
  const preferred = { ...modelLocationState.selected, [engine]: modelPath };
  refreshModelLocations(preferred, [selectedRoot]);
  saveModelLocationState();
  return { engines: engineStatus(), modelLocations: modelLocationSummary() };
});

ipcMain.handle('studio:probe-runtime', async () => {
  const runtime = await runtimeLocations.probe(true);
  return { runtime, engines: engineStatus() };
});

ipcMain.handle('studio:add-runtime-location', async () => {
  if (activeJob) throw new Error('当前有生成任务运行，完成或停止后才能更改运行环境');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '添加 Python 3.11 + PyTorch CUDA 运行环境',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  await resetWorkersForModelChange();
  runtimeLocations.add(result.filePaths[0]);
  const python = runtimeLocations.selectedPython();
  if (app.isPackaged) {
    indexConfig.python = python;
    qwenConfig.python = python;
  }
  const runtime = await runtimeLocations.probe(true);
  return { runtime, engines: engineStatus() };
});

ipcMain.handle('studio:install-runtime', async () => {
  if (activeJob) throw new Error('当前有生成任务运行，完成或停止后才能安装运行环境');
  if (activeModelDownload) throw new Error('当前正在下载模型，请等待完成或先取消下载');
  if (runtimeInstallActive) throw new Error('运行环境正在安装，请勿重复操作');
  const report = (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('studio:runtime-install-progress', progress);
  };
  runtimeInstallActive = true;
  try {
    report({ stage: 'preparing', percent: 0, message: '正在准备安装运行环境' });
    const releaseRoot = app.isPackaged ? path.join(process.resourcesPath, 'release') : path.join(studioRoot, 'release');
    const manifestPath = path.join(releaseRoot, 'runtime-assets.json');
    const manifest = readManifest(manifestPath);
    let bundleDirectory;
    let downloadedBundles = false;
    if (manifest.downloadBaseUrl) {
      bundleDirectory = path.join(productDataRoot, 'downloads', 'runtime', manifest.version);
      downloadedBundles = true;
      await downloadRuntimeBundles(manifest, bundleDirectory, report);
    } else {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择已下载的运行时资源包目录',
        properties: ['openDirectory']
      });
      if (result.canceled || !result.filePaths[0]) return null;
      bundleDirectory = path.resolve(result.filePaths[0]);
    }
    await resetWorkersForModelChange();
    const installed = await installRuntimeBundles({
      manifestPath,
      extractorPath: path.join(releaseRoot, 'tools', '7za.exe'),
      bundleDirectory,
      dataRoot: productDataRoot,
      onProgress: report
    });
    runtimeLocations.add(path.join(productDataRoot, 'runtime', 'core'));
    indexConfig.python = installed.python;
    qwenConfig.python = installed.python;
    configureAudioTools([path.join(runtimeLocations.toolRoot, 'ffmpeg', 'bin')]);
    report({ stage: 'checking', percent: 99, message: '正在检测运行环境兼容性' });
    const runtime = await runtimeLocations.probe(true);
    if (downloadedBundles) {
      report({ stage: 'cleaning', percent: 99, message: '正在清理运行环境安装包' });
      removeDownloadedBundles(productDataRoot, bundleDirectory);
    }
    report({ stage: 'completed', percent: 100, message: runtime.compatible ? '运行环境安装完成' : '运行环境已安装，兼容性检测未通过' });
    return { runtime, engines: engineStatus() };
  } catch (error) {
    report({ stage: 'failed', percent: 0, message: error.message || '运行环境安装失败' });
    throw error;
  } finally {
    runtimeInstallActive = false;
  }
});

ipcMain.handle('studio:open-model-download', async (_event, url) => {
  if (!isAllowedModelDownloadUrl(url)) throw new Error('不受信任的模型下载地址');
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('studio:download-model', async (_event, requestedEngine) => {
  const engine = requestedEngine === 'index' ? 'index' : requestedEngine === 'qwen' ? 'qwen' : null;
  if (!engine) throw new Error('模型类型无效');
  if (activeJob) throw new Error('当前有生成任务运行，完成或停止后才能下载模型');
  if (runtimeInstallActive) throw new Error('当前正在安装运行环境，请等待安装完成后再下载模型');
  if (activeModelDownload) throw new Error(`正在下载${activeModelDownload.engine === 'index' ? '音色克隆' : '音色设计'}模型`);
  const targetRoot = engine === 'index'
    ? path.join(modelRoot, 'IndexTTS-2.5')
    : path.join(modelRoot, 'Qwen3-TTS-12Hz-1.7B-VoiceDesign');
  const controller = new AbortController();
  const report = (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('studio:model-download-progress', progress);
  };
  activeModelDownload = { engine, controller, targetRoot };
  try {
    const prepared = await prepareModelDownload(engine, targetRoot, { signal: controller.signal, onProgress: report });
    const response = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '下载完整模型',
      message: `下载 ${prepared.label}？`,
      detail: `完整大小：${formatDownloadBytes(prepared.total)}\n本次还需下载：${formatDownloadBytes(prepared.required)}\n保存位置：${prepared.targetRoot}\n\n已存在且完整的文件会直接复用，未完成文件可断点续传。`,
      buttons: ['开始下载', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (response.response !== 0) {
      report({ engine, stage: 'cancelled', percent: 0, message: '已取消模型下载' });
      return { cancelled: true };
    }
    const result = await downloadPreparedModel(prepared, { signal: controller.signal, onProgress: report });
    await resetWorkersForModelChange();
    const preferred = { ...modelLocationState.selected, [engine]: targetRoot };
    refreshModelLocations(preferred, [targetRoot]);
    saveModelLocationState();
    return { cancelled: false, result, engines: engineStatus(), modelLocations: modelLocationSummary() };
  } catch (error) {
    const cancelled = controller.signal.aborted || /取消/.test(error.message);
    report({ engine, stage: cancelled ? 'cancelled' : 'failed', percent: 0, message: cancelled ? '模型下载已取消，可稍后继续' : error.message });
    if (cancelled) return { cancelled: true };
    throw error;
  } finally {
    if (activeModelDownload?.controller === controller) activeModelDownload = null;
  }
});

ipcMain.handle('studio:cancel-model-download', async (_event, requestedEngine) => {
  if (!activeModelDownload || activeModelDownload.engine !== requestedEngine) return { cancelled: false };
  activeModelDownload.controller.abort(new Error('用户取消了模型下载'));
  return { cancelled: true };
});

ipcMain.handle('studio:pick-reference', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择音色参考音频',
    properties: ['openFile'],
    filters: [{ name: '音频文件', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const selected = path.resolve(result.filePaths[0]);
  approvedReferences.add(selected.toLowerCase());
  const analysis = await analyzeAudioCached(selected);
  return { path: selected, name: path.basename(selected), url: pathToFileURL(selected).href, analysis };
});

ipcMain.handle('studio:pick-emotion-reference', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择情感参考音频',
    properties: ['openFile'],
    filters: [{ name: '音频文件', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const selected = path.resolve(result.filePaths[0]);
  approvedReferences.add(selected.toLowerCase());
  const analysis = await analyzeAudioCached(selected);
  return { path: selected, name: path.basename(selected), url: pathToFileURL(selected).href, analysis };
});

ipcMain.handle('studio:trim-reference', async (_event, input) => {
  const source = path.resolve(String(input?.path ?? ''));
  if (!approvedReferences.has(source.toLowerCase()) || !exists(source)) throw new Error('该参考音频未经应用选择');
  const analysis = await analyzeAudioCached(source);
  const startSeconds = Number(input?.startSeconds);
  const endSeconds = Number(input?.endSeconds);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > analysis.durationSeconds + 0.02) {
    throw new Error('裁剪时间范围无效');
  }
  if (endSeconds - startSeconds < 2 || endSeconds - startSeconds > 30) throw new Error('裁剪副本应为 2–30 秒');
  const output = uniqueReferenceOutput(path.parse(source).name);
  const trimmedAnalysis = await createReferenceCopy(source, output, startSeconds, endSeconds, input?.normalize !== false);
  rememberAudioAnalysis(output, trimmedAnalysis);
  approvedReferences.add(output.toLowerCase());
  return { path: output, name: path.basename(output), url: pathToFileURL(output).href, analysis: trimmedAnalysis, source };
});

ipcMain.handle('studio:use-output-as-reference', async (_event, outputPath) => {
  const selected = path.resolve(String(outputPath ?? ''));
  if (!isManagedVoiceOutput(selected)) {
    throw new Error('该生成结果不可用作参考音频');
  }
  approvedReferences.add(selected.toLowerCase());
  const analysis = cachedAudioAnalysis(selected);
  return {
    path: selected,
    name: path.basename(selected),
    url: pathToFileURL(selected).href,
    analysis: analysis ?? generatedReferencePlaceholder(selected),
    analysisPending: !analysis
  };
});

ipcMain.handle('studio:analyze-approved-reference', async (_event, inputPath) => {
  const selected = path.resolve(String(inputPath ?? ''));
  if (!approvedReferences.has(selected.toLowerCase()) || !exists(selected)) {
    throw new Error('该参考音频未经应用选择');
  }
  return analyzeAudioCached(selected);
});

ipcMain.handle('studio:synthesize-clone', (_event, input) => runExclusive('index', validateCloneRequest(input, approvedReferences)));
ipcMain.handle('studio:synthesize-design', (_event, input) => {
  const request = validateDesignRequest(input);
  addDescriptionHistory(request.description);
  return runExclusive('qwen', request);
});

ipcMain.handle('studio:retry-task', (_event, taskId) => {
  const id = String(taskId ?? '');
  if (!id || activeJob) throw new Error(activeJob ? '当前已有任务运行' : '任务记录无效');
  const task = loadTaskHistory().find((record) => record.id === id);
  if (!task?.retryRequest || !['failed', 'cancelled', 'interrupted'].includes(task.status)) throw new Error('该任务当前不可重试');
  if (task.engine === 'index') {
    const reference = path.resolve(String(task.retryRequest.reference ?? ''));
    if (!exists(reference)) throw new Error('原参考音频已不存在');
    approvedReferences.add(reference.toLowerCase());
    if (task.retryRequest.emotionMode === 'audio') {
      const emotionAudio = path.resolve(String(task.retryRequest.emotionAudio ?? ''));
      if (!exists(emotionAudio)) throw new Error('原情感参考音频已不存在');
      approvedReferences.add(emotionAudio.toLowerCase());
    }
    return runExclusive('index', validateCloneRequest(task.retryRequest, approvedReferences));
  }
  return runExclusive('qwen', validateDesignRequest(task.retryRequest));
});

ipcMain.handle('studio:cancel-active', () => {
  if (!activeJob || !activeWorker) return { cancelled: false };
  const cancelled = { ...activeJob };
  return activeWorker.stop().then(() => {
    activeWorker = null;
    activeJob = null;
    upsertTask({ id: cancelled.id, status: 'cancelled', completedAt: new Date().toISOString() });
    emitTaskEvent({ type: 'cancelled', ...cancelled });
    return { cancelled: true, id: cancelled.id };
  });
});

ipcMain.handle('studio:reveal-output', (_event, outputPath) => {
  const resolved = path.resolve(String(outputPath));
  if (!isManagedVoiceOutput(resolved)) {
    throw new Error('Output path is not approved');
  }
  shell.showItemInFolder(resolved);
  return true;
});
ipcMain.handle('studio:copy-text', (_event, input) => {
  const value = String(input ?? '').trim().slice(0, 8000);
  if (!value) throw new Error('没有可复制的内容');
  clipboard.writeText(value);
  return true;
});

ipcMain.handle('studio:save-voice', (_event, input) => {
  const output = path.resolve(String(input?.output ?? ''));
  if (!isManagedVoiceOutput(output)) throw new Error('Invalid voice output');
  const records = loadLibrary();
  const existing = records.find((voice) => path.resolve(voice.output) === output);
  if (existing) return { ...existing, url: pathToFileURL(output).href };
  const sourceTask = loadTaskHistory().find((task) => task.output && path.resolve(task.output) === output);
  const requestedGeneratedAt = new Date(String(input?.generatedAt ?? ''));
  const record = {
    id: crypto.randomUUID(),
    name: String(input.name ?? '未命名音色').trim().slice(0, 60),
    kind: input.kind === 'design' ? 'design' : 'clone',
    engine: input.engine === 'qwen' ? 'design' : 'clone',
    output,
    sidecar: exists(output.replace(/\.wav$/i, '.json')) ? output.replace(/\.wav$/i, '.json') : null,
    seed: Number.isInteger(sourceTask?.seed) ? sourceTask.seed : (Number.isInteger(input?.seed) ? input.seed : null),
    generatedAt: sourceTask?.completedAt || (Number.isNaN(requestedGeneratedAt.getTime()) ? new Date().toISOString() : requestedGeneratedAt.toISOString()),
    favorite: false,
    createdAt: new Date().toISOString()
  };
  records.unshift(record);
  writeLibrary(records.slice(0, 200));
  return { ...record, url: pathToFileURL(output).href };
});

ipcMain.handle('studio:rename-voice', (_event, input) => {
  const id = String(input?.id ?? '');
  const name = String(input?.name ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().slice(0, 60);
  if (!id || !name) throw new Error('音色名称无效');
  const records = loadLibrary();
  const index = records.findIndex((voice) => voice.id === id);
  if (index < 0) throw new Error('音色记录不存在');
  records[index] = { ...records[index], name, updatedAt: new Date().toISOString() };
  writeLibrary(records);
  return { ...records[index], url: pathToFileURL(records[index].output).href };
});

ipcMain.handle('studio:favorite-voice', (_event, voiceId) => {
  const id = String(voiceId ?? '');
  const records = loadLibrary();
  const index = records.findIndex((voice) => voice.id === id);
  if (index < 0) throw new Error('音色记录不存在');
  records[index] = { ...records[index], favorite: !records[index].favorite, updatedAt: new Date().toISOString() };
  writeLibrary(records);
  return { ...records[index], url: pathToFileURL(records[index].output).href };
});

ipcMain.handle('studio:delete-voice', async (_event, voiceId) => {
  const records = loadLibrary();
  const target = records.find((voice) => voice.id === voiceId);
  if (!target) return { removed: false };
  const output = path.resolve(target.output);
  if (!isUnderManagedArtifactRoot(output)) throw new Error('音频文件不在受管结果目录中');
  if (records.some((voice) => voice.id !== target.id && path.resolve(voice.output) === output)) throw new Error('该音频仍被其他音色记录使用，不能删除文件');
  if (exists(output)) await shell.trashItem(output);
  if (target.sidecar && isUnderManagedArtifactRoot(target.sidecar) && exists(target.sidecar)) await shell.trashItem(target.sidecar);
  writeLibrary(records.filter((voice) => voice.id !== voiceId));
  return { removed: true, deletedFiles: true };
});

ipcMain.handle('studio:delete-task', async (_event, taskId) => {
  const id = String(taskId ?? '');
  if (!id || activeJob?.id === id) throw new Error('运行中的任务不能删除');
  const records = loadTaskHistory();
  const target = records.find((task) => task.id === id);
  let deletedOutput = null;
  if (target?.output) {
    const output = path.resolve(target.output);
    const saved = loadLibrary().some((voice) => path.resolve(voice.output) === output);
    if (!saved && isUnderManagedArtifactRoot(output)) {
      if (exists(output)) await shell.trashItem(output);
      const sidecar = target.sidecar ? path.resolve(target.sidecar) : output.replace(/\.wav$/i, '.json');
      if (isUnderManagedArtifactRoot(sidecar) && exists(sidecar)) await shell.trashItem(sidecar);
      deletedOutput = output;
    }
  }
  atomicWriteJson(taskHistoryPath(), records.filter((task) => task.id !== id));
  return { removed: true, deletedOutput };
});

ipcMain.handle('studio:delete-description-history', (_event, description) => deleteDescriptionHistory(description));

async function createWindow() {
  app.setAppUserModelId('com.local.voicestudio');
  Menu.setApplicationMenu(null);
  const window = new BrowserWindow({
    title: app.isPackaged ? '小沐音色工坊' : '小沐音色工坊 · Debug',
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#090b12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow = window;
  startStorageWatcher();
  window.on('closed', () => { mainWindow = null; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^(https?|wss?):/i.test(details.url) });
  });
  await window.loadFile(path.join(rendererRoot, 'index.html'));
  window.show();
  window.center();
  if (process.argv.includes('--smoke')) {
    const smokeRoot = path.join(app.getPath('userData'), 'smoke');
    fs.mkdirSync(smokeRoot, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const pages = ['overview', 'design', 'clone', 'library', 'tasks', 'settings'];
    for (const page of pages) {
      await window.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click()`);
      await new Promise((resolve) => setTimeout(resolve, 320));
      const image = await window.webContents.capturePage();
      fs.writeFileSync(path.join(smokeRoot, `voice-studio-${page}.png`), image.toPNG());
    }
    const compatibilityButton = await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('#probe-runtime-compatibility');
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        disabled: button.disabled,
        background: style.backgroundColor,
        transform: style.transform
      };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: compatibilityButton.x, y: compatibilityButton.y });
    await new Promise((resolve) => setTimeout(resolve, 220));
    const compatibilityHover = await window.webContents.executeJavaScript(`(() => {
      const style = getComputedStyle(document.querySelector('#probe-runtime-compatibility'));
      return { background: style.backgroundColor, transform: style.transform };
    })()`);
    const compatibilityHoverImage = await window.webContents.capturePage();
    fs.writeFileSync(path.join(smokeRoot, 'voice-studio-settings-compatibility-hover.png'), compatibilityHoverImage.toPNG());
    window.webContents.sendInputEvent({ type: 'mouseDown', x: compatibilityButton.x, y: compatibilityButton.y, button: 'left', clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const compatibilityPressed = await window.webContents.executeJavaScript(`(() => {
      const style = getComputedStyle(document.querySelector('#probe-runtime-compatibility'));
      return { background: style.backgroundColor, transform: style.transform };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseUp', x: compatibilityButton.x, y: compatibilityButton.y, button: 'left', clickCount: 1 });
    const compatibilityFeedback = {
      enabled: !compatibilityButton.disabled,
      hoverChanged: compatibilityHover.background !== compatibilityButton.background,
      pressedChanged: compatibilityPressed.background !== compatibilityHover.background
        || compatibilityPressed.transform !== compatibilityHover.transform
    };
    await window.webContents.executeJavaScript(`document.querySelector('#worker-idle-minutes').value = '17'; document.querySelector('#apply-worker-idle-minutes').click()`);
    await new Promise((resolve) => setTimeout(resolve, 320));
    const storageWatchProbe = path.join(artifactRoot, `.smoke-storage-${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(storageWatchProbe, 'storage watcher probe', 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 650));
    } finally {
      if (exists(storageWatchProbe)) fs.unlinkSync(storageWatchProbe);
    }
    await new Promise((resolve) => setTimeout(resolve, 650));
    await window.webContents.executeJavaScript(`document.querySelector('[data-page="clone"]').click(); document.querySelector('#clone-progress').scrollIntoView({ block: 'center' })`);
    await new Promise((resolve) => setTimeout(resolve, 320));
    const cloneProgressImage = await window.webContents.capturePage();
    fs.writeFileSync(path.join(smokeRoot, 'voice-studio-clone-progress.png'), cloneProgressImage.toPNG());
    await window.webContents.executeJavaScript(`document.querySelector('[data-emotion-mode-choice="custom"]').click(); document.querySelector('[data-emotion-mode-panel="custom"]').scrollIntoView({ block: 'center' }); document.querySelector('[name="emoHappy"]').focus()`);
    await new Promise((resolve) => setTimeout(resolve, 260));
    const cloneManualEmotionImage = await window.webContents.capturePage();
    fs.writeFileSync(path.join(smokeRoot, 'voice-studio-clone-manual-emotion.png'), cloneManualEmotionImage.toPNG());
    await window.webContents.executeJavaScript(`document.querySelector('[data-emotion-mode-choice="text"]').click()`);
    const diagnostics = await window.webContents.executeJavaScript(`({
      title: document.title,
      qwenDisabled: document.querySelector('#design-submit').disabled,
      indexDisabled: document.querySelector('#clone-submit').disabled,
      pageCount: document.querySelectorAll('.page').length,
      taskHistoryReady: Boolean(document.querySelector('#task-history')),
      resourcePanelReady: document.querySelector('#gpu-name').textContent !== '检测中…',
      useAsReferenceReady: Boolean(document.querySelector('#use-as-reference')),
      designExpressionControls: document.querySelectorAll('[form="design-form"].expression-control').length,
      designFineControls: document.querySelectorAll('[form="design-form"].expression-fine-control').length,
      designDescriptionEmpty: document.querySelector('[name="description"]').value === '',
      designPromptGuideInPlaceholder: document.querySelector('[name="description"]').placeholder.includes('PROMPT GUIDE') && document.querySelector('[name="description"]').placeholder.includes('示范描述'),
      designPromptGuidePanelRemoved: !document.querySelector('#page-design .guide-list'),
      designAdvancedReady: Boolean(document.querySelector('[form="design-form"][name="temperature"]') && document.querySelector('[form="design-form"][name="seed"]')),
      designRandomSeedReady: document.querySelector('[form="design-form"][name="seed"]')?.min === '-1' && document.querySelector('[form="design-form"][name="seed"]')?.value === '-1',
      designParameterControlInfoRemoved: ![...document.querySelectorAll('#page-design .info-box')].some((node) => node.textContent.includes('参数控制方式')),
      designCandidateCountReady: document.querySelector('[form="design-form"][name="candidateCount"]')?.options.length === 3,
      designCandidatePanelReady: Boolean(document.querySelector('#design-candidates #candidate-list')),
      cloneControlsReorganized: document.querySelectorAll('#page-clone .clone-controls-panel > details').length === 2
        && Boolean(document.querySelector('#page-clone .clone-emotion-card [name="emotionMode"]')),
      cloneAdvancedReady: ['intervalSilence', 'temperature', 'topP', 'topK', 'repetitionPenalty', 'seed']
        .every((name) => Boolean(document.querySelector('[form="clone-form"][name="' + name + '"]'))),
      cloneEmotionVectorReady: document.querySelectorAll('#clone-form [name^="emo"]').length === 11
        && Boolean(document.querySelector('[form="clone-form"][name="emotionStrength"]'))
        && document.querySelector('#clone-form [name="emotionMode"]')?.value === 'text',
      cloneManualEmotionRangesReady: (() => {
        const ranges = [...document.querySelectorAll('#clone-form [data-emotion-mode-panel="custom"] .emotion-range .precision-range')];
        const focusedStyle = getComputedStyle(ranges[0]);
        return ranges.length === 8 && ranges.every((range) => range.type === 'range' && range.min === '0' && range.max === '1' && range.step === '0.01')
          && ranges.every((range) => Boolean(range.closest('[data-range-control]')?.querySelector('.range-current, .range-edit')))
          && focusedStyle.outlineStyle === 'none' && focusedStyle.boxShadow === 'none' && focusedStyle.borderTopWidth === '0px';
      })(),
      cloneEmotionTextReady: Boolean(document.querySelector('#clone-form [name="emotionText"]')
        && document.querySelector('#clone-form [name="emotionMode"] option[value="text"]')),
      cloneEmotionCardsReady: document.querySelectorAll('#clone-form [data-emotion-mode-choice]').length === 4
        && document.querySelector('#clone-form [data-emotion-mode-choice="text"]')?.classList.contains('active'),
      cloneEmotionOrderReady: [...document.querySelectorAll('#clone-form [data-emotion-mode-choice]')]
        .map((choice) => choice.dataset.emotionModeChoice).join(',') === 'reference,audio,text,custom',
      cloneEmotionAudioReady: Boolean(document.querySelector('#clone-form [data-emotion-mode-choice="audio"]'))
        && Boolean(document.querySelector('#clone-form [data-emotion-mode-panel="audio"]'))
        && Boolean(document.querySelector('#clone-form [name="emotionMode"] option[value="audio"]')),
      cloneEmotionPresetMerged: !document.querySelector('#clone-form [data-emotion-mode-choice="preset"]')
        && Boolean(document.querySelector('#clone-form [data-emotion-mode-panel="custom"] [name="emotionPreset"]')),
      cloneEmotionCardsFunctional: (() => {
        const select = document.querySelector('#clone-form [name="emotionMode"]');
        const referenceChoice = document.querySelector('#clone-form [data-emotion-mode-choice="reference"]');
        const textChoice = document.querySelector('#clone-form [data-emotion-mode-choice="text"]');
        referenceChoice?.click();
        const referenceApplied = select?.value === 'reference'
          && referenceChoice?.classList.contains('active')
          && !document.querySelector('#clone-form [data-emotion-mode-panel="reference"]')?.hidden
          && document.querySelector('[form="clone-form"][name="emotionStrength"]')?.disabled;
        textChoice?.click();
        return Boolean(referenceApplied && select?.value === 'text' && textChoice?.classList.contains('active'));
      })(),
      cloneEmotionProminent: Boolean(document.querySelector('#clone-form > .clone-emotion-card')
        && !document.querySelector('#page-clone .clone-controls-panel [name="emotionMode"]')),
      referenceAnalysisReady: Boolean(document.querySelector('#reference-analysis #reference-metrics')),
        referenceTrimReady: Boolean(document.querySelector('#trim-reference.waveform-trim-toggle')
          && document.querySelector('#reference-trim-panel #apply-trim-reference')
          && document.querySelector('#reference-waveform [data-trim-handle="start"]')
          && document.querySelector('#reference-waveform [data-trim-handle="end"]')
          && document.querySelector('#reference-waveform [data-trim-time="start"]')
          && document.querySelector('#reference-waveform [data-trim-time="end"]')
          && document.querySelector('#reference-waveform [data-trim-editor="start"]')
          && document.querySelector('#reference-waveform [data-trim-editor="end"]')
          && getComputedStyle(document.querySelector('#reference-analysis .trim-controls')).display === 'none'
        && window.voiceStudio.trimReferenceAudio),
      referencePreviewReady: Boolean(document.querySelector('#reference-waveform')
        && document.querySelector('#reference-audio.reference-audio-hidden')
        && document.querySelector('#reference-waveform .vertical-waveform-playhead line')
        && document.querySelector('#play-reference svg') && document.querySelector('#replay-reference svg')
        && document.querySelector('#speed-reference-popover [data-playback-rate="2"]')
        && document.querySelector('#volume-reference-range[type="range"]')
        && document.querySelector('#replace-reference svg') && document.querySelector('#clear-reference svg')
        && !document.querySelector('#reference-preview') && !document.querySelector('#reference-audio[controls]')),
      emotionReferencePreviewReady: Boolean(document.querySelector('#emotion-reference-waveform')
        && document.querySelector('#emotion-reference-audio.reference-audio-hidden')
        && document.querySelector('#emotion-reference-waveform .vertical-waveform-playhead line')
        && document.querySelector('#play-emotion-reference svg') && document.querySelector('#replay-emotion-reference svg')
        && document.querySelector('#speed-emotion-reference-popover [data-playback-rate="2"]')
        && document.querySelector('#volume-emotion-reference-range[type="range"]')
        && !document.querySelector('#emotion-reference-audio[controls]')),
      libraryManagementReady: Boolean(window.voiceStudio.renameVoice && window.voiceStudio.favoriteVoice),
      libraryFilterSortReady: Boolean(document.querySelector('#library-kind-filter') && document.querySelector('#library-sort')),
      resultLibraryPickerReady: Boolean(document.querySelector('#select-library-voice')
        && document.querySelector('#library-voice-picker-list')),
      resultLibraryPickerFunctional: (() => {
        const button = document.querySelector('#select-library-voice');
        const picker = document.querySelector('#library-voice-picker');
        button.click();
        const opened = !picker.classList.contains('hidden') && button.getAttribute('aria-expanded') === 'true';
        document.querySelector('#close-library-voice-picker').click();
        return opened && picker.classList.contains('hidden') && button.getAttribute('aria-expanded') === 'false';
      })(),
      taskRetryReady: Boolean(window.voiceStudio.retryTask),
      precisionRangeCount: document.querySelectorAll('[data-range-control]').length,
      precisionRangeBoundsCount: document.querySelectorAll('[data-range-control] .range-bounds').length,
      precisionRangeEditableCount: document.querySelectorAll('[data-range-control] .range-edit').length,
      descriptionHistoryReady: Boolean(document.querySelector('#description-history-toggle') && document.querySelector('#description-history-list.description-history[role="dialog"]')),
      descriptionHistoryPopoverReady: Boolean(document.querySelector('.description-history-anchor > #description-history-list')),
      inlineTaskRecoveryReady: ['design', 'clone'].every((kind) => Boolean(
        document.querySelector('#' + kind + '-progress-detail')
        && document.querySelector('#' + kind + '-stop')
        && document.querySelector('#' + kind + '-retry')
        && document.querySelector('#' + kind + '-copy-error')))
        && typeof window.voiceStudio.copyText === 'function',
      designInlineHintsRemoved: document.querySelector('#design-progress-detail')?.classList.contains('hidden')
        && !document.querySelector('.description-field > .field-tip'),
      rightPanelTooltipCount: document.querySelectorAll('#page-design .guide-panel .parameter-help[data-tooltip]').length,
      rightPanelPersistentHintsRemoved: !document.querySelector('#page-design .guide-panel .field-tip, #page-design .guide-panel .expression-control-note, #page-design .guide-panel .advanced-note'),
      designRightSectionCount: document.querySelectorAll('#page-design .design-controls-panel > .design-control-section').length,
      designRightControlsContained: (() => {
        const panel = document.querySelector('#page-design .design-controls-panel');
        if (!panel) return false;
        const bounds = panel.getBoundingClientRect();
        return [...panel.querySelectorAll('button, select, input')].every((control) => {
          const rect = control.getBoundingClientRect();
          return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
        });
      })(),
      designAdvancedTwoColumn: (() => {
        const topP = document.querySelector('[form="design-form"][name="topP"]')?.closest('label');
        const topK = document.querySelector('[form="design-form"][name="topK"]')?.closest('label');
        if (!topP || !topK) return false;
        const left = topP.getBoundingClientRect();
        const right = topK.getBoundingClientRect();
        return Math.abs(left.top - right.top) <= 2 && left.right <= right.left + 1;
      })(),
      designCollapsibleSectionCount: document.querySelectorAll('#page-design .design-controls-panel > details.collapsible-control-section').length,
      designCollapseMarkersReady: [...document.querySelectorAll('#page-design .collapsible-control-section > summary')].every((summary) => {
        const content = getComputedStyle(summary, '::before').content;
        return content && content !== 'none' && content !== 'normal';
      }),
      designCollapseFunctional: (() => {
        const sections = [...document.querySelectorAll('#page-design .design-controls-panel > details.collapsible-control-section')];
        if (sections.length !== 3 || sections.some((section) => !section.open)) return false;
        sections[1].querySelector('summary').click();
        const collapsed = !sections[1].open;
        sections[1].querySelector('summary').click();
        return collapsed && sections[1].open;
      })(),
      nonSettingsModelReferences: [...document.querySelectorAll('#page-overview, #page-design, #page-clone, #page-library, #page-tasks, .topbar')].flatMap((node) => node.textContent.match(/Qwen(?:3)?(?:-TTS)?|IndexTTS|VoiceDesign|1\\.7B|2\\.5/gi) || []),
      settingsModelReferencesReady: /Qwen3-TTS/.test(document.querySelector('#qwen-settings').textContent) && /IndexTTS/.test(document.querySelector('#index-settings').textContent),
      workerIdlePolicyReady: document.querySelector('#worker-idle-minutes')?.min === '1'
        && document.querySelector('#worker-idle-minutes')?.max === '120'
        && document.querySelector('#worker-idle-minutes')?.value === '17'
        && Boolean(document.querySelector('#apply-worker-idle-minutes'))
        && typeof window.voiceStudio.setWorkerIdleMinutes === 'function'
        && document.querySelector('#worker-idle-summary')?.textContent.includes('17 分钟'),
      modelLocationControlsReady: ['qwen-settings', 'index-settings'].every((id) => {
        const card = document.getElementById(id);
        return card?.querySelector('.model-location-block code')
          && card.querySelector('.model-location-actions .model-download-start')?.textContent.trim() === '一键下载完整模型'
          && card.querySelector('.model-location-actions .model-download-cancel')?.classList.contains('hidden')
          && card.querySelector('.model-location-actions .model-download-button')?.textContent.trim() === '手动下载 ↗'
          && card.querySelector('.model-download-progress')?.classList.contains('hidden')
          && window.voiceStudio.downloadModel
          && window.voiceStudio.cancelModelDownload;
      }),
      softwareRootOutputReady: /[\\\\/]outputs$/.test(document.querySelector('#artifact-root')?.textContent || ''),
      designProgressReady: document.querySelectorAll('#design-progress [data-design-step]').length === 5,
      cloneProgressReady: document.querySelectorAll('#clone-progress [data-clone-progress-step]').length === 5
        && document.querySelector('#clone-progress-title')?.textContent === '当前没有克隆任务'
        && document.querySelector('#clone-progress')?.dataset.status === 'idle',
      duplicatePageTitlesRemoved: ['design', 'clone', 'library', 'tasks']
        .every((page) => !document.querySelector('#page-' + page + ' h2')),
      resultWaveformIconReady: Boolean(document.querySelector('#result-dock .result-icon svg path')),
      resultSavedStatusRemoved: !document.querySelector('#result-save-status')
        && document.querySelector('#use-as-reference')?.textContent.trim() === '设为参考音频'
        && !document.querySelector('#use-as-reference')?.classList.contains('hidden'),
      resultMetaCompact: !document.querySelector('#result-meta')?.textContent
        || (/^生成日期 .+ · 种子 (?:\\d+|—)$/.test(document.querySelector('#result-meta').textContent)
          && !/上次选择|生成耗时|设计音色|克隆音色/.test(document.querySelector('#result-meta').textContent)),
      libraryRemoveActionRemoved: ![...document.querySelectorAll('#library-list .voice-actions button')]
        .some((button) => button.textContent.trim() === '移除'),
      sidebarToggleReady: Boolean(document.querySelector('#sidebar-toggle')),
      taskDeleteReady: Boolean(document.querySelector('#task-history')),
      storageManagementReady: typeof window.voiceStudio.getStorageStatus === 'function'
        && typeof window.voiceStudio.cleanupStorage === 'function'
        && Boolean(document.querySelector('#storage-summary') && document.querySelector('#cleanup-temporary') && document.querySelector('#cleanup-orphan') && document.querySelector('#cleanup-unsaved')),
      storageAutoSyncReady: typeof window.voiceStudio.onStorageStatusChanged === 'function'
        && window.__storageStatusEventCount >= 2
        && document.querySelector('#storage-temporary')?.textContent.startsWith('0 个文件'),
      storageStatusLoaded: document.querySelector('#storage-saved')?.textContent !== '检测中…',
      parameterPresetRemoved: !document.querySelector('[id*="parameter-preset"], [id*="preset-apply"], [id*="preset-add"], [id*="preset-save"], [id*="preset-delete"]'),
      parameterResetReady: Boolean(document.querySelector('#design-reset-parameters') && document.querySelector('#clone-reset-parameters')),
      parameterResetFunctional: (() => {
        const topK = document.querySelector('[form="design-form"][name="topK"]');
        const duration = document.querySelector('#duration-factor');
        topK.value = '7'; duration.value = '1.6';
        document.querySelector('#design-reset-parameters').click();
        document.querySelector('#clone-reset-parameters').click();
        return topK.value === '50' && duration.value === '1'
          && document.querySelector('#clone-form [name="emotionMode"]').value === 'text'
          && document.querySelector('#clone-form [name="emoCalm"]').value === '0.55';
      })(),
      inlineRenameCount: document.querySelectorAll('.voice-name').length,
      inlineRenameFunctional: (() => {
        const item = document.querySelector('#library-list .voice-item');
        if (!item) return null;
        item.querySelector('.voice-actions button:nth-child(2)').click();
        const editor = item.querySelector('.voice-name');
        const opened = editor.dataset.editing === 'true' && editor.isContentEditable;
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return opened && !editor.isContentEditable && !editor.hasAttribute('data-editing');
      })(),
      historicalSelectableCount: document.querySelectorAll('#task-history .history-item.selectable').length,
      historicalInlineAudioCount: document.querySelectorAll('#task-history audio').length,
      historicalCandidateGroupCount: document.querySelectorAll('#task-history .candidate-choices').length,
      lastSelectionPresentAtStart: Boolean(localStorage.getItem('voiceStudio.lastSelection.v1')),
      historicalSelectionFunctional: (() => {
        const item = document.querySelector('#task-history .history-item.selectable');
        if (!item) return null;
        item.click();
        return item.classList.contains('selected-result') && !document.querySelector('#result-dock').classList.contains('hidden');
      })(),
      selectionPersistedAfterTaskClick: Boolean(localStorage.getItem('voiceStudio.lastSelection.v1')),
      parameterPresetPersistenceRemoved: !localStorage.getItem('voiceStudio.parameterPreset.selected.design.v1')
        && !localStorage.getItem('voiceStudio.parameterPreset.selected.clone.v1'),
      cloneSpeedLabel: document.querySelector('#duration-value')?.textContent,
      errors: window.__voiceStudioErrors || []
    })`);
    diagnostics.unsavedResultFileCountAtStartup = storageInventory().summary.unsaved.count;
    diagnostics.compatibilityFeedback = compatibilityFeedback;
    const resultDockImage = await window.webContents.capturePage();
    fs.writeFileSync(path.join(smokeRoot, 'voice-studio-result-dock.png'), resultDockImage.toPNG());
    window.setSize(1100, 900);
    await window.webContents.executeJavaScript(`document.querySelector('[data-page="clone"]').click()`);
    await new Promise((resolve) => setTimeout(resolve, 350));
    Object.assign(diagnostics, await window.webContents.executeJavaScript(`({
      responsiveWidth: innerWidth,
      responsiveCloneControlsVisible: getComputedStyle(document.querySelector('#page-clone .clone-controls-panel')).display !== 'none',
      responsiveCloneControlsRight: (() => {
        const form = document.querySelector('#page-clone .form-panel').getBoundingClientRect();
        const controls = document.querySelector('#page-clone .clone-controls-panel').getBoundingClientRect();
        return controls.left >= form.right + 10;
      })(),
      responsiveResultActionsVisible: getComputedStyle(document.querySelector('#result-dock .result-actions')).display !== 'none',
      responsiveControlsContained: (() => {
        const bodyRight = document.documentElement.clientWidth;
        return [...document.querySelectorAll('#page-clone button, #page-clone input, #page-clone select')].every((control) => {
          const rect = control.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= bodyRight + 1;
        });
      })()
    })`));
    const responsiveImage = await window.webContents.capturePage();
    fs.writeFileSync(path.join(smokeRoot, 'voice-studio-responsive-1100.png'), responsiveImage.toPNG());
    await new Promise((resolve) => {
      window.webContents.once('did-finish-load', resolve);
      window.webContents.reloadIgnoringCache();
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    diagnostics.selectionRestoredAfterReload = await window.webContents.executeJavaScript(`Boolean(
      localStorage.getItem('voiceStudio.lastSelection.v1')
      && !document.querySelector('#result-dock').classList.contains('hidden')
      && document.querySelector('#result-audio').src
      && document.querySelector('#task-history .history-item.selected-result')
    )`);
    diagnostics.parameterPresetAbsentAfterReload = await window.webContents.executeJavaScript(`Boolean(
      !document.querySelector('[id*="parameter-preset"], [id*="preset-apply"], [id*="preset-add"], [id*="preset-save"], [id*="preset-delete"]')
      && document.querySelector('#clone-form > .clone-emotion-card')
    )`);
    diagnostics.errorsAfterReload = await window.webContents.executeJavaScript(`window.__voiceStudioErrors || []`);
    fs.writeFileSync(path.join(smokeRoot, 'voice-studio.json'), JSON.stringify(diagnostics, null, 2));
    setTimeout(() => app.quit(), 600);
  }
}

const singleInstance = process.argv.includes('--smoke') || app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(async () => {
    recoverInterruptedTasks();
    const discarded = await cleanupStorage({ scope: 'unsaved' });
    if (discarded.removedCount) console.log(`Discarded ${discarded.removedCount} unsaved result file(s) from the previous session`);
    return createWindow();
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
let quitCleanupStarted = false;
let quitCleanupFinished = false;
app.on('before-quit', (event) => {
  for (const worker of workers.values()) worker.stopSync();
  clearTimeout(storageBroadcastTimer);
  storageBroadcastTimer = null;
  storageWatcher?.close();
  storageWatcher = null;
  activeModelDownload?.controller.abort(new Error('应用正在关闭'));
  if (quitCleanupFinished) return;
  event.preventDefault();
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  cleanupStorage({ scope: 'unsaved' })
    .catch((error) => console.error('Failed to discard unsaved voice results:', error))
    .finally(() => {
      quitCleanupFinished = true;
      app.quit();
    });
});
app.on('window-all-closed', () => app.quit());
