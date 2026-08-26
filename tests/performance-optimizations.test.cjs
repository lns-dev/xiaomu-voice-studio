const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

test('workers use a persistent configurable idle timeout and support background warm-up', () => {
  const main = read('electron/main.cjs');
  const preload = read('electron/preload.cjs');
  const html = read('src/index.html');
  assert.match(main, /const defaultWorkerIdleMinutes = 10/);
  assert.match(main, /ipcMain\.handle\('studio:set-worker-idle-minutes'/);
  assert.match(main, /idleMinutes \* 60 \* 1000/);
  assert.match(main, /atomicWriteJson\(preferencesPath\(\), studioPreferences\)/);
  assert.match(main, /ipcMain\.handle\('studio:warm-engine'/);
  assert.match(main, /warm\(reference = null\)[\s\S]*type: 'warmup'/);
  assert.match(main, /if \(!worker\.child\) await enforceColdStartResources\(engine\)/);
  assert.doesNotMatch(main, /!worker\.child \|\| !worker\.modelLoaded/);
  assert.match(preload, /setWorkerIdleMinutes: \(minutes\) => ipcRenderer\.invoke\('studio:set-worker-idle-minutes', minutes\)/);
  assert.match(preload, /warmEngine: \(engine, reference = null\) => ipcRenderer\.invoke\('studio:warm-engine', engine, reference\)/);
  assert.match(html, /id="worker-idle-summary"/);
  assert.match(html, /id="idle-policy-settings"/);
});

test('clone text emotion is validated in the renderer before remote synthesis', () => {
  const app = read('src/app.mjs');
  assert.match(app, /emotionMode === 'text' && !cloneForm\.elements\.emotionText\.value\.trim\(\)/);
  assert.match(app, /请先填写情绪描述/);
});

test('optional executable paths are rejected before filesystem probing', () => {
  const main = read('electron/main.cjs');
  const audioTools = read('electron/audio-tools.cjs');
  assert.match(main, /typeof filePath !== 'string' \|\| !filePath/);
  assert.match(audioTools, /if \(!ffmpegPath \|\| !ffprobePath\)/);
});

test('release checksum generation follows package and runtime manifest versions', () => {
  const script = read('scripts/generate-release-checksums.cjs');
  assert.match(script, /packageMetadata\.version/);
  assert.match(script, /runtimeManifest\.runtimeVersion/);
  assert.match(script, /releaseStagingRoot/);
  assert.doesNotMatch(script, /XiaoMuVoiceStudio-0\.1\.0-alpha\.3/);
});

test('renderer prewarms engine pages and coalesces background refresh work', () => {
  const app = read('src/app.mjs');
  assert.match(app, /function scheduleEngineWarm\(pageName\)/);
  assert.match(app, /pageName === 'design' \? 'qwen' : pageName === 'clone' \? 'index'/);
  assert.match(app, /if \(workspaceRefreshPromise\) return workspaceRefreshPromise/);
  assert.match(app, /document\.visibilityState === 'hidden' \|\| systemStatusPromise/);
  assert.match(app, /function idlePolicyCard\(preferences = \{\}\)/);
  assert.match(app, /state\.bootstrap\.preferences = await window\.voiceStudio\.setWorkerIdleMinutes\(requested\)/);
});

test('inference workers use inference mode and retain reusable conditioning', () => {
  const qwen = read('python/qwen_voice_design_worker.py');
  const index = read('python/indextts_worker.py');
  assert.match(qwen, /command\.get\("type"\) == "warmup"/);
  assert.match(qwen, /with torch\.inference_mode\(\):/);
  assert.match(qwen, /free_cuda_bytes >= 4608 \* 1024\*\*2/);
  assert.match(qwen, /tokenizer_device = "cuda:0" if use_cuda_tokenizer else "cpu"/);
  assert.match(index, /self\.emotion_analyzer = None/);
  assert.match(index, /if self\.emotion_analyzer is None:/);
  assert.match(index, /with self\.torch\.inference_mode\(\):/);
  assert.match(index, /def prepare_reference\(self, job_id: str, reference: str\)/);
  assert.match(index, /tts\.cache_spk_audio_prompt = reference/);
  assert.match(index, /tts\.cache_emo_audio_prompt = reference/);
  assert.match(index, /cached_inputs\[0\] is input_features and cached_inputs\[1\] is attention_mask/);
});

test('generated results become references before expensive waveform analysis finishes', () => {
  const main = read('electron/main.cjs');
  const preload = read('electron/preload.cjs');
  const app = read('src/app.mjs');
  assert.match(main, /const referenceAnalysisCache = new Map\(\)/);
  assert.match(main, /ipcMain\.handle\('studio:use-output-as-reference'[\s\S]*analysisPending: !analysis/);
  assert.match(main, /ipcMain\.handle\('studio:analyze-approved-reference'/);
  assert.match(preload, /analyzeApprovedReference: \(inputPath\) => ipcRenderer\.invoke\('studio:analyze-approved-reference', inputPath\)/);
  assert.match(app, /showPage\('clone'\);[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*analyzeApprovedReference/);
  assert.match(app, /function applyReferenceAnalysis\(referencePath, analysis\)/);
});
