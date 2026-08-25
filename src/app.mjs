const titles = { overview: '工作台', design: '音色设计', clone: '音色克隆', library: '音色库', tasks: '任务队列', settings: '引擎设置' };
window.__voiceStudioErrors = [];
window.addEventListener('error', (event) => window.__voiceStudioErrors.push(String(event.error?.stack || event.message)));
window.addEventListener('unhandledrejection', (event) => window.__voiceStudioErrors.push(String(event.reason?.stack || event.reason)));
const state = {
  bootstrap: null, reference: null, emotionReference: null, result: null, candidates: [], library: [], tasks: [], descriptionHistory: [], storage: null, logs: [],
  libraryQuery: '', libraryKind: 'all', librarySort: 'favorite',
  referenceTrim: { active: false, startSeconds: 0, endSeconds: 0, dragging: null },
  progressErrors: { qwen: '', index: '' },
  runtimeInstall: { status: 'idle', stage: 'idle', percent: 0, message: '', received: 0, total: 0 },
  runtimeProbe: { status: 'idle' },
  modelDownloads: {
    qwen: { stage: 'idle', percent: 0, received: 0, total: 0, message: '' },
    index: { stage: 'idle', percent: 0, received: 0, total: 0, message: '' }
  }
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const designStages = ['prepare', 'queued', 'loading_model', 'synthesizing', 'completed'];
const cloneStages = ['prepare', 'queued', 'loading_model', 'synthesizing', 'completed'];
const lastSelectionKey = 'voiceStudio.lastSelection.v1';
const systemStatusSnapshotKey = 'voiceStudio.systemStatus.v1';
const storageStatusSnapshotKey = 'voiceStudio.storageStatus.v1';
const designParameterDefaults = Object.freeze({
  pace: 'relaxed', volume: 'normal', paceFactor: 0.85, volumeFactor: 1,
  temperature: 0.9, topP: 1, topK: 50, repetitionPenalty: 1.05, seed: -1, candidateCount: 1
});
const cloneParameterDefaults = Object.freeze({
  emotionMode: 'text', emotionText: '', emotionPreset: 'custom', emotionStrength: 1, durationFactor: 1,
  emoHappy: 0, emoAngry: 0, emoSad: 0, emoAfraid: 0, emoDisgusted: 0, emoMelancholic: 0, emoSurprised: 0, emoCalm: 0.55,
  intervalSilence: 200, temperature: 0.8, topP: 0.8, topK: 30, repetitionPenalty: 10, seed: -1
});
const cloneEmotionPresets = Object.freeze({
  neutral: Object.freeze({ emoHappy: 0, emoAngry: 0, emoSad: 0, emoAfraid: 0, emoDisgusted: 0, emoMelancholic: 0, emoSurprised: 0, emoCalm: 0.55 }),
  warm: Object.freeze({ emoHappy: 0.08, emoAngry: 0, emoSad: 0, emoAfraid: 0, emoDisgusted: 0, emoMelancholic: 0, emoSurprised: 0.08, emoCalm: 0.46 }),
  happy: Object.freeze({ emoHappy: 0.72, emoAngry: 0, emoSad: 0, emoAfraid: 0, emoDisgusted: 0, emoMelancholic: 0, emoSurprised: 0.10, emoCalm: 0.18 }),
  concerned: Object.freeze({ emoHappy: 0, emoAngry: 0, emoSad: 0.20, emoAfraid: 0.04, emoDisgusted: 0, emoMelancholic: 0, emoSurprised: 0.05, emoCalm: 0.55 }),
  playful: Object.freeze({ emoHappy: 0.48, emoAngry: 0, emoSad: 0, emoAfraid: 0, emoDisgusted: 0, emoMelancholic: 0, emoSurprised: 0.22, emoCalm: 0.20 })
});
for (const key of Object.keys(localStorage)) {
  if (key.startsWith('voiceStudio.parameterPreset') || key.startsWith('voiceStudio.parameterPresets')) localStorage.removeItem(key);
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function showPage(name) {
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === name));
  $$('.page').forEach((page) => page.classList.toggle('active', page.id === `page-${name}`));
  $('#page-title').textContent = titles[name] ?? '音色工坊';
  closeDescriptionHistory();
}

function appendLog(message) {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  state.logs.push(`[${stamp}] ${message}`);
  state.logs = state.logs.slice(-120);
  $('#log-view').textContent = state.logs.join('\n');
  $('#log-view').scrollTop = $('#log-view').scrollHeight;
}

function setTaskStatus(title, subtitle, running = true) {
  const root = $('#task-status');
  root.querySelector('b').textContent = title;
  root.querySelector('span').textContent = subtitle;
  root.querySelector('.spinner').classList.toggle('idle', !running);
}

function sameOutput(left, right) {
  return Boolean(left && right) && String(left).toLocaleLowerCase() === String(right).toLocaleLowerCase();
}

function syncResultSaveState() {
  if (!state.result) return;
  const saved = state.library.find((voice) => sameOutput(voice.output, state.result.output)) ?? null;
  state.result.savedVoiceId = saved?.id ?? null;
  const button = $('#save-result');
  button.disabled = Boolean(saved);
  button.textContent = '保存到音色库';
  button.classList.toggle('hidden', Boolean(saved));
}

function clearPersistedSelection() {
  localStorage.removeItem(lastSelectionKey);
}

function restoreLastSelection() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(lastSelectionKey)); } catch { clearPersistedSelection(); return; }
  if (!saved?.output) return;
  const result = state.library.find((voice) => voice.url && sameOutput(voice.output, saved.output));
  if (!result) { clearPersistedSelection(); return; }
  const kind = saved.kind === 'clone' || result.kind === 'clone' || result.engine === 'index' ? 'clone' : 'design';
  setResult(result, saved.name || result.name || '已保存音色', kind, '音色库', false);
}

function normalizeProgressStage(stage, inferredStage) {
  if (stage === 'model_ready' || stage === 'emotion_ready') return 'loading_model';
  if (stage === 'analyzing_emotion') return 'prepare';
  return stage || inferredStage;
}

function syncInlineProgressControls(engine, status, detail = '') {
  const kind = engine === 'qwen' ? 'design' : 'clone';
  const running = status === 'running';
  const failed = status === 'failed';
  const retryable = failed || status === 'cancelled';
  $(`#${kind}-stop`).classList.toggle('hidden', !running);
  $(`#${kind}-retry`).classList.toggle('hidden', !retryable);
  $(`#${kind}-copy-error`).classList.toggle('hidden', !failed || !detail);
  const detailNode = $(`#${kind}-progress-detail`);
  detailNode.textContent = detail;
  detailNode.classList.toggle('hidden', !detail || !retryable);
  if (failed) state.progressErrors[engine] = detail;
  else if (status === 'running' || status === 'completed') state.progressErrors[engine] = '';
}

function setDesignProgress(percent, title, detail = '', status = 'running', stage = null) {
  const normalized = Math.max(0, Math.min(100, Number(percent) || 0));
  const root = $('#design-progress');
  const inferredStage = normalized >= 100 || status === 'completed'
    ? 'completed'
    : normalized >= 55 ? 'synthesizing' : normalized >= 12 ? 'loading_model' : normalized >= 5 ? 'queued' : 'prepare';
  const normalizedStage = normalizeProgressStage(stage, inferredStage);
  const currentStage = designStages.includes(normalizedStage) ? normalizedStage : (status === 'running' ? inferredStage : root.dataset.stage || inferredStage);
  root.dataset.status = status;
  root.dataset.stage = currentStage;
  $('#design-progress-title').textContent = title;
  const indeterminate = status === 'running' && ['loading_model', 'synthesizing'].includes(currentStage);
  root.classList.toggle('indeterminate', indeterminate);
  $('#design-progress-value').textContent = indeterminate ? '运行中' : `${Math.round(normalized)}%`;
  const activeIndex = designStages.indexOf(currentStage);
  $$('[data-design-step]').forEach((step, index) => {
    step.classList.toggle('completed', status === 'completed' || index < activeIndex);
    step.classList.toggle('active', status !== 'completed' && index === activeIndex);
    step.classList.toggle('error', ['failed', 'cancelled'].includes(status) && index === activeIndex);
    if (status !== 'completed' && index === activeIndex) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
  syncInlineProgressControls('qwen', status, detail);
}

function setCloneProgress(percent, title, detail = '', status = 'running', stage = null) {
  const normalized = Math.max(0, Math.min(100, Number(percent) || 0));
  const root = $('#clone-progress');
  const inferredStage = normalized >= 100 || status === 'completed'
    ? 'completed'
    : normalized >= 55 ? 'synthesizing' : normalized >= 12 ? 'loading_model' : normalized >= 5 ? 'queued' : 'prepare';
  const normalizedStage = normalizeProgressStage(stage, inferredStage);
  const currentStage = cloneStages.includes(normalizedStage) ? normalizedStage : (status === 'running' ? inferredStage : root.dataset.stage || inferredStage);
  root.dataset.status = status;
  root.dataset.stage = currentStage;
  $('#clone-progress-title').textContent = title;
  const indeterminate = status === 'running' && ['loading_model', 'synthesizing'].includes(currentStage);
  root.classList.toggle('indeterminate', indeterminate);
  $('#clone-progress-value').textContent = indeterminate ? '运行中' : `${Math.round(normalized)}%`;
  const activeIndex = cloneStages.indexOf(currentStage);
  $$('[data-clone-progress-step]').forEach((step, index) => {
    step.classList.toggle('completed', status === 'completed' || index < activeIndex);
    step.classList.toggle('active', status !== 'completed' && index === activeIndex);
    step.classList.toggle('error', ['failed', 'cancelled'].includes(status) && index === activeIndex);
    if (status !== 'completed' && index === activeIndex) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
  syncInlineProgressControls('index', status, detail);
}

function setSidebarCollapsed(collapsed) {
  const shell = $('.app-shell');
  const toggle = $('#sidebar-toggle');
  shell.classList.toggle('sidebar-collapsed', collapsed);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', collapsed ? '展开侧边栏' : '收起侧边栏');
  toggle.title = collapsed ? '展开侧边栏' : '收起侧边栏';
  toggle.querySelector('span').textContent = collapsed ? '›' : '‹';
  localStorage.setItem('voiceStudio.sidebarCollapsed', collapsed ? '1' : '0');
}

function closeDescriptionHistory() {
  const list = $('#description-history-list');
  const toggle = $('#description-history-toggle');
  if (!list || !toggle) return;
  list.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
}

function setEnginePill(element, installed) {
  element.classList.toggle('ready', installed);
  element.classList.toggle('offline', !installed);
}

function renderEngineSettings() {
  const { qwen, index, runtime } = state.bootstrap.engines;
  $('#runtime-settings').replaceChildren(runtimeCard(runtime));
  $('#qwen-settings').replaceChildren(engineCard('QWEN3-TTS', qwen.label, qwen, 'qwen'));
  $('#index-settings').replaceChildren(engineCard('INDEXTTS', index.label, index, 'index'));
  $('#artifact-root').textContent = state.bootstrap.artifactRoot;
}

function syncEngineAvailability() {
  const { qwen, index } = state.bootstrap.engines;
  setEnginePill($('#qwen-pill'), qwen.installed);
  setEnginePill($('#index-pill'), index.installed);
  $('#design-submit').disabled = !qwen.installed;
  $('#clone-submit').disabled = !index.installed;
  const qwenNotice = $('#qwen-notice');
  qwenNotice.textContent = qwen.installed ? '本地音色设计引擎已就绪' : '音色设计引擎尚未安装；请前往“引擎设置”查看详情。';
  qwenNotice.classList.toggle('ready', qwen.installed);
  qwenNotice.classList.toggle('offline', !qwen.installed);
}

async function probeRuntimeInBackground() {
  try {
    const result = await window.voiceStudio.probeRuntime();
    state.bootstrap.engines = result.engines;
    state.runtimeProbe.status = 'idle';
    syncEngineAvailability();
    renderEngineSettings();
    appendLog(result.runtime.compatible ? '运行环境：后台兼容性检测通过' : `运行环境：后台检测未通过（${result.runtime.error || '版本或 CUDA 状态不符合要求'}）`);
  } catch (error) {
    state.runtimeProbe.status = 'failed';
    renderEngineSettings();
    appendLog(`运行环境：后台检测失败（${error.message}）`);
  }
}

function runtimeCard(runtime) {
  const fragment = document.createDocumentFragment();
  const marker = document.createElement('p'); marker.className = 'eyebrow'; marker.textContent = 'SHARED RUNTIME';
  const heading = document.createElement('h3'); heading.textContent = '运行环境';
  const detail = document.createElement('div'); detail.className = 'runtime-detail';
  const stateLabel = document.createElement('b');
  const compatible = runtime?.compatible;
  const checking = state.runtimeProbe.status === 'checking';
  stateLabel.textContent = !runtime?.ready ? '尚未检测到运行环境' : checking ? '已发现，正在后台确认兼容性' : compatible === false ? '环境不兼容' : compatible === true ? '环境兼容' : '已发现，可检测兼容性';
  stateLabel.style.color = compatible === true ? '#72deb0' : compatible === false ? '#ff9aa5' : '#e1bd86';
  const requirement = document.createElement('span'); requirement.textContent = runtime?.python || '需要 Python 3.11、PyTorch 2.8 CUDA 12.8 与 Torchaudio 2.8';
  detail.append(stateLabel, requirement);
  const locations = document.createElement('div'); locations.className = 'runtime-locations';
  const managedLocation = document.createElement('p');
  managedLocation.innerHTML = '<b>受管运行环境位置</b>';
  const managedCode = document.createElement('code'); managedCode.textContent = runtime?.managedRuntimeRoot || '尚未确定';
  managedLocation.append(managedCode);
  const engineLocation = document.createElement('p');
  engineLocation.innerHTML = '<b>引擎依赖位置</b>';
  const engineCode = document.createElement('code'); engineCode.textContent = runtime?.engineRoot || '尚未确定';
  engineLocation.append(engineCode);
  locations.append(managedLocation, engineLocation);
  const actions = document.createElement('div'); actions.className = 'runtime-actions';
  const detect = document.createElement('button'); detect.type = 'button'; detect.className = 'secondary small'; detect.textContent = checking ? '检测中…' : runtime?.compatible === null || runtime?.compatible === undefined ? '检测兼容性' : '重新检测';
  detect.title = '重新检查 Python、PyTorch、Torchaudio 与 CUDA 兼容性';
  detect.disabled = !runtime?.ready || checking;
  detect.classList.toggle('is-working', checking);
  detect.setAttribute('aria-busy', String(checking));
  detect.addEventListener('click', async () => {
    setButtonWorking(detect, true, '检测中…');
    try {
      const result = await window.voiceStudio.probeRuntime();
      state.bootstrap.engines = result.engines;
      renderEngineSettings();
      showToast(result.runtime.compatible ? '运行环境检测通过' : `环境不兼容：${result.runtime.error || '版本或 CUDA 状态不符合要求'}`);
    } catch (error) { showToast(`检测失败：${error.message}`); }
    finally { setButtonWorking(detect, false); }
  });
  const add = document.createElement('button'); add.type = 'button'; add.className = 'secondary small'; add.textContent = '添加环境位置';
  add.addEventListener('click', async () => {
    setButtonWorking(add, true, '选择中…');
    try {
      const result = await window.voiceStudio.addRuntimeLocation();
      if (result) {
        state.bootstrap.engines = result.engines;
        renderEngineSettings();
        showToast(result.runtime.compatible ? '运行环境已添加并通过检测' : `已添加，但不兼容：${result.runtime.error || '请检查版本和 CUDA'}`);
      }
    } catch (error) { showToast(`添加失败：${error.message}`); }
    finally { setButtonWorking(add, false); }
  });
  const install = document.createElement('button'); install.id = 'install-runtime'; install.type = 'button'; install.className = 'primary small';
  const installRunning = state.runtimeInstall.status === 'running';
  install.textContent = installRunning ? `正在安装 ${state.runtimeInstall.percent}%` : '安装运行环境';
  install.disabled = installRunning;
  install.addEventListener('click', async () => {
    updateRuntimeInstallProgress({ stage: 'preparing', percent: 0, message: '正在准备安装运行环境' });
    try {
      const result = await window.voiceStudio.installRuntime();
      if (result) {
        state.bootstrap.engines = result.engines;
        renderEngineSettings();
        showToast(result.runtime.compatible ? '运行环境安装完成' : `安装完成，但检测未通过：${result.runtime.error || '请查看环境状态'}`);
      }
    } catch (error) {
      const message = normalizeRemoteError(error);
      updateRuntimeInstallProgress({ stage: 'failed', percent: 0, message });
      showToast(`安装失败：${message}`);
    }
  });
  actions.append(install, detect, add);
  const grid = document.createElement('div'); grid.className = 'runtime-grid'; grid.append(detail, actions);
  const progress = document.createElement('div'); progress.id = 'runtime-install-progress'; progress.className = 'runtime-install-progress';
  progress.classList.toggle('hidden', state.runtimeInstall.status === 'idle' || state.runtimeInstall.status === 'completed');
  progress.classList.toggle('failed', state.runtimeInstall.status === 'failed');
  progress.classList.toggle('completed', state.runtimeInstall.status === 'completed');
  const progressHeader = document.createElement('div'); progressHeader.className = 'runtime-progress-head';
  const progressMessage = document.createElement('b'); progressMessage.id = 'runtime-progress-message'; progressMessage.textContent = state.runtimeInstall.message || '准备安装';
  const progressValue = document.createElement('output'); progressValue.id = 'runtime-progress-value'; progressValue.textContent = `${state.runtimeInstall.percent}%`;
  progressHeader.append(progressMessage, progressValue);
  const progressBar = document.createElement('progress'); progressBar.id = 'runtime-progress-bar'; progressBar.max = 100; progressBar.value = state.runtimeInstall.percent;
  const progressDetail = document.createElement('small'); progressDetail.id = 'runtime-progress-detail'; progressDetail.textContent = runtimeProgressDetail(state.runtimeInstall);
  progress.append(progressHeader, progressBar, progressDetail);
  fragment.append(marker, heading, grid);
  if (['debug', 'alpha'].includes(state.bootstrap?.build?.channel)) fragment.append(locations);
  fragment.append(progress);
  return fragment;
}

function setButtonWorking(button, working, workingLabel = '处理中…') {
  if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
  button.disabled = working;
  button.classList.toggle('is-working', working);
  button.setAttribute('aria-busy', String(working));
  button.textContent = working ? workingLabel : button.dataset.idleLabel;
}

function normalizeRemoteError(error) {
  return String(error?.message || error || '运行环境安装失败')
    .replace(/^Error invoking remote method 'studio:install-runtime': Error:\s*/i, '')
    .replace(/^Error:\s*/i, '');
}

function runtimeProgressDetail(progress) {
  if (progress.total > 0 && progress.received >= 0 && ['downloading', 'verifying'].includes(progress.stage)) {
    return `${formatBytes(progress.received)} / ${formatBytes(progress.total)}`;
  }
  const labels = {
    preparing: '准备资源清单与安装目录', downloading: '下载运行环境资源', verifying: '校验下载文件完整性',
    extracting: '解压并安装运行环境', finalizing: '提交安装结果', checking: '检测 Python、PyTorch 与 CUDA', cleaning: '删除已下载的压缩文件',
    completed: '安装与兼容性检测已完成', failed: '安装已停止，请根据错误信息重试'
  };
  return labels[progress.stage] || '';
}

function updateRuntimeInstallProgress(event) {
  const stage = event?.stage || 'preparing';
  const percent = Math.max(0, Math.min(100, Number(event?.percent) || 0));
  state.runtimeInstall = {
    status: stage === 'completed' ? 'completed' : stage === 'failed' ? 'failed' : 'running',
    stage,
    percent,
    message: event?.message || '正在安装运行环境',
    received: Number(event?.received) || 0,
    total: Number(event?.total) || 0
  };
  const root = $('#runtime-install-progress');
  if (!root) return;
  root.classList.toggle('hidden', stage === 'completed');
  root.classList.toggle('failed', state.runtimeInstall.status === 'failed');
  root.classList.toggle('completed', state.runtimeInstall.status === 'completed');
  $('#runtime-progress-message').textContent = state.runtimeInstall.message;
  $('#runtime-progress-value').textContent = `${percent}%`;
  $('#runtime-progress-bar').value = percent;
  $('#runtime-progress-detail').textContent = runtimeProgressDetail(state.runtimeInstall);
  const install = $('#install-runtime');
  if (install) {
    install.disabled = state.runtimeInstall.status === 'running';
    install.classList.toggle('is-working', state.runtimeInstall.status === 'running');
    install.setAttribute('aria-busy', String(state.runtimeInstall.status === 'running'));
    install.textContent = state.runtimeInstall.status === 'running' ? `正在安装 ${percent}%` : '安装运行环境';
  }
}

function applyModelLocationResult(result, message) {
  if (!result) return;
  state.bootstrap.engines = result.engines;
  state.bootstrap.modelLocations = result.modelLocations;
  const { qwen, index } = result.engines;
  setEnginePill($('#qwen-pill'), qwen.installed);
  setEnginePill($('#index-pill'), index.installed);
  $('#design-submit').disabled = !qwen.installed;
  $('#clone-submit').disabled = !index.installed;
  const qwenNotice = $('#qwen-notice');
  qwenNotice.textContent = qwen.installed ? '本地音色设计引擎已就绪' : '音色设计引擎尚未安装；请前往“引擎设置”查看详情。';
  qwenNotice.classList.toggle('ready', qwen.installed);
  qwenNotice.classList.toggle('offline', !qwen.installed);
  renderEngineSettings();
  if (message) showToast(message);
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function modelDownloadRunning(download) {
  return ['planning', 'downloading', 'verifying'].includes(download?.stage);
}

function modelDownloadProgressHidden(download) {
  return ['idle', 'completed'].includes(download?.stage);
}

function modelDownloadProgressView(engineKey) {
  const download = state.modelDownloads[engineKey];
  const root = document.createElement('div'); root.className = 'model-download-progress'; root.id = `${engineKey}-model-download-progress`;
  root.classList.toggle('hidden', modelDownloadProgressHidden(download));
  root.classList.toggle('failed', download.stage === 'failed');
  root.classList.toggle('completed', download.stage === 'completed');
  const head = document.createElement('div'); head.className = 'model-download-progress-head';
  const message = document.createElement('b'); message.id = `${engineKey}-model-download-message`; message.textContent = download.message || '准备模型下载';
  const value = document.createElement('output'); value.id = `${engineKey}-model-download-value`; value.textContent = download.stage === 'planning' ? '读取清单' : `${Math.round(download.percent || 0)}%`;
  head.append(message, value);
  const progress = document.createElement('progress'); progress.id = `${engineKey}-model-download-bar`; progress.max = 100; progress.value = download.percent || 0;
  const detail = document.createElement('small'); detail.id = `${engineKey}-model-download-detail`;
  detail.textContent = download.total > 0
    ? `${formatBytes(download.received)} / ${formatBytes(download.total)}${download.fileCount ? ` · ${download.fileIndex || 0}/${download.fileCount} 个文件` : ''}`
    : '正在连接模型下载源…';
  root.append(head, progress, detail);
  return root;
}

function updateModelDownloadProgress(event) {
  if (!['qwen', 'index'].includes(event?.engine)) return;
  const previous = state.modelDownloads[event.engine];
  state.modelDownloads[event.engine] = {
    ...previous,
    ...event,
    percent: Math.max(0, Math.min(100, Number(event.percent) || 0)),
    received: Math.max(0, Number(event.received) || 0),
    total: Math.max(0, Number(event.total) || 0)
  };
  const download = state.modelDownloads[event.engine];
  const root = $(`#${event.engine}-model-download-progress`);
  if (root) {
    root.classList.toggle('hidden', modelDownloadProgressHidden(download));
    root.classList.toggle('failed', download.stage === 'failed');
    root.classList.toggle('completed', download.stage === 'completed');
    $(`#${event.engine}-model-download-message`).textContent = download.message || '正在处理模型';
    $(`#${event.engine}-model-download-value`).textContent = download.stage === 'planning' ? '读取清单' : `${Math.round(download.percent)}%`;
    $(`#${event.engine}-model-download-bar`).value = download.percent;
    $(`#${event.engine}-model-download-detail`).textContent = download.total > 0
      ? `${formatBytes(download.received)} / ${formatBytes(download.total)}${download.fileCount ? ` · ${download.fileIndex || 0}/${download.fileCount} 个文件` : ''}`
      : download.stage === 'failed' ? '保留了未完成文件，下次可继续下载' : '正在连接模型下载源…';
  }
  const anyRunning = Object.values(state.modelDownloads).some(modelDownloadRunning);
  $$('.model-download-start').forEach((button) => {
    const own = button.dataset.engine === event.engine && modelDownloadRunning(download);
    button.disabled = anyRunning;
    button.classList.toggle('is-working', own);
    button.textContent = own ? (download.stage === 'planning' ? '读取清单…' : `下载中 ${Math.round(download.percent)}%`) : '一键下载完整模型';
  });
  $$('.model-download-cancel').forEach((button) => button.classList.toggle('hidden', !(button.dataset.engine === event.engine && modelDownloadRunning(download))));
}

function renderStorage(storage) {
  state.storage = storage;
  const entries = [
    ['saved', '#storage-saved', '#cleanup-saved'],
    ['unsaved', '#storage-unsaved', '#cleanup-unsaved'],
    ['temporary', '#storage-temporary', '#cleanup-temporary'],
    ['orphan', '#storage-orphan', '#cleanup-orphan']
  ];
  for (const [key, selector, buttonSelector] of entries) {
    const metric = storage?.[key] ?? { count: 0, bytes: 0 };
    $(selector).textContent = `${metric.count} 个文件 · ${formatBytes(metric.bytes)}`;
    const button = $(buttonSelector);
    if (button) button.disabled = metric.count === 0;
  }
  try { localStorage.setItem(storageStatusSnapshotKey, JSON.stringify(storage)); } catch { /* optional cache */ }
}

async function refreshStorage() {
  try { renderStorage(await window.voiceStudio.getStorageStatus()); }
  catch (error) { showToast(`读取存储信息失败：${error.message}`); }
}

function engineCard(eyebrow, title, engine, engineKey) {
  const fragment = document.createDocumentFragment();
  const marker = document.createElement('p'); marker.className = 'eyebrow'; marker.textContent = eyebrow;
  const heading = document.createElement('h3'); heading.textContent = title;
  const status = document.createElement('div'); status.className = 'status-row';
  const purpose = document.createElement('span'); purpose.textContent = engine.purpose;
  const value = document.createElement('b'); value.textContent = engine.installed ? '已就绪' : '尚未安装';
  value.style.color = engine.installed ? '#72deb0' : '#e1bd86'; status.append(purpose, value);
  const location = document.createElement('div'); location.className = 'model-location-block';
  const locationHead = document.createElement('div'); locationHead.className = 'model-location-head';
  const locationLabel = document.createElement('b'); locationLabel.textContent = '当前模型位置';
  const source = document.createElement('span'); source.textContent = engine.modelPathSource;
  locationHead.append(locationLabel, source);
  const code = document.createElement('code'); code.textContent = engine.modelPath;
  const defaultPath = document.createElement('small'); defaultPath.textContent = `默认：${engine.defaultModelPath}`;
  location.append(locationHead, code, defaultPath);
  const detail = document.createElement('p'); detail.textContent = engine.installed ? '模型文件检测通过；生成时进入单 GPU 队列。' : '未在已知位置检测到完整模型；可自动检测或手动添加模型目录。';
  const actions = document.createElement('div'); actions.className = 'model-location-actions';
  const detect = document.createElement('button'); detect.type = 'button'; detect.className = 'secondary small'; detect.textContent = '自动检测';
  detect.addEventListener('click', async () => {
    setButtonWorking(detect, true, '检测中…');
    try { applyModelLocationResult(await window.voiceStudio.detectModels(), '模型位置检测完成'); }
    catch (error) { showToast(`检测失败：${error.message}`); }
    finally { setButtonWorking(detect, false); }
  });
  const add = document.createElement('button'); add.type = 'button'; add.className = 'secondary small'; add.textContent = '添加位置';
  add.addEventListener('click', async () => {
    setButtonWorking(add, true, '选择中…');
    try {
      const result = await window.voiceStudio.addModelLocation(engineKey);
      if (result) applyModelLocationResult(result, '模型位置已添加');
    } catch (error) { showToast(`添加失败：${error.message}`); }
    finally { setButtonWorking(add, false); }
  });
  const modelDownload = state.modelDownloads[engineKey];
  const download = document.createElement('button'); download.type = 'button'; download.className = 'primary small model-download-start'; download.dataset.engine = engineKey; download.textContent = modelDownloadRunning(modelDownload) ? `下载中 ${Math.round(modelDownload.percent)}%` : '一键下载完整模型';
  download.title = engineKey === 'index' ? '下载 IndexTTS 2.5 主模型及全部必需辅助模型' : '下载完整 Qwen VoiceDesign 模型';
  download.disabled = Object.values(state.modelDownloads).some(modelDownloadRunning);
  download.classList.toggle('is-working', modelDownloadRunning(modelDownload));
  download.addEventListener('click', async () => {
    updateModelDownloadProgress({ engine: engineKey, stage: 'planning', percent: 0, received: 0, total: 0, message: '正在获取完整模型清单' });
    try {
      const result = await window.voiceStudio.downloadModel(engineKey);
      if (result && !result.cancelled) {
        applyModelLocationResult(result, '完整模型下载并校验完成');
      }
    } catch (error) {
      const message = String(error?.message || error).replace(/^Error invoking remote method 'studio:download-model': Error:\s*/i, '');
      updateModelDownloadProgress({ engine: engineKey, stage: 'failed', percent: 0, message });
      showToast(`模型下载失败：${message}`);
    }
  });
  const cancelDownload = document.createElement('button'); cancelDownload.type = 'button'; cancelDownload.className = 'danger small model-download-cancel'; cancelDownload.dataset.engine = engineKey; cancelDownload.textContent = '取消下载';
  cancelDownload.classList.toggle('hidden', !modelDownloadRunning(modelDownload));
  cancelDownload.addEventListener('click', async () => { await window.voiceStudio.cancelModelDownload(engineKey); });
  const external = document.createElement('button'); external.type = 'button'; external.className = 'secondary small model-download-button'; external.textContent = '手动下载 ↗';
  external.title = '在浏览器中打开官方模型页面，手动下载模型';
  external.addEventListener('click', async () => {
    setButtonWorking(external, true, '正在打开…');
    try { await window.voiceStudio.openModelDownload(engine.modelDownloadUrl); }
    catch (error) { showToast(`打开失败：${error.message}`); }
    finally { setButtonWorking(external, false); }
  });
  actions.append(detect, add, download, cancelDownload, external);
  fragment.append(marker, heading, status, location, detail, actions, modelDownloadProgressView(engineKey));
  return fragment;
}

function renderReferenceAnalysis(reference) {
  const analysis = reference?.analysis;
  const root = $('#reference-analysis');
  if (!analysis) { root.classList.add('hidden'); return; }
  root.classList.remove('hidden');
  const ready = analysis.status === 'ready';
  $('#reference-quality-title').textContent = ready ? '参考音频基础检查通过' : '参考音频建议优化';
  $('#reference-quality-summary').textContent = `${analysis.durationSeconds.toFixed(2)} 秒 · ${analysis.sampleRate || '?'} Hz · ${analysis.channels || '?'} 声道`;
  const badge = $('#reference-quality-badge');
  badge.textContent = ready ? '可用' : '需注意';
  badge.dataset.status = analysis.status;
  const metrics = [
    ['时长', `${analysis.durationSeconds.toFixed(2)} 秒`],
    ['响度', analysis.integratedLufs === null ? '未测得' : `${analysis.integratedLufs.toFixed(1)} LUFS`],
    ['峰值', analysis.truePeakDb === null ? '未测得' : `${analysis.truePeakDb.toFixed(1)} dBTP`],
    ['静音占比', `${Math.round((analysis.silenceRatio || 0) * 100)}%`]
  ];
  $('#reference-metrics').replaceChildren(...metrics.map(([label, value]) => {
    const item = document.createElement('div');
    const key = document.createElement('span'); key.textContent = label;
    const data = document.createElement('b'); data.textContent = value;
    item.append(key, data); return item;
  }));
  const issueRoot = $('#reference-issues'); issueRoot.replaceChildren();
  for (const issue of analysis.issues || []) { const item = document.createElement('li'); item.textContent = issue; issueRoot.append(item); }
  if (!(analysis.issues || []).length) { const item = document.createElement('li'); item.textContent = '未发现基础格式、响度或长静音问题；仍请人工确认只有一位说话人且没有音乐。'; issueRoot.append(item); }
  const end = Math.min(15, analysis.durationSeconds);
  $('#trim-start').value = '0';
  $('#trim-start').max = String(Math.max(0, analysis.durationSeconds - 2));
  $('#trim-end').value = end.toFixed(1);
  $('#trim-end').max = String(analysis.durationSeconds);
}

function renderVerticalWaveform(root, values = []) {
  const levels = Array.isArray(values) && values.length ? values : Array(72).fill(0);
  const bars = levels.map((value) => {
    const bar = document.createElement('i');
    const level = Math.max(0, Math.min(1, Number(value) || 0));
    bar.classList.add(`wave-level-${Math.max(0, Math.min(12, Math.round(level * 12)))}`);
    return bar;
  });
  const namespace = 'http://www.w3.org/2000/svg';
  const playhead = document.createElementNS(namespace, 'svg');
  playhead.classList.add('vertical-waveform-playhead');
  playhead.setAttribute('viewBox', '0 0 100 100');
  playhead.setAttribute('preserveAspectRatio', 'none');
  playhead.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(namespace, 'line');
  line.setAttribute('x1', '0');
  line.setAttribute('x2', '0');
  line.setAttribute('y1', '0');
  line.setAttribute('y2', '100');
  playhead.append(line);
  const trimLayer = document.createElement('div');
  trimLayer.className = 'waveform-trim-layer hidden';
  trimLayer.setAttribute('aria-hidden', 'true');
  const leftShade = document.createElement('span'); leftShade.className = 'waveform-trim-shade trim-before';
  const rightShade = document.createElement('span'); rightShade.className = 'waveform-trim-shade trim-after';
  const selection = document.createElement('span'); selection.className = 'waveform-trim-selection';
  const startHandle = document.createElement('button');
  startHandle.type = 'button'; startHandle.className = 'waveform-trim-handle trim-start-handle'; startHandle.dataset.trimHandle = 'start';
  startHandle.setAttribute('aria-label', '裁剪起点'); startHandle.innerHTML = '<i aria-hidden="true"></i>';
  const endHandle = document.createElement('button');
  endHandle.type = 'button'; endHandle.className = 'waveform-trim-handle trim-end-handle'; endHandle.dataset.trimHandle = 'end';
  endHandle.setAttribute('aria-label', '裁剪终点'); endHandle.innerHTML = '<i aria-hidden="true"></i>';
  const createTimeControl = (kind, label) => {
    const control = document.createElement('div'); control.className = `waveform-trim-time-control trim-${kind}-time`;
    const display = document.createElement('button');
    display.type = 'button'; display.className = 'waveform-trim-time-display'; display.dataset.trimTime = kind;
    display.textContent = '0:00.00'; display.setAttribute('aria-label', `${label}，双击精确填写`);
    const editor = document.createElement('input');
    editor.type = 'text'; editor.className = 'waveform-trim-time-editor hidden'; editor.dataset.trimEditor = kind;
    editor.inputMode = 'decimal'; editor.autocomplete = 'off'; editor.spellcheck = false;
    editor.setAttribute('aria-label', `精确填写${label}，可输入秒数或分:秒`);
    control.append(display, editor);
    return control;
  };
  trimLayer.append(leftShade, rightShade, selection, startHandle, endHandle, createTimeControl('start', '裁剪起点'), createTimeControl('end', '裁剪终点'));
  root.replaceChildren(...bars, playhead, trimLayer);
}

function setWaveformProgress(root, progress = 0) {
  const ratio = Math.max(0, Math.min(1, Number(progress) || 0));
  const bars = [...root.querySelectorAll(':scope > i')];
  const played = Math.round(ratio * bars.length);
  bars.forEach((bar, index) => bar.classList.toggle('played', index < played));
  const line = root.querySelector('.vertical-waveform-playhead line');
  if (line) {
    const x = String(ratio * 100);
    line.setAttribute('x1', x);
    line.setAttribute('x2', x);
  }
}

function setWaveformPlayButton(button, playing) {
  button.dataset.playing = String(Boolean(playing));
  button.setAttribute('aria-pressed', String(Boolean(playing)));
  button.setAttribute('aria-label', playing ? '暂停' : '播放');
  button.dataset.tooltip = playing ? '暂停' : '播放';
}

function resetWaveformAudio(audio, button, waveform, source) {
  audio.pause();
  setWaveformPlayButton(button, false);
  setWaveformProgress(waveform, 0);
  if (source) audio.src = source;
  else {
    audio.removeAttribute('src');
    audio.load();
  }
}

function formatTrimTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const remainder = (value % 60).toFixed(2).padStart(5, '0');
  return `${minutes}:${remainder}`;
}

function parseTrimTime(value) {
  const text = String(value ?? '').trim().replace('：', ':');
  if (!text) return NaN;
  if (!text.includes(':')) return Number(text);
  const parts = text.split(':');
  if (parts.length !== 2) return NaN;
  const minutes = Number(parts[0]);
  const seconds = Number(parts[1]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || minutes < 0 || seconds < 0 || seconds >= 60) return NaN;
  return minutes * 60 + seconds;
}

function referenceDuration() {
  return Math.max(0, Number(state.reference?.analysis?.durationSeconds) || Number($('#reference-audio')?.duration) || 0);
}

function getReferenceTrimRange() {
  if (!state.referenceTrim.active) return null;
  return { start: state.referenceTrim.startSeconds, end: state.referenceTrim.endSeconds };
}

function syncReferenceTrimUI() {
  const waveform = $('#reference-waveform');
  const layer = waveform?.querySelector('.waveform-trim-layer');
  if (!layer) return;
  const duration = referenceDuration();
  const start = Math.max(0, Math.min(duration, state.referenceTrim.startSeconds));
  const end = Math.max(start, Math.min(duration, state.referenceTrim.endSeconds));
  const startRatio = duration ? start / duration : 0;
  const endRatio = duration ? end / duration : 1;
  layer.style.setProperty('--trim-start', `${startRatio * 100}%`);
  layer.style.setProperty('--trim-end', `${endRatio * 100}%`);
  const startHandle = layer.querySelector('[data-trim-handle="start"]');
  const endHandle = layer.querySelector('[data-trim-handle="end"]');
  const startText = formatTrimTime(start);
  const endText = formatTrimTime(end);
  const startDisplay = layer.querySelector('[data-trim-time="start"]');
  const endDisplay = layer.querySelector('[data-trim-time="end"]');
  const startEditor = layer.querySelector('[data-trim-editor="start"]');
  const endEditor = layer.querySelector('[data-trim-editor="end"]');
  if (startDisplay) startDisplay.textContent = startText;
  if (endDisplay) endDisplay.textContent = endText;
  if (startEditor && document.activeElement !== startEditor) startEditor.value = startText;
  if (endEditor && document.activeElement !== endEditor) endEditor.value = endText;
  for (const [handle, value, text] of [[startHandle, start, startText], [endHandle, end, endText]]) {
    if (!handle) continue;
    handle.setAttribute('aria-valuemin', '0');
    handle.setAttribute('aria-valuemax', duration.toFixed(2));
    handle.setAttribute('aria-valuenow', value.toFixed(2));
    handle.setAttribute('aria-valuetext', text);
  }
  const rangeLabel = $('#trim-range-label');
  const durationLabel = $('#trim-duration-label');
  if (rangeLabel) rangeLabel.textContent = `${startText} – ${endText}`;
  if (durationLabel) durationLabel.textContent = `保留 ${(end - start).toFixed(2)} 秒`;
  const valid = duration >= 2 && end - start >= 2 && end - start <= 30;
  const apply = $('#apply-trim-reference');
  if (apply) apply.disabled = !valid;
  const startInput = $('#trim-start');
  const endInput = $('#trim-end');
  if (startInput) startInput.value = start.toFixed(2);
  if (endInput) endInput.value = end.toFixed(2);
}

function setReferenceTrimBoundary(kind, nextSeconds) {
  const duration = referenceDuration();
  if (!duration) return;
  if (duration < 2) {
    state.referenceTrim.startSeconds = 0;
    state.referenceTrim.endSeconds = duration;
  } else if (kind === 'start') {
    const earliest = Math.max(0, state.referenceTrim.endSeconds - 30);
    state.referenceTrim.startSeconds = Math.max(earliest, Math.min(Number(nextSeconds) || 0, state.referenceTrim.endSeconds - 2));
  } else {
    const latest = Math.min(duration, state.referenceTrim.startSeconds + 30);
    state.referenceTrim.endSeconds = Math.min(latest, Math.max(Number(nextSeconds) || 0, state.referenceTrim.startSeconds + 2));
  }
  const audio = $('#reference-audio');
  if (Number.isFinite(audio?.currentTime)) {
    if (audio.currentTime < state.referenceTrim.startSeconds) audio.currentTime = state.referenceTrim.startSeconds;
    if (audio.currentTime > state.referenceTrim.endSeconds) audio.currentTime = state.referenceTrim.endSeconds;
    setWaveformProgress($('#reference-waveform'), audio.currentTime / duration);
  }
  syncReferenceTrimUI();
}

function setReferenceTrimMode(active) {
  const enabled = Boolean(active && state.reference && referenceDuration());
  state.referenceTrim.active = enabled;
  state.referenceTrim.dragging = null;
  const waveform = $('#reference-waveform');
  const layer = waveform?.querySelector('.waveform-trim-layer');
  const panel = $('#reference-trim-panel');
  const button = $('#trim-reference');
  waveform?.classList.toggle('trim-mode', enabled);
  waveform?.classList.remove('trim-dragging');
  layer?.classList.toggle('hidden', !enabled);
  layer?.setAttribute('aria-hidden', String(!enabled));
  panel?.classList.toggle('hidden', !enabled);
  if (button) {
    button.dataset.active = String(enabled);
    button.dataset.tooltip = enabled ? '退出裁剪' : '裁剪参考音频';
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-label', enabled ? '退出裁剪' : '裁剪参考音频');
  }
  if (enabled) {
    const duration = referenceDuration();
    state.referenceTrim.startSeconds = 0;
    state.referenceTrim.endSeconds = Math.min(15, duration);
    $('#reference-audio')?.pause();
    if ($('#reference-audio')) $('#reference-audio').currentTime = 0;
    setWaveformProgress(waveform, 0);
  }
  syncReferenceTrimUI();
}

function resetReferenceTrim(reference) {
  state.referenceTrim.active = false;
  state.referenceTrim.dragging = null;
  state.referenceTrim.startSeconds = 0;
  state.referenceTrim.endSeconds = Math.min(15, Math.max(0, Number(reference?.analysis?.durationSeconds) || 0));
  setReferenceTrimMode(false);
}

function setupReferenceTrimmer() {
  const actions = $('#reference-waveform-actions');
  const button = $('#trim-reference');
  const waveform = $('#reference-waveform');
  if (!actions || !button || !waveform) return;
  button.className = 'waveform-icon-button waveform-trim-toggle';
  button.setAttribute('aria-label', '裁剪参考音频');
  button.setAttribute('aria-pressed', 'false');
  button.title = '裁剪参考音频';
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M8.6 8.5 20 15M8.6 15.5 20 9"/></svg>';
  actions.insertBefore(button, $('#replace-reference'));

  const panel = document.createElement('div');
  panel.className = 'waveform-trim-panel hidden';
  panel.id = 'reference-trim-panel';
  panel.innerHTML = '<div class="trim-range-copy"><b id="trim-range-label">0:00.00 – 0:00.00</b><span id="trim-duration-label">保留 0.00 秒</span></div><div class="trim-panel-actions"><button class="secondary small" id="cancel-trim-reference" type="button">取消</button><button class="primary small" id="apply-trim-reference" type="button">应用裁剪</button></div>';
  const normalizeLabel = $('#trim-normalize')?.closest('label');
  if (normalizeLabel) {
    normalizeLabel.className = 'trim-normalize-option';
    panel.querySelector('.trim-panel-actions').prepend(normalizeLabel);
  }
  actions.after(panel);
  panel.addEventListener('click', (event) => event.stopPropagation());

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!state.reference) return showToast('请先选择参考音频');
    setReferenceTrimMode(!state.referenceTrim.active);
  });
  $('#cancel-trim-reference').addEventListener('click', (event) => { event.stopPropagation(); setReferenceTrimMode(false); });
  $('#apply-trim-reference').addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!state.reference) return showToast('请先选择参考音频');
    const apply = $('#apply-trim-reference');
    apply.disabled = true; apply.textContent = '处理中…';
    try {
      const trimmed = await window.voiceStudio.trimReferenceAudio({
        path: state.reference.path,
        startSeconds: state.referenceTrim.startSeconds,
        endSeconds: state.referenceTrim.endSeconds,
        normalize: $('#trim-normalize')?.checked !== false
      });
      setReference(trimmed, `${trimmed.name}（裁剪副本）`);
      showToast('已创建新的 WAV 裁剪副本，原文件未修改');
    } catch (error) { showToast(`裁剪失败：${error.message}`); }
    finally { apply.textContent = '应用裁剪'; syncReferenceTrimUI(); }
  });

  const pointerToSeconds = (event) => {
    const bounds = waveform.getBoundingClientRect();
    const styles = getComputedStyle(waveform);
    const left = bounds.left + (Number.parseFloat(styles.paddingLeft) || 0);
    const width = Math.max(1, bounds.width - (Number.parseFloat(styles.paddingLeft) || 0) - (Number.parseFloat(styles.paddingRight) || 0));
    return Math.max(0, Math.min(referenceDuration(), ((event.clientX - left) / width) * referenceDuration()));
  };
  waveform.addEventListener('pointerdown', (event) => {
    if (state.referenceTrim.active && event.target.closest('.waveform-trim-time-control')) {
      event.stopImmediatePropagation();
      return;
    }
    const handle = event.target.closest('[data-trim-handle]');
    if (!state.referenceTrim.active || !handle || event.button !== 0) return;
    event.preventDefault(); event.stopImmediatePropagation();
    $('#reference-audio')?.pause();
    state.referenceTrim.dragging = handle.dataset.trimHandle;
    waveform.classList.add('trim-dragging');
    waveform.setPointerCapture(event.pointerId);
    setReferenceTrimBoundary(state.referenceTrim.dragging, pointerToSeconds(event));
  });
  waveform.addEventListener('pointermove', (event) => {
    if (!state.referenceTrim.active || !state.referenceTrim.dragging) return;
    event.preventDefault(); event.stopImmediatePropagation();
    setReferenceTrimBoundary(state.referenceTrim.dragging, pointerToSeconds(event));
  });
  const finishTrimDrag = (event) => {
    if (!state.referenceTrim.dragging) return;
    event.preventDefault(); event.stopImmediatePropagation();
    setReferenceTrimBoundary(state.referenceTrim.dragging, pointerToSeconds(event));
    if (waveform.hasPointerCapture(event.pointerId)) waveform.releasePointerCapture(event.pointerId);
    state.referenceTrim.dragging = null;
    waveform.classList.remove('trim-dragging');
  };
  waveform.addEventListener('pointerup', finishTrimDrag);
  waveform.addEventListener('pointercancel', (event) => {
    if (!state.referenceTrim.dragging) return;
    event.stopImmediatePropagation();
    state.referenceTrim.dragging = null;
    waveform.classList.remove('trim-dragging');
  });

  const beginTimeEdit = (kind) => {
    const display = waveform.querySelector(`[data-trim-time="${kind}"]`);
    const editor = waveform.querySelector(`[data-trim-editor="${kind}"]`);
    if (!display || !editor || !state.referenceTrim.active) return;
    const current = kind === 'start' ? state.referenceTrim.startSeconds : state.referenceTrim.endSeconds;
    display.classList.add('hidden');
    editor.classList.remove('hidden');
    editor.value = formatTrimTime(current);
    editor.dataset.originalValue = editor.value;
    editor.focus();
    editor.select();
  };
  const finishTimeEdit = (editor, commit = true) => {
    if (!editor || editor.classList.contains('hidden')) return;
    const kind = editor.dataset.trimEditor;
    const display = waveform.querySelector(`[data-trim-time="${kind}"]`);
    if (commit) {
      const next = parseTrimTime(editor.value);
      if (Number.isFinite(next)) setReferenceTrimBoundary(kind, next);
      else showToast('请输入有效时间，例如 0.60 或 0:00.60');
    }
    editor.classList.add('hidden');
    display?.classList.remove('hidden');
    syncReferenceTrimUI();
  };
  waveform.addEventListener('dblclick', (event) => {
    const display = event.target.closest('[data-trim-time]');
    if (!state.referenceTrim.active || !display) return;
    event.preventDefault(); event.stopImmediatePropagation();
    beginTimeEdit(display.dataset.trimTime);
  });
  waveform.addEventListener('focusout', (event) => {
    const editor = event.target.closest('[data-trim-editor]');
    if (editor && !editor.classList.contains('hidden')) finishTimeEdit(editor, true);
  });
  waveform.addEventListener('keydown', (event) => {
    const display = event.target.closest('[data-trim-time]');
    if (state.referenceTrim.active && display && ['Enter', ' '].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      beginTimeEdit(display.dataset.trimTime);
      return;
    }
    const editor = event.target.closest('[data-trim-editor]');
    if (editor) {
      if (event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation();
        finishTimeEdit(editor, true);
      } else if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        finishTimeEdit(editor, false);
      }
      return;
    }
    const handle = event.target.closest('[data-trim-handle]');
    if (!state.referenceTrim.active || !handle || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const kind = handle.dataset.trimHandle;
    const step = event.shiftKey ? 0.5 : 0.1;
    const current = kind === 'start' ? state.referenceTrim.startSeconds : state.referenceTrim.endSeconds;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? referenceDuration() : current + (event.key === 'ArrowLeft' ? -step : step);
    setReferenceTrimBoundary(kind, next);
  });
}

function configureWaveformPlayer(audio, button, waveform, controls = {}) {
  let animationFrame = 0;
  let draggingPointer = null;
  let keepAtEnd = false;
  controls.actions?.querySelectorAll('.waveform-icon-button').forEach((item) => {
    item.dataset.tooltip = item.title || item.getAttribute('aria-label') || '';
    item.removeAttribute('title');
  });
  const closeMenus = () => {
    controls.speedPopover?.classList.add('hidden');
    controls.volumePopover?.classList.add('hidden');
  };
  const updateVolume = () => {
    const percentage = Math.round((audio.muted ? 0 : audio.volume) * 100);
    controls.volumeValue && (controls.volumeValue.textContent = `${percentage}%`);
    if (controls.volumeButton) {
      controls.volumeButton.dataset.muted = String(percentage === 0);
      controls.volumeButton.setAttribute('aria-label', `音量 ${percentage}%`);
      controls.volumeButton.dataset.tooltip = `音量 ${percentage}%`;
    }
  };
  const progress = () => (audio.duration ? audio.currentTime / audio.duration : 0);
  const stopAnimation = () => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  };
  const renderPlaybackFrame = () => {
    const trimRange = controls.getTrimRange?.();
    if (trimRange && audio.currentTime >= trimRange.end) {
      audio.pause();
      audio.currentTime = trimRange.end;
      setWaveformProgress(waveform, progress());
      animationFrame = 0;
      return;
    }
    setWaveformProgress(waveform, progress());
    if (!audio.paused && !audio.ended) animationFrame = requestAnimationFrame(renderPlaybackFrame);
    else animationFrame = 0;
  };
  const startAnimation = () => {
    stopAnimation();
    animationFrame = requestAnimationFrame(renderPlaybackFrame);
  };
  const deactivate = () => {
    stopAnimation();
    audio.pause();
    closeMenus();
    keepAtEnd = false;
    if (draggingPointer !== null && waveform.hasPointerCapture(draggingPointer)) {
      waveform.releasePointerCapture(draggingPointer);
    }
    draggingPointer = null;
    waveform.classList.remove('dragging');
    setWaveformPlayButton(button, false);
  };
  const seekFromPointer = (event) => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const bounds = waveform.getBoundingClientRect();
    const styles = getComputedStyle(waveform);
    const leftInset = Number.parseFloat(styles.paddingLeft) || 0;
    const rightInset = Number.parseFloat(styles.paddingRight) || 0;
    const trackLeft = bounds.left + leftInset;
    const trackWidth = Math.max(1, bounds.width - leftInset - rightInset);
    const rawRatio = Math.max(0, Math.min(1, (event.clientX - trackLeft) / trackWidth));
    const trimRange = controls.getTrimRange?.();
    const nextTime = trimRange
      ? Math.max(trimRange.start, Math.min(trimRange.end, rawRatio * audio.duration))
      : rawRatio * audio.duration;
    const ratio = nextTime / audio.duration;
    keepAtEnd = !trimRange && ratio >= 1;
    audio.currentTime = nextTime;
    setWaveformProgress(waveform, ratio);
  };
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!audio.src) return;
    try {
      if (audio.paused) {
        keepAtEnd = false;
        const trimRange = controls.getTrimRange?.();
        if (trimRange && (audio.currentTime < trimRange.start || audio.currentTime >= trimRange.end)) audio.currentTime = trimRange.start;
        await audio.play();
      }
      else audio.pause();
    } catch (error) { showToast(`音频播放失败：${error.message}`); }
  });
  controls.actions?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!event.target.closest('.waveform-menu')) closeMenus();
  });
  controls.replay?.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!audio.src) return;
    keepAtEnd = false;
    const trimRange = controls.getTrimRange?.();
    audio.currentTime = trimRange?.start ?? 0;
    setWaveformProgress(waveform, audio.currentTime / audio.duration);
    try { await audio.play(); }
    catch (error) { showToast(`音频重播失败：${error.message}`); }
  });
  controls.speedButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    const opening = controls.speedPopover?.classList.contains('hidden');
    closeMenus();
    controls.speedPopover?.classList.toggle('hidden', !opening);
  });
  controls.speedPopover?.querySelectorAll('[data-playback-rate]').forEach((option) => {
    option.addEventListener('click', (event) => {
      event.stopPropagation();
      const rate = Number(option.dataset.playbackRate);
      if (!Number.isFinite(rate) || rate <= 0) return;
      audio.playbackRate = rate;
      controls.speedValue && (controls.speedValue.textContent = `${rate}×`);
      controls.speedButton?.setAttribute('aria-label', `播放速度 ${rate} 倍`);
      controls.speedButton && (controls.speedButton.dataset.tooltip = `播放速度 ${rate} 倍`);
      controls.speedPopover.querySelectorAll('[data-playback-rate]').forEach((item) => item.classList.toggle('active', item === option));
      controls.speedPopover.classList.add('hidden');
    });
  });
  controls.volumeButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    const opening = controls.volumePopover?.classList.contains('hidden');
    closeMenus();
    controls.volumePopover?.classList.toggle('hidden', !opening);
  });
  controls.volumeRange?.addEventListener('input', (event) => {
    const volume = Math.max(0, Math.min(1, Number(event.target.value) || 0));
    audio.volume = volume;
    audio.muted = volume === 0;
    updateVolume();
  });
  document.addEventListener('click', closeMenus);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenus(); });
  waveform.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    draggingPointer = event.pointerId;
    waveform.classList.add('dragging');
    waveform.setPointerCapture(event.pointerId);
    seekFromPointer(event);
  });
  waveform.addEventListener('pointermove', (event) => {
    if (draggingPointer !== event.pointerId) return;
    event.stopPropagation();
    event.preventDefault();
    seekFromPointer(event);
  });
  const finishDragging = (event) => {
    if (draggingPointer !== event.pointerId) return;
    event.stopPropagation();
    event.preventDefault();
    seekFromPointer(event);
    if (waveform.hasPointerCapture(event.pointerId)) waveform.releasePointerCapture(event.pointerId);
    draggingPointer = null;
    waveform.classList.remove('dragging');
  };
  waveform.addEventListener('pointerup', finishDragging);
  waveform.addEventListener('pointercancel', (event) => {
    if (draggingPointer !== event.pointerId) return;
    draggingPointer = null;
    waveform.classList.remove('dragging');
  });
  waveform.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
  });
  waveform.addEventListener('waveform:deactivate', deactivate);
  audio.addEventListener('play', () => {
    setWaveformPlayButton(button, true);
    startAnimation();
  });
  audio.addEventListener('pause', () => {
    setWaveformPlayButton(button, false);
    stopAnimation();
    setWaveformProgress(waveform, progress());
  });
  audio.addEventListener('timeupdate', () => {
    if (audio.paused && draggingPointer === null) setWaveformProgress(waveform, progress());
  });
  audio.addEventListener('ended', () => {
    stopAnimation();
    setWaveformPlayButton(button, false);
    if (keepAtEnd) {
      setWaveformProgress(waveform, 1);
      return;
    }
    setWaveformProgress(waveform, 0);
  });
  audio.addEventListener('loadstart', () => { keepAtEnd = false; });
  audio.addEventListener('volumechange', updateVolume);
  setWaveformPlayButton(button, false);
  updateVolume();
}

function prepareReferenceChange(kind = 'reference') {
  const isSpeakerReference = kind === 'reference';
  const audio = $(`#${kind}-audio`);
  const waveform = $(`#${kind}-waveform`);
  waveform?.dispatchEvent(new Event('waveform:deactivate'));
  audio?.pause();
  if (isSpeakerReference) {
    state.referenceTrim.dragging = null;
    waveform?.classList.remove('trim-dragging');
    if (state.referenceTrim.active) setReferenceTrimMode(false);
  }
}

function waveformControls(name) {
  return {
    actions: $(`#${name}-waveform-actions`),
    replay: $(`#replay-${name}`),
    speedButton: $(`#speed-${name}`),
    speedValue: $(`#speed-${name}-value`),
    speedPopover: $(`#speed-${name}-popover`),
    volumeButton: $(`#volume-${name}`),
    volumeRange: $(`#volume-${name}-range`),
    volumeValue: $(`#volume-${name}-value`),
    volumePopover: $(`#volume-${name}-popover`),
    getTrimRange: name === 'reference' ? getReferenceTrimRange : null
  };
}

function setReference(reference, label = reference?.name || '选择参考音频') {
  resetReferenceTrim(reference);
  state.reference = reference || null;
  $('#reference-name').textContent = label;
  const selected = Boolean(reference);
  const picker = $('#reference-picker');
  picker.classList.toggle('selected', selected);
  picker.setAttribute('aria-label', selected ? `已选择参考音频：${label}` : '选择参考音频');
  picker.setAttribute('role', selected ? 'group' : 'button');
  picker.tabIndex = selected ? -1 : 0;
  $('#reference-waveform').classList.toggle('hidden', !selected);
  $('#reference-waveform-actions').classList.toggle('hidden', !selected);
  const audio = $('#reference-audio');
  const waveform = $('#reference-waveform');
  renderVerticalWaveform(waveform, reference?.analysis?.waveform);
  resetWaveformAudio(audio, $('#play-reference'), waveform, reference?.url);
  renderReferenceAnalysis(reference);
}

function setEmotionReference(reference) {
  state.emotionReference = reference || null;
  $('#emotion-reference-name').textContent = reference?.name || '选择情感参考音频';
  const selected = Boolean(reference);
  const picker = $('#emotion-reference-picker');
  picker.classList.toggle('selected', selected);
  picker.setAttribute('aria-label', selected ? `已选择情感参考音频：${reference.name}` : '选择情感参考音频');
  picker.setAttribute('role', selected ? 'group' : 'button');
  picker.tabIndex = selected ? -1 : 0;
  $('#emotion-reference-waveform').classList.toggle('hidden', !selected);
  $('#emotion-reference-waveform-actions').classList.toggle('hidden', !selected);
  const audio = $('#emotion-reference-audio');
  const waveform = $('#emotion-reference-waveform');
  renderVerticalWaveform(waveform, reference?.analysis?.waveform);
  resetWaveformAudio(audio, $('#play-emotion-reference'), waveform, reference?.url);
}

function renderCandidates(results, baseName) {
  state.candidates = results;
  const root = $('#design-candidates');
  const list = $('#candidate-list');
  list.replaceChildren();
  root.classList.toggle('hidden', results.length < 2);
  results.forEach((result, index) => {
    const card = document.createElement('article'); card.className = 'candidate-card';
    const selected = state.result?.output === result.output;
    card.classList.toggle('selected', selected);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-pressed', String(selected));
    card.setAttribute('aria-label', `选择候选 ${String.fromCharCode(65 + index)}`);
    const heading = document.createElement('div'); heading.className = 'candidate-card-head';
    const name = document.createElement('b'); name.textContent = `候选 ${String.fromCharCode(65 + index)}`;
    const seed = document.createElement('span'); seed.textContent = `${selected ? '已选 · ' : ''}种子 ${result.seed}`;
    heading.append(name, seed);
    const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = result.url;
    const choose = () => {
      if (state.result?.output === result.output) return;
      setResult(result, `${baseName}·候选 ${String.fromCharCode(65 + index)}`, 'design', '候选对比');
      [...list.querySelectorAll('.candidate-card')].forEach((candidate, candidateIndex) => {
        const active = sameOutput(results[candidateIndex]?.output, result.output);
        candidate.classList.toggle('selected', active);
        candidate.setAttribute('aria-pressed', String(active));
        candidate.querySelector('.candidate-card-head span').textContent = `${active ? '已选 · ' : ''}种子 ${results[candidateIndex].seed}`;
      });
    };
    card.addEventListener('click', choose);
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); choose();
    });
    card.append(heading, audio); list.append(card);
  });
}

function renderLibrary() {
  const root = $('#library-list');
  root.replaceChildren();
  $('#library-count').textContent = `${state.library.length} 个音色`;
  renderLibraryVoicePicker();
  const voices = state.library
    .filter((voice) => voice.name.toLocaleLowerCase('zh-CN').includes(state.libraryQuery))
    .filter((voice) => state.libraryKind === 'all' || voice.kind === state.libraryKind)
    .sort((left, right) => {
      if (state.librarySort === 'newest') return String(right.createdAt).localeCompare(String(left.createdAt));
      if (state.librarySort === 'oldest') return String(left.createdAt).localeCompare(String(right.createdAt));
      if (state.librarySort === 'name') return String(left.name).localeCompare(String(right.name), 'zh-CN');
      return Number(Boolean(right.favorite)) - Number(Boolean(left.favorite)) || String(right.createdAt).localeCompare(String(left.createdAt));
    });
  if (!voices.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.innerHTML = state.library.length
      ? '<div>没有匹配的音色<br><small>换一个关键词试试</small></div>'
      : '<div>还没有保存的音色<br><small>生成满意的结果后，点击“保存到音色库”</small></div>';
    root.append(empty); return;
  }
  for (const voice of voices) {
    const item = document.createElement('article'); item.className = 'voice-item'; item.classList.toggle('favorite', Boolean(voice.favorite));
    const icon = document.createElement('div'); icon.className = 'voice-icon'; icon.textContent = voice.kind === 'design' ? '✦' : '◉';
    const copy = document.createElement('div');
    const name = document.createElement('b'); name.className = 'voice-name'; name.textContent = voice.name; name.tabIndex = 0; name.title = '双击修改名称'; name.setAttribute('aria-label', `${voice.name}，双击修改名称`);
    const voiceKind = voice.kind === 'design' ? '设计音色' : '克隆音色';
    const meta = document.createElement('small'); meta.textContent = `${voiceKind} · ${new Date(voice.createdAt).toLocaleDateString('zh-CN')}`; copy.append(name, meta);
    const actions = document.createElement('div'); actions.className = 'voice-actions';
    const favorite = document.createElement('button'); favorite.className = 'icon-button favorite-button'; favorite.textContent = voice.favorite ? '★' : '☆'; favorite.title = voice.favorite ? '取消收藏' : '收藏';
    favorite.addEventListener('click', async () => {
      const updated = await window.voiceStudio.favoriteVoice(voice.id);
      state.library = state.library.map((entry) => entry.id === voice.id ? updated : entry); renderLibrary();
    });
    const rename = document.createElement('button'); rename.className = 'icon-button'; rename.textContent = '重命名';
    let renamePending = false;
    let editingName = false;
    const closeRename = (restore = true) => {
      editingName = false;
      name.contentEditable = 'false';
      name.removeAttribute('data-editing');
      if (restore) name.textContent = voice.name;
      window.getSelection()?.removeAllRanges();
    };
    const startRename = () => {
      if (editingName || renamePending) return;
      editingName = true;
      name.contentEditable = 'plaintext-only';
      name.dataset.editing = 'true';
      name.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(name);
      selection.removeAllRanges(); selection.addRange(range);
    };
    const commitRename = async () => {
      if (!editingName || renamePending) return;
      const nextName = name.textContent.trim();
      if (!nextName || nextName === voice.name) { closeRename(); return; }
      renamePending = true;
      name.contentEditable = 'false';
      try {
        const updated = await window.voiceStudio.renameVoice({ id: voice.id, name: nextName });
        state.library = state.library.map((entry) => entry.id === voice.id ? updated : entry);
        if (state.result?.savedVoiceId === voice.id) state.result.name = updated.name;
        renderLibrary();
        showToast(`已重命名为“${updated.name}”`);
      } catch (error) {
        renamePending = false;
        closeRename();
        showToast(`重命名失败：${error.message}`);
      }
    };
    rename.addEventListener('click', startRename);
    name.addEventListener('dblclick', startRename);
    name.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
      if (event.key === 'Escape') { event.preventDefault(); closeRename(); }
    });
    name.addEventListener('blur', commitRename);
    const removeRecord = async () => {
      await window.voiceStudio.deleteVoice(voice.id);
      state.library = state.library.filter((entry) => entry.id !== voice.id);
      if (sameOutput(state.result?.output, voice.output)) {
        state.result = null;
        clearPersistedSelection();
        $('#result-audio').removeAttribute('src');
        $('#result-dock').classList.add('hidden');
      }
      renderLibrary();
      showToast('音色及文件已移至回收站');
    };
    const erase = document.createElement('button'); erase.className = 'danger small erase-button'; erase.textContent = '删除音色'; erase.title = '从音色库删除，并将 WAV 与参数文件移至回收站';
    erase.addEventListener('click', () => {
      if (!window.confirm(`确定将“${voice.name}”的音频和参数文件移至回收站吗？`)) return;
      removeRecord().catch((error) => showToast(`删除失败：${error.message}`));
    });
    actions.append(favorite, rename, erase);
    const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = voice.url;
    item.append(icon, copy, actions, audio); root.append(item);
  }
}

function closeLibraryVoicePicker() {
  $('#library-voice-picker').classList.add('hidden');
  $('#select-library-voice').setAttribute('aria-expanded', 'false');
}

function renderLibraryVoicePicker() {
  const root = $('#library-voice-picker-list');
  if (!root) return;
  const query = $('#library-voice-picker-search').value.trim().toLocaleLowerCase('zh-CN');
  const voices = state.library
    .filter((voice) => voice.name.toLocaleLowerCase('zh-CN').includes(query))
    .sort((left, right) => Number(Boolean(right.favorite)) - Number(Boolean(left.favorite)) || String(right.createdAt).localeCompare(String(left.createdAt)));
  $('#library-voice-picker-count').textContent = `${state.library.length} 个音色`;
  root.replaceChildren();
  if (!voices.length) {
    const empty = document.createElement('div');
    empty.className = 'library-voice-picker-empty';
    empty.textContent = state.library.length ? '没有匹配的音色' : '音色库中还没有已保存音色';
    root.append(empty);
    return;
  }
  voices.forEach((voice) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'library-voice-option';
    option.classList.toggle('selected', sameOutput(state.result?.output, voice.output));
    const icon = document.createElement('span'); icon.className = 'voice-option-icon'; icon.textContent = voice.kind === 'design' ? '✦' : '◉';
    const copy = document.createElement('span');
    const name = document.createElement('b'); name.textContent = voice.name;
    const meta = document.createElement('small'); meta.textContent = `${voice.kind === 'design' ? '设计音色' : '克隆音色'}${voice.favorite ? ' · 已收藏' : ''}`;
    copy.append(name, meta);
    const selected = document.createElement('em'); selected.textContent = sameOutput(state.result?.output, voice.output) ? '当前' : '';
    option.append(icon, copy, selected);
    option.addEventListener('click', () => {
      setResult(voice, voice.name, voice.kind === 'design' ? 'design' : 'clone', '音色库');
      closeLibraryVoicePicker();
      showToast(`已切换到“${voice.name}”`);
    });
    root.append(option);
  });
}

function groupTaskHistory(tasks) {
  const groups = [];
  for (const task of tasks.slice(0, 60)) {
    if (task.status !== 'completed' || task.engine !== 'qwen') { groups.push({ tasks: [task] }); continue; }
    const suffix = String(task.name || '').match(/^(.*)·候选\s*([A-C])$/);
    const label = task.candidateLabel || suffix?.[2] || null;
    const baseName = task.batchName || suffix?.[1] || task.name;
    if (!label && !task.batchId) { groups.push({ tasks: [task] }); continue; }
    let group = task.batchId ? groups.find((entry) => entry.batchId === task.batchId) : null;
    if (!group) {
      const created = new Date(task.createdAt || 0).getTime();
      group = groups.find((entry) => entry.inferredName === baseName
        && !entry.tasks.some((candidate) => (candidate.candidateLabel || String(candidate.name || '').match(/候选\s*([A-C])$/)?.[1]) === label)
        && Math.abs(new Date(entry.tasks[0].createdAt || 0).getTime() - created) <= 10 * 60 * 1000);
    }
    if (group) group.tasks.push(task);
    else groups.push({ batchId: task.batchId || null, inferredName: baseName, tasks: [task] });
  }
  return groups.slice(0, 20);
}

function renderTaskHistory() {
  const root = $('#task-history');
  root.replaceChildren();
  const labels = { completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '异常中断', running: '运行中' };
  if (!state.tasks.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state'; empty.style.minHeight = '110px'; empty.textContent = '还没有任务记录'; root.append(empty); return;
  }
  const selectTask = (task, item) => {
    if (!task?.url || !task.output || sameOutput(state.result?.output, task.output)) return;
    setResult(task, task.name || (task.engine === 'qwen' ? '历史设计音色' : '历史克隆音色'), task.engine === 'qwen' ? 'design' : 'clone', '最近任务');
    [...root.querySelectorAll('.history-item.selectable')].forEach((historyItem) => {
      const active = historyItem === item;
      historyItem.classList.toggle('selected-result', active);
      historyItem.setAttribute('aria-pressed', String(active));
    });
    [...root.querySelectorAll('.candidate-choice')].forEach((choice) => choice.classList.toggle('selected', sameOutput(choice.dataset.output, task.output)));
    showToast('已加载到下方主播放器');
  };
  for (const group of groupTaskHistory(state.tasks)) {
    const sorted = [...group.tasks].sort((left, right) => (left.candidateIndex ?? 99) - (right.candidateIndex ?? 99) || String(left.candidateLabel || left.name).localeCompare(String(right.candidateLabel || right.name)));
    const grouped = sorted.length > 1 || Boolean(group.batchId && sorted[0].candidateCount > 1);
    const task = sorted.find((candidate) => sameOutput(candidate.output, state.result?.output)) || sorted[0];
    const item = document.createElement('article'); item.className = 'history-item'; item.dataset.status = task.status;
    const selectable = sorted.some((candidate) => candidate.status === 'completed' && candidate.url && candidate.output);
    const selected = selectable && sorted.some((candidate) => sameOutput(state.result?.output, candidate.output));
    item.classList.toggle('selectable', selectable); item.classList.toggle('selected-result', selected);
    if (selectable) {
      item.tabIndex = 0; item.setAttribute('role', 'button'); item.setAttribute('aria-pressed', String(selected));
      item.setAttribute('aria-label', `加载 ${grouped ? (task.batchName || group.inferredName || '候选音色组') : (task.name || '历史音色')} 到主播放器`);
      item.addEventListener('click', () => selectTask(task, item));
      item.addEventListener('keydown', (event) => { if (event.target === item && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectTask(task, item); } });
    }
    const row = document.createElement('div'); row.className = 'history-row';
    const name = document.createElement('b'); name.textContent = grouped ? (task.batchName || group.inferredName || task.name) : (task.name || (task.engine === 'qwen' ? '音色设计' : '音色克隆'));
    const actions = document.createElement('div'); actions.className = 'history-actions';
    const retry = document.createElement('button'); retry.className = 'history-retry'; retry.type = 'button'; retry.textContent = '重试';
    retry.hidden = grouped || !['failed', 'cancelled', 'interrupted'].includes(task.status) || !task.retryRequest;
    retry.addEventListener('click', async (event) => {
      event.stopPropagation(); retry.disabled = true;
      const result = await runForm(retry, () => window.voiceStudio.retryTask(task.id), { engine: task.engine, stayOnPage: true });
      if (result) { setTaskStatus('重试完成', '可以试听或保存到音色库', false); setResult(result, task.name || (task.engine === 'qwen' ? '重试设计音色' : '重试克隆音色'), task.engine === 'qwen' ? 'design' : 'clone', '任务重试'); }
      refreshWorkspaceData();
    });
    const remove = document.createElement('button'); remove.className = 'history-delete'; remove.type = 'button'; remove.textContent = '删除';
    remove.disabled = sorted.some((candidate) => candidate.status === 'running');
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      const deletedOutputs = [];
      for (const candidate of sorted) {
        const deleted = await window.voiceStudio.deleteTask(candidate.id);
        if (deleted?.deletedOutput) deletedOutputs.push(deleted.deletedOutput);
      }
      const removedIds = new Set(sorted.map((candidate) => candidate.id));
      state.tasks = state.tasks.filter((entry) => !removedIds.has(entry.id));
      if (deletedOutputs.some((output) => sameOutput(state.result?.output, output))) {
        state.result = null;
        clearPersistedSelection();
        $('#result-audio').removeAttribute('src');
        $('#result-dock').classList.add('hidden');
      }
      renderTaskHistory(); await refreshStorage();
    });
    actions.append(retry, remove); row.append(name, actions);
    const meta = document.createElement('small');
    const time = new Date(task.completedAt || task.createdAt).toLocaleString('zh-CN', { hour12: false });
    const seedMeta = !grouped && Number.isInteger(task.seed) ? ` · 实际种子 ${task.seed}` : '';
    meta.textContent = `${task.engine === 'qwen' ? '音色设计' : '音色克隆'} · ${grouped ? `${sorted.length} 个候选` : (labels[task.status] || task.status)}${seedMeta} · ${time}`;
    item.append(row, meta);
    if (grouped) {
      const choices = document.createElement('div'); choices.className = 'candidate-choices';
      for (const candidate of sorted) {
        const choice = document.createElement('button'); choice.type = 'button'; choice.className = 'candidate-choice'; choice.dataset.output = candidate.output;
        const candidateLabel = candidate.candidateLabel || String(candidate.name || '').match(/候选\s*([A-C])$/)?.[1] || String.fromCharCode(65 + sorted.indexOf(candidate));
        choice.textContent = candidateLabel; choice.title = Number.isInteger(candidate.seed) ? `候选 ${candidateLabel} · 种子 ${candidate.seed}` : `候选 ${candidateLabel}`;
        choice.classList.toggle('selected', sameOutput(state.result?.output, candidate.output));
        choice.addEventListener('click', (event) => { event.stopPropagation(); selectTask(candidate, item); });
        choices.append(choice);
      }
      item.append(choices);
    }
    if (!grouped && task.error) { const error = document.createElement('small'); error.className = 'history-error'; error.textContent = task.error; item.append(error); }
    root.append(item);
  }
}

function renderDescriptionHistory() {
  const root = $('#description-history-list');
  root.replaceChildren();
  $('#description-history-count').textContent = String(state.descriptionHistory.length);

  const heading = document.createElement('div');
  heading.className = 'description-history-heading';
  const headingTitle = document.createElement('b');
  headingTitle.textContent = '历史描述';
  const headingHint = document.createElement('span');
  headingHint.textContent = '点击描述即可使用';
  heading.append(headingTitle, headingHint);
  root.append(heading);

  if (!state.descriptionHistory.length) {
    const empty = document.createElement('div');
    empty.className = 'description-history-empty';
    empty.textContent = '还没有使用过的音色描述';
    root.append(empty);
    return;
  }
  for (const description of state.descriptionHistory) {
    const item = document.createElement('article'); item.className = 'description-history-item';
    const select = document.createElement('button'); select.type = 'button'; select.className = 'history-description-select';
    const text = document.createElement('span'); text.textContent = description; select.append(text);
    select.addEventListener('click', () => {
      $('#voice-description').value = description;
      closeDescriptionHistory();
      $('#voice-description').focus();
      showToast('已使用历史音色描述');
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'description-history-delete'; remove.textContent = '删除'; remove.setAttribute('aria-label', '删除这条历史描述');
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      remove.disabled = true;
      try {
        await window.voiceStudio.deleteDescriptionHistory(description);
        state.descriptionHistory = state.descriptionHistory.filter((entry) => entry !== description);
        renderDescriptionHistory();
        showToast('历史描述已删除');
      } catch (error) {
        remove.disabled = false;
        showToast(`删除失败：${error.message}`);
      }
    });
    item.append(select, remove); root.append(item);
  }
}

function addLocalDescriptionHistory(description) {
  const normalized = String(description).replace(/\r\n/g, '\n').trim();
  state.descriptionHistory = [normalized, ...state.descriptionHistory.filter((entry) => entry !== normalized)].slice(0, 30);
  renderDescriptionHistory();
}

function setupPrecisionRange(root) {
  const range = root.querySelector('.precision-range');
  const output = root.querySelector('.range-current');
  const editor = root.querySelector('.range-edit');
  const decimals = Number(root.dataset.decimals ?? 2);
  const unit = root.dataset.unit ?? '';
  const minimum = Number(range.min);
  const maximum = Number(range.max);
  const step = Number(range.step || 1);
  const normalize = (value) => {
    const clamped = Math.min(maximum, Math.max(minimum, Number(value)));
    return Number((minimum + Math.round((clamped - minimum) / step) * step).toFixed(decimals));
  };
  const render = () => { output.textContent = `${Number(range.value).toFixed(decimals)}${unit}`; };
  const setValue = (value, emit = true) => {
    range.value = String(normalize(value));
    render();
    if (emit) range.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const openEditor = () => {
    output.hidden = true;
    editor.hidden = false;
    editor.value = Number(range.value).toFixed(decimals);
    editor.focus(); editor.select();
  };
  const closeEditor = (commit) => {
    if (editor.hidden) return;
    if (commit && Number.isFinite(Number(editor.value))) setValue(editor.value);
    editor.hidden = true;
    output.hidden = false;
    output.focus();
  };
  range.addEventListener('input', render);
  output.addEventListener('dblclick', openEditor);
  output.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openEditor(); } });
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); closeEditor(true); }
    if (event.key === 'Escape') { event.preventDefault(); closeEditor(false); }
  });
  editor.addEventListener('blur', () => closeEditor(true));
  render();
  return { range, setValue };
}

async function refreshWorkspaceData() {
  const bootstrap = await window.voiceStudio.getBootstrap();
  state.bootstrap = bootstrap;
  state.library = bootstrap.library;
  state.tasks = bootstrap.tasks;
  state.descriptionHistory = bootstrap.descriptionHistory ?? [];
  syncResultSaveState();
  renderLibrary();
  renderTaskHistory();
  renderDescriptionHistory();
}

function renderSystemStatus(status) {
  const gpu = status.gpu;
  const used = gpu.available ? gpu.usedMiB : 0;
  const total = gpu.available ? gpu.usedMiB + gpu.freeMiB : 0;
  const gpuPercent = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const ramUsed = Math.max(0, status.memory.totalGiB - status.memory.freeGiB);
  const ramPercent = status.memory.totalGiB ? Math.round((ramUsed / status.memory.totalGiB) * 100) : 0;
  $('#gpu-name').textContent = gpu.available ? gpu.name : '未检测到 NVIDIA GPU';
  $('#gpu-memory').textContent = gpu.available ? `${used} / ${total} MiB` : gpu.error;
  $('#gpu-bar').style.width = `${gpuPercent}%`;
  $('#gpu-utilization').textContent = gpu.available ? `GPU 利用率 ${gpu.utilizationPercent}%` : '--';
  $('#ram-bar').style.width = `${ramPercent}%`;
  $('#ram-memory').textContent = `${ramUsed.toFixed(2)} / ${status.memory.totalGiB.toFixed(2)} GiB`;
  $('#settings-gpu').textContent = gpu.available ? gpu.name : '不可用';
  $('#settings-vram').textContent = gpu.available ? `已用 ${used} MiB，可用 ${gpu.freeMiB} MiB` : '--';
  $('#settings-ram').textContent = `已用 ${ramUsed.toFixed(2)} GiB，可用 ${status.memory.freeGiB.toFixed(2)} GiB`;
  try { localStorage.setItem(systemStatusSnapshotKey, JSON.stringify(status)); } catch { /* optional cache */ }
}

function restoreStatusSnapshots() {
  try {
    const system = JSON.parse(localStorage.getItem(systemStatusSnapshotKey));
    if (system?.gpu && system?.memory) renderSystemStatus(system);
  } catch { /* no valid previous system status */ }
  try {
    const storage = JSON.parse(localStorage.getItem(storageStatusSnapshotKey));
    if (storage) renderStorage(storage);
  } catch { /* no valid previous storage status */ }
}

async function pollSystemStatus() {
  try { renderSystemStatus(await window.voiceStudio.getSystemStatus()); } catch { /* app may be closing */ }
}

function setResult(result, name, kind, source = '当前结果', persist = true) {
  const relatedTask = state.tasks.find((task) => sameOutput(task.output, result.output));
  const generatedAt = result.generatedAt || result.completedAt || relatedTask?.completedAt || result.createdAt || relatedTask?.createdAt || new Date().toISOString();
  const seed = Number.isInteger(result.seed) ? result.seed : (Number.isInteger(relatedTask?.seed) ? relatedTask.seed : null);
  state.result = { ...result, name, kind, source, generatedAt, seed, savedVoiceId: null };
  $('#result-name').textContent = name;
  const generatedDate = new Date(generatedAt);
  const dateLabel = Number.isNaN(generatedDate.getTime()) ? '—' : generatedDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  $('#result-meta').textContent = `生成日期 ${dateLabel} · 种子 ${Number.isInteger(seed) ? seed : '—'}`;
  $('#result-audio').src = result.url;
  syncResultSaveState();
  $('#result-dock').classList.remove('hidden');
  renderLibraryVoicePicker();
  if (persist && state.result.savedVoiceId) localStorage.setItem(lastSelectionKey, JSON.stringify({ output: result.output, name, kind }));
  else if (!state.result.savedVoiceId) clearPersistedSelection();
}

async function runForm(button, task, options = {}) {
  button.disabled = true;
  if (!options.stayOnPage) showPage('tasks');
  setTaskStatus('正在准备任务', '引擎首次加载会比较慢，请不要重复点击', true);
  if (options.engine === 'qwen') setDesignProgress(3, '正在准备设计任务', '正在检查本机资源与引擎状态', 'running', 'prepare');
  if (options.engine === 'index') setCloneProgress(3, '正在准备克隆任务', '正在检查参考音频与本机资源', 'running', 'prepare');
  try { return await task(); }
  catch (error) {
    const cancelled = /worker was stopped|cancelled|已停止/i.test(error.message);
    setTaskStatus(cancelled ? '任务已停止' : '任务失败', cancelled ? '引擎进程已结束' : error.message, false);
    appendLog(`${cancelled ? '停止' : '失败'}：${error.message}`);
    if (options.engine === 'qwen') setDesignProgress(0, cancelled ? '设计任务已停止' : '设计任务失败', cancelled ? '引擎进程已结束' : error.message, cancelled ? 'cancelled' : 'failed');
    if (options.engine === 'index') setCloneProgress(0, cancelled ? '克隆任务已停止' : '克隆任务失败', cancelled ? '引擎进程已结束' : error.message, cancelled ? 'cancelled' : 'failed');
    if (!cancelled) showToast(error.message);
    return null;
  }
  finally { button.disabled = false; }
}

function installEvents() {
  setSidebarCollapsed(localStorage.getItem('voiceStudio.sidebarCollapsed') === '1');
  $('#sidebar-toggle').addEventListener('click', () => setSidebarCollapsed(!$('.app-shell').classList.contains('sidebar-collapsed')));
  $$('.nav-item').forEach((item) => item.addEventListener('click', () => showPage(item.dataset.page)));
  $$('.jump').forEach((item) => item.addEventListener('click', () => showPage(item.dataset.target)));
  $('#library-search').addEventListener('input', (event) => { state.libraryQuery = event.target.value.trim().toLocaleLowerCase('zh-CN'); renderLibrary(); });
  $('#library-kind-filter').addEventListener('change', (event) => { state.libraryKind = event.target.value; renderLibrary(); });
  $('#library-sort').addEventListener('change', (event) => { state.librarySort = event.target.value; renderLibrary(); });
  $('#select-library-voice').addEventListener('click', () => {
    const picker = $('#library-voice-picker');
    const opening = picker.classList.contains('hidden');
    picker.classList.toggle('hidden', !opening);
    $('#select-library-voice').setAttribute('aria-expanded', String(opening));
    if (opening) {
      renderLibraryVoicePicker();
      $('#library-voice-picker-search').focus();
    }
  });
  $('#close-library-voice-picker').addEventListener('click', closeLibraryVoicePicker);
  $('#library-voice-picker-search').addEventListener('input', renderLibraryVoicePicker);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#library-voice-picker') && !event.target.closest('#select-library-voice')) closeLibraryVoicePicker();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeLibraryVoicePicker(); });
  $('#refresh-storage').addEventListener('click', async () => {
    const button = $('#refresh-storage');
    setButtonWorking(button, true, '刷新中…');
    try { await refreshStorage(); }
    finally { setButtonWorking(button, false); }
  });
  const cleanupStorage = async (scope, label, trigger) => {
    if (!window.confirm(`确定将${label}移入回收站吗？此操作不会删除模型和音色库中已保存的音色。`)) return;
    const buttons = $$('.storage-actions button'); buttons.forEach((button) => { button.disabled = true; });
    setButtonWorking(trigger, true, '清理中…');
    try {
      const result = await window.voiceStudio.cleanupStorage({ scope, currentOutput: state.result?.output ?? null });
      renderStorage(result.storage);
      await refreshWorkspaceData();
      showToast(result.removedCount ? `已将 ${result.removedCount} 个文件移入回收站${result.protectedCurrent ? '，当前选中音色已保留' : ''}` : '没有可清理的文件');
    } catch (error) {
      showToast(`清理失败：${error.message}`);
      await refreshStorage();
    }
    finally {
      setButtonWorking(trigger, false);
      if (state.storage) renderStorage(state.storage);
    }
  };
  $('#cleanup-temporary').addEventListener('click', (event) => cleanupStorage('temporary', '临时残片', event.currentTarget));
  $('#cleanup-orphan').addEventListener('click', (event) => cleanupStorage('orphan', '无记录文件', event.currentTarget));
  $('#cleanup-unsaved').addEventListener('click', (event) => cleanupStorage('unsaved', '所有未保存结果', event.currentTarget));
  renderVerticalWaveform($('#reference-waveform'));
  renderVerticalWaveform($('#emotion-reference-waveform'));
  setupReferenceTrimmer();
  configureWaveformPlayer($('#reference-audio'), $('#play-reference'), $('#reference-waveform'), waveformControls('reference'));
  configureWaveformPlayer($('#emotion-reference-audio'), $('#play-emotion-reference'), $('#emotion-reference-waveform'), waveformControls('emotion-reference'));
  const pickReference = async () => {
    prepareReferenceChange('reference');
    const picker = $('#reference-picker'); picker.classList.add('analyzing');
    try {
      const selected = await window.voiceStudio.pickReferenceAudio();
      if (!selected) return;
      setReference(selected);
      showToast(selected.analysis.status === 'ready' ? '参考音频基础检查通过' : '参考音频已选择，请查看检测建议');
    } catch (error) { showToast(`参考音频检测失败：${error.message}`); }
    finally { picker.classList.remove('analyzing'); }
  };
  $('#reference-picker').addEventListener('click', () => { if (!state.reference) pickReference(); });
  $('#reference-picker').addEventListener('keydown', (event) => {
    if (state.reference || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    pickReference();
  });
  $('#replace-reference').addEventListener('click', (event) => { event.stopPropagation(); pickReference(); });
  $('#clear-reference').addEventListener('click', (event) => { event.stopPropagation(); prepareReferenceChange('reference'); setReference(null); showToast('已清除参考音频'); });
  const pickEmotionReference = async () => {
    prepareReferenceChange('emotion-reference');
    const picker = $('#emotion-reference-picker'); picker.classList.add('analyzing');
    try {
      const selected = await window.voiceStudio.pickEmotionReferenceAudio();
      if (!selected) return;
      setEmotionReference(selected);
      showToast('情感参考音频已选择');
    } catch (error) { showToast(`情感参考音频选择失败：${error.message}`); }
    finally { picker.classList.remove('analyzing'); }
  };
  $('#emotion-reference-picker').addEventListener('click', () => { if (!state.emotionReference) pickEmotionReference(); });
  $('#emotion-reference-picker').addEventListener('keydown', (event) => {
    if (state.emotionReference || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    pickEmotionReference();
  });
  $('#replace-emotion-reference').addEventListener('click', (event) => { event.stopPropagation(); pickEmotionReference(); });
  $('#clear-emotion-reference').addEventListener('click', (event) => { event.stopPropagation(); prepareReferenceChange('emotion-reference'); setEmotionReference(null); showToast('已清除情感参考音频'); });
  const rangeControllers = new Map();
  $$('[data-range-control]').forEach((root) => {
    const controller = setupPrecisionRange(root);
    rangeControllers.set(controller.range.name, controller);
  });
  const paceSelect = $('[form="design-form"][name="pace"]');
  const volumeSelect = $('[form="design-form"][name="volume"]');
  const paceController = rangeControllers.get('paceFactor');
  const volumeController = rangeControllers.get('volumeFactor');
  const pacePresets = { relaxed: 0.85, normal: 1, brisk: 1.15 };
  const volumePresets = { soft: 0.85, normal: 1, loud: 1.15 };
  paceSelect.addEventListener('change', () => paceController.setValue(pacePresets[paceSelect.value]));
  volumeSelect.addEventListener('change', () => volumeController.setValue(volumePresets[volumeSelect.value]));
  paceController.range.addEventListener('input', () => { const value = Number(paceController.range.value); paceSelect.value = value < 0.93 ? 'relaxed' : value > 1.07 ? 'brisk' : 'normal'; });
  volumeController.range.addEventListener('input', () => { const value = Number(volumeController.range.value); volumeSelect.value = value < 0.93 ? 'soft' : value > 1.07 ? 'loud' : 'normal'; });
  const designForm = $('#design-form');
  const cloneForm = $('#clone-form');
  const stopInlineTask = async (button) => {
    button.disabled = true;
    try {
      const result = await window.voiceStudio.cancelActiveTask();
      showToast(result.cancelled ? '已请求停止当前任务' : '当前没有运行中的任务');
    } finally { button.disabled = false; }
  };
  $('#design-stop').addEventListener('click', (event) => stopInlineTask(event.currentTarget));
  $('#clone-stop').addEventListener('click', (event) => stopInlineTask(event.currentTarget));
  $('#design-retry').addEventListener('click', () => designForm.requestSubmit());
  $('#clone-retry').addEventListener('click', () => cloneForm.requestSubmit());
  $('#design-copy-error').addEventListener('click', async () => {
    await window.voiceStudio.copyText(state.progressErrors.qwen);
    showToast('设计错误信息已复制');
  });
  $('#clone-copy-error').addEventListener('click', async () => {
    await window.voiceStudio.copyText(state.progressErrors.index);
    showToast('克隆错误信息已复制');
  });
  const cloneEmotionKeys = ['emoHappy', 'emoAngry', 'emoSad', 'emoAfraid', 'emoDisgusted', 'emoMelancholic', 'emoSurprised', 'emoCalm'];
  const emotionModeChoices = $$('[data-emotion-mode-choice]');
  function syncEmotionModeState() {
    const mode = cloneForm.elements.emotionMode.value;
    emotionModeChoices.forEach((choice) => {
      const active = choice.dataset.emotionModeChoice === mode;
      choice.classList.toggle('active', active);
      choice.setAttribute('aria-checked', String(active));
    });
    document.querySelectorAll('[data-emotion-mode-panel]').forEach((panel) => {
      const active = panel.dataset.emotionModePanel === mode;
      panel.hidden = !active;
      panel.querySelectorAll('input, textarea, select').forEach((control) => { control.disabled = !active; });
    });
    cloneEmotionKeys.forEach((key) => { cloneForm.elements[key].disabled = mode !== 'custom'; });
    const strength = cloneForm.elements.emotionStrength;
    if (mode === 'reference') rangeControllers.get('emotionStrength')?.setValue(1, false);
    strength.disabled = mode === 'reference';
    strength.closest('[data-range-control]')?.classList.toggle('control-disabled', mode === 'reference');
  }
  cloneForm.elements.emotionMode.addEventListener('change', syncEmotionModeState);
  emotionModeChoices.forEach((choice) => choice.addEventListener('click', () => {
    cloneForm.elements.emotionMode.value = choice.dataset.emotionModeChoice;
    cloneForm.elements.emotionMode.dispatchEvent(new Event('change', { bubbles: true }));
  }));
  cloneForm.elements.emotionPreset.addEventListener('change', () => {
    const preset = cloneEmotionPresets[cloneForm.elements.emotionPreset.value];
    if (!preset) return;
    cloneEmotionKeys.forEach((key) => rangeControllers.get(key)?.setValue(preset[key], false));
  });
  cloneEmotionKeys.forEach((key) => cloneForm.elements[key].addEventListener('input', () => {
    cloneForm.elements.emotionPreset.value = 'custom';
  }));
  syncEmotionModeState();
  $('#design-reset-parameters').addEventListener('click', () => {
    const defaults = designParameterDefaults;
    paceSelect.value = defaults.pace;
    volumeSelect.value = defaults.volume;
    paceController.setValue(defaults.paceFactor, false);
    volumeController.setValue(defaults.volumeFactor, false);
    rangeControllers.get('temperature').setValue(defaults.temperature, false);
    designForm.elements.topP.value = String(defaults.topP);
    designForm.elements.topK.value = String(defaults.topK);
    designForm.elements.repetitionPenalty.value = String(defaults.repetitionPenalty);
    designForm.elements.seed.value = String(defaults.seed);
    designForm.elements.candidateCount.value = String(defaults.candidateCount);
    showToast('已恢复音色设计默认参数');
  });
  $('#clone-reset-parameters').addEventListener('click', () => {
    const defaults = cloneParameterDefaults;
    cloneForm.elements.emotionMode.value = defaults.emotionMode;
    cloneForm.elements.emotionText.value = defaults.emotionText;
    setEmotionReference(null);
    cloneForm.elements.emotionPreset.value = defaults.emotionPreset;
    rangeControllers.get('emotionStrength').setValue(defaults.emotionStrength, false);
    rangeControllers.get('durationFactor').setValue(defaults.durationFactor, false);
    cloneEmotionKeys.forEach((key) => rangeControllers.get(key)?.setValue(defaults[key], false));
    cloneForm.elements.intervalSilence.value = String(defaults.intervalSilence);
    cloneForm.elements.temperature.value = String(defaults.temperature);
    cloneForm.elements.topP.value = String(defaults.topP);
    cloneForm.elements.topK.value = String(defaults.topK);
    cloneForm.elements.repetitionPenalty.value = String(defaults.repetitionPenalty);
    cloneForm.elements.seed.value = String(defaults.seed);
    syncEmotionModeState();
    showToast('已恢复音色克隆默认参数');
  });

  $('#description-history-toggle').addEventListener('click', () => {
    const list = $('#description-history-list');
    list.hidden = !list.hidden;
    $('#description-history-toggle').setAttribute('aria-expanded', String(!list.hidden));
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.description-history-anchor')) closeDescriptionHistory();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDescriptionHistory(); });

  $('#clone-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.reference) return showToast('请先选择参考音频');
    const emotionMode = cloneForm.elements.emotionMode.value;
    if (emotionMode === 'audio' && !state.emotionReference) return showToast('请先选择情感参考音频');
    const form = new FormData(event.currentTarget);
    const request = {
      name: form.get('name'), text: form.get('text'), reference: state.reference.path,
      emotionMode,
      emotionText: cloneForm.elements.emotionText.value,
      emotionAudio: state.emotionReference?.path || null,
      emotionPreset: emotionMode === 'custom' ? cloneForm.elements.emotionPreset.value : 'neutral',
      emotionStrength: emotionMode === 'reference' ? 1 : Number(form.get('emotionStrength')),
      emotionVector: cloneEmotionKeys.map((key) => Number(cloneForm.elements[key].value)),
      durationFactor: Number(form.get('durationFactor')), intervalSilence: Number(form.get('intervalSilence')),
      temperature: Number(form.get('temperature')), topP: Number(form.get('topP')), topK: Number(form.get('topK')),
      repetitionPenalty: Number(form.get('repetitionPenalty')), seed: Number(form.get('seed'))
    };
    const result = await runForm($('#clone-submit'), () => window.voiceStudio.synthesizeClone(request), { stayOnPage: true, engine: 'index' });
    if (result) {
      setTaskStatus('克隆完成', '可以试听或保存到音色库', false);
      setCloneProgress(100, '克隆音色生成完成', '可以试听或保存到音色库', 'completed', 'completed');
      setResult(result, request.name, 'clone', '新生成');
    }
  });

  $('#design-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const request = {
      name: form.get('name'),
      text: form.get('text'),
      description: form.get('description'),
      language: form.get('language'),
      pace: form.get('pace'),
      volume: form.get('volume'),
      paceFactor: Number(form.get('paceFactor')),
      volumeFactor: Number(form.get('volumeFactor')),
      temperature: Number(form.get('temperature')),
      topP: Number(form.get('topP')),
      topK: Number(form.get('topK')),
      repetitionPenalty: Number(form.get('repetitionPenalty')),
      seed: Number(form.get('seed'))
    };
    const candidateCount = Math.max(1, Math.min(3, Number(form.get('candidateCount')) || 1));
    const batchId = window.crypto.randomUUID();
    addLocalDescriptionHistory(request.description);
    state.candidates = [];
    $('#design-candidates').classList.add('hidden');
    const results = await runForm($('#design-submit'), async () => {
      const generated = [];
      for (let index = 0; index < candidateCount; index += 1) {
        const label = String.fromCharCode(65 + index);
        setDesignProgress(Math.round((index / candidateCount) * 90), `正在生成候选 ${label}`, `候选 ${index + 1}/${candidateCount}`, 'running', index ? 'synthesizing' : 'prepare');
        const candidateRequest = {
          ...request,
          name: candidateCount > 1 ? `${request.name}·候选 ${label}` : request.name,
          seed: request.seed === -1 ? -1 : (request.seed + index) % 2147483648,
          batchId,
          batchName: request.name,
          candidateCount,
          candidateIndex: index
        };
        const result = await window.voiceStudio.synthesizeDesign(candidateRequest);
        generated.push(result);
        if (index === 0) setResult(result, candidateRequest.name, 'design', '新生成');
        renderCandidates(generated, request.name);
      }
      return generated;
    }, { stayOnPage: true, engine: 'qwen' });
    if (results?.length) {
      setTaskStatus('设计完成', `已生成 ${results.length} 条候选音色`, false);
      setDesignProgress(100, '候选音色生成完成', '请试听并选择满意的一条', 'completed', 'completed');
      renderCandidates(results, request.name);
    }
  });

  $('#cancel-task').addEventListener('click', async () => { const result = await window.voiceStudio.cancelActiveTask(); showToast(result.cancelled ? '已停止当前任务' : '当前没有运行中的任务'); });
  $('#reveal-result').addEventListener('click', () => state.result && window.voiceStudio.revealOutput(state.result.output));
  $('#use-as-reference').addEventListener('click', async () => {
    if (!state.result) return;
    setReference(await window.voiceStudio.useOutputAsReference(state.result.output));
    showPage('clone');
    showToast('当前音色已设为参考音频，可继续输入合成文本');
  });
  $('#save-result').addEventListener('click', async () => {
    if (!state.result) return;
    const button = $('#save-result'); button.disabled = true;
    try {
      const voice = await window.voiceStudio.saveVoice({ output: state.result.output, name: state.result.name, kind: state.result.kind, engine: state.result.engine, seed: state.result.seed, generatedAt: state.result.generatedAt });
      state.result.savedVoiceId = voice.id;
      state.library = [voice, ...state.library.filter((entry) => entry.id !== voice.id)];
      localStorage.setItem(lastSelectionKey, JSON.stringify({ output: state.result.output, name: state.result.name, kind: state.result.kind }));
      renderLibrary(); syncResultSaveState(); showToast('已保存到音色库');
    } catch (error) {
      button.disabled = false; showToast(`保存失败：${error.message}`);
    }
  });
  window.voiceStudio.onTaskEvent((event) => {
    if (event.type === 'progress') {
      setTaskStatus(event.message ?? event.stage, 'GPU 单任务运行中', true);
      if (event.engine === 'qwen') setDesignProgress(event.percent ?? 5, event.message ?? '正在生成设计音色', event.stage === 'synthesizing' ? '引擎正在合成语音，完成前该阶段百分比会保持不变' : '正在执行本地引擎阶段', 'running', event.stage === 'model_ready' ? 'loading_model' : event.stage);
      if (event.engine === 'index') setCloneProgress(event.percent ?? 5, event.message ?? '正在生成克隆音色', '', 'running', event.stage);
      appendLog(`${event.engine === 'qwen' ? '设计引擎' : '克隆引擎'}：${event.message ?? event.stage}`);
    }
    else if (event.type === 'heartbeat') {
      const root = $('#task-status');
      root.querySelector('span').textContent = `本地引擎仍在运行 · 已用 ${event.elapsedSeconds} 秒 · 超过 30 分钟会自动停止`;
      const kind = event.engine === 'qwen' ? 'design' : 'clone';
      const progressRoot = $(`#${kind}-progress`);
      if (progressRoot?.dataset.status === 'running') $(`#${kind}-progress-value`).textContent = `已用 ${event.elapsedSeconds} 秒`;
    }
    else if (event.type === 'log') appendLog(`${event.engine === 'qwen' ? '设计引擎' : '克隆引擎'}：${event.message}`);
    else if (event.type === 'cancelled') { setTaskStatus('任务已停止', '引擎进程已结束', false); if (event.engine === 'qwen') setDesignProgress(0, '设计任务已停止', '引擎进程已结束', 'cancelled'); if (event.engine === 'index') setCloneProgress(0, '克隆任务已停止', '引擎进程已结束', 'cancelled'); appendLog('任务已由用户停止'); refreshWorkspaceData(); }
    else if (event.type === 'completed') { if (event.engine === 'qwen') setDesignProgress(100, '设计音色生成完成', '可以试听、保存或作为克隆参考', 'completed', 'completed'); if (event.engine === 'index') setCloneProgress(100, '克隆音色生成完成', '可以试听或保存到音色库', 'completed', 'completed'); refreshWorkspaceData(); }
    else if (event.type === 'failed') { if (event.engine === 'qwen') setDesignProgress(0, '设计任务失败', event.message || '请查看任务日志', 'failed'); if (event.engine === 'index') setCloneProgress(0, '克隆任务失败', event.message || '请查看任务日志', 'failed'); refreshWorkspaceData(); }
  });
  window.voiceStudio.onRuntimeInstallProgress((event) => {
    const previous = state.runtimeInstall;
    updateRuntimeInstallProgress(event);
    if (event.message !== previous.message || event.stage === 'completed' || event.stage === 'failed') {
      appendLog(`运行环境：${event.message}${Number.isFinite(event.percent) ? `（${event.percent}%）` : ''}`);
    }
    if (event.stage === 'completed' || event.stage === 'failed') showToast(event.message);
  });
  window.voiceStudio.onModelDownloadProgress((event) => {
    const previous = state.modelDownloads[event.engine];
    updateModelDownloadProgress(event);
    if (event.message !== previous?.message || ['completed', 'failed', 'cancelled'].includes(event.stage)) appendLog(`${event.engine === 'index' ? 'IndexTTS 2.5' : 'Qwen VoiceDesign'}：${event.message}`);
    if (event.stage === 'completed') showToast(event.message);
    if (event.stage === 'cancelled') showToast('模型下载已取消，未完成部分将在下次继续');
  });
}

async function bootstrap() {
  installEvents();
  restoreStatusSnapshots();
  state.bootstrap = await window.voiceStudio.getBootstrap();
  state.library = state.bootstrap.library;
  state.tasks = state.bootstrap.tasks;
  state.descriptionHistory = state.bootstrap.descriptionHistory ?? [];
  document.title = state.bootstrap.build?.channel === 'debug' ? '小沐音色工坊 · Debug' : '小沐音色工坊';
  $('#debug-badge')?.classList.toggle('hidden', state.bootstrap.build?.channel !== 'debug');
  restoreLastSelection();
  const { qwen, index, runtime } = state.bootstrap.engines;
  const shouldProbeRuntime = runtime.ready && (runtime.compatible === null || runtime.compatible === undefined);
  state.runtimeProbe.status = shouldProbeRuntime ? 'checking' : 'idle';
  syncEngineAvailability();
  renderEngineSettings(); renderLibrary(); renderTaskHistory(); renderDescriptionHistory();
  appendLog(`克隆引擎：${index.installed ? '已就绪' : '未安装'}`);
  appendLog(`设计引擎：${qwen.installed ? '已就绪' : '未安装'}`);
  void pollSystemStatus();
  void refreshStorage();
  if (shouldProbeRuntime) void probeRuntimeInBackground();
  setInterval(pollSystemStatus, 5000);
}

bootstrap().catch((error) => { console.error(error); showToast(`启动失败：${error.message}`); });
