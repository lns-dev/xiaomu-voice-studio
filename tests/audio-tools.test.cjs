const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeAudio, createReferenceCopy, configureAudioTools, resolveTool } = require('../electron/audio-tools.cjs');

configureAudioTools([process.env.XIAOMU_FFMPEG_ROOT]);
const ffmpegAvailable = Boolean(resolveTool('ffmpeg.exe') && resolveTool('ffprobe.exe'));

function writeToneWav(target, durationSeconds = 4, sampleRate = 24000) {
  const frames = Math.round(durationSeconds * sampleRate);
  const dataBytes = frames * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 220 * frame) / sampleRate) * 5000);
    buffer.writeInt16LE(sample, 44 + frame * 2);
  }
  fs.writeFileSync(target, buffer);
}

test('analyzes and safely trims a reference WAV without replacing the source', { skip: !ffmpegAvailable }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-studio-audio-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.wav');
  const trimmed = path.join(root, 'trimmed.wav');
  writeToneWav(source);
  const sourceHash = fs.statSync(source).size;
  const analysis = await analyzeAudio(source);
  assert.equal(analysis.sampleRate, 24000);
  assert.equal(analysis.channels, 1);
  assert.ok(analysis.durationSeconds >= 3.99 && analysis.durationSeconds <= 4.01);
  assert.ok(Number.isFinite(analysis.integratedLufs));
  assert.equal(analysis.waveform.length, 72);
  assert.ok(analysis.waveform.every((value) => value >= 0 && value <= 1));
  const trimmedAnalysis = await createReferenceCopy(source, trimmed, 0.5, 3.5, true);
  assert.ok(fs.existsSync(trimmed));
  assert.equal(fs.statSync(source).size, sourceHash);
  assert.equal(trimmedAnalysis.channels, 1);
  assert.equal(trimmedAnalysis.sampleRate, 24000);
  assert.ok(trimmedAnalysis.durationSeconds >= 2.99 && trimmedAnalysis.durationSeconds <= 3.01);
});

test('keeps silent regions on the full waveform timeline', { skip: !ffmpegAvailable }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-studio-waveform-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'silence-tone-silence.wav');
  writeToneWav(source, 6);
  const file = fs.readFileSync(source);
  const sampleRate = file.readUInt32LE(24);
  const startSilenceFrames = sampleRate * 2;
  const endSilenceStart = sampleRate * 4;
  file.fill(0, 44, 44 + startSilenceFrames * 2);
  file.fill(0, 44 + endSilenceStart * 2);
  fs.writeFileSync(source, file);

  const analysis = await analyzeAudio(source);
  assert.equal(analysis.waveform.length, 72);
  assert.ok(analysis.waveform.slice(0, 20).every((value) => value === 0));
  assert.ok(analysis.waveform.slice(26, 46).some((value) => value > 0.9));
  assert.ok(analysis.waveform.slice(52).every((value) => value === 0));
});
