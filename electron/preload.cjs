const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceStudio', {
  getBootstrap: () => ipcRenderer.invoke('studio:bootstrap'),
  pickReferenceAudio: () => ipcRenderer.invoke('studio:pick-reference'),
  pickEmotionReferenceAudio: () => ipcRenderer.invoke('studio:pick-emotion-reference'),
  trimReferenceAudio: (request) => ipcRenderer.invoke('studio:trim-reference', request),
  useOutputAsReference: (outputPath) => ipcRenderer.invoke('studio:use-output-as-reference', outputPath),
  getSystemStatus: () => ipcRenderer.invoke('studio:system-status'),
  getStorageStatus: () => ipcRenderer.invoke('studio:storage-status'),
  cleanupStorage: (request) => ipcRenderer.invoke('studio:cleanup-storage', request),
  detectModels: () => ipcRenderer.invoke('studio:detect-models'),
  addModelLocation: (engine) => ipcRenderer.invoke('studio:add-model-location', engine),
  probeRuntime: () => ipcRenderer.invoke('studio:probe-runtime'),
  addRuntimeLocation: () => ipcRenderer.invoke('studio:add-runtime-location'),
  installRuntime: () => ipcRenderer.invoke('studio:install-runtime'),
  openModelDownload: (url) => ipcRenderer.invoke('studio:open-model-download', url),
  downloadModel: (engine) => ipcRenderer.invoke('studio:download-model', engine),
  cancelModelDownload: (engine) => ipcRenderer.invoke('studio:cancel-model-download', engine),
  synthesizeClone: (request) => ipcRenderer.invoke('studio:synthesize-clone', request),
  synthesizeDesign: (request) => ipcRenderer.invoke('studio:synthesize-design', request),
  cancelActiveTask: () => ipcRenderer.invoke('studio:cancel-active'),
  retryTask: (taskId) => ipcRenderer.invoke('studio:retry-task', taskId),
  revealOutput: (outputPath) => ipcRenderer.invoke('studio:reveal-output', outputPath),
  copyText: (text) => ipcRenderer.invoke('studio:copy-text', text),
  saveVoice: (voice) => ipcRenderer.invoke('studio:save-voice', voice),
  renameVoice: (request) => ipcRenderer.invoke('studio:rename-voice', request),
  favoriteVoice: (voiceId) => ipcRenderer.invoke('studio:favorite-voice', voiceId),
  deleteVoice: (voiceId) => ipcRenderer.invoke('studio:delete-voice', voiceId),
  deleteTask: (taskId) => ipcRenderer.invoke('studio:delete-task', taskId),
  deleteDescriptionHistory: (description) => ipcRenderer.invoke('studio:delete-description-history', description),
  onTaskEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('studio:task-event', listener);
    return () => ipcRenderer.removeListener('studio:task-event', listener);
  },
  onRuntimeInstallProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('studio:runtime-install-progress', listener);
    return () => ipcRenderer.removeListener('studio:runtime-install-progress', listener);
  },
  onModelDownloadProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('studio:model-download-progress', listener);
    return () => ipcRenderer.removeListener('studio:model-download-progress', listener);
  }
});
