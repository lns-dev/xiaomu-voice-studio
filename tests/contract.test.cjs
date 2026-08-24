const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EMOTION_PRESETS, validateCloneRequest, validateDesignRequest } = require('../electron/contract.cjs');

test('validates a selected IndexTTS reference and maps emotion preset', () => {
  const reference = path.resolve('C:\\audio\\voice.wav');
  const approved = new Set([reference.toLowerCase()]);
  const result = validateCloneRequest({
    name: '测试音色',
    text: '你好，很高兴认识你。',
    reference,
    emotionPreset: 'warm',
    durationFactor: 1.15
  }, approved);
  assert.equal(result.reference, reference);
  assert.deepEqual(result.emotionVector, EMOTION_PRESETS.warm);
  assert.equal(result.emotionStrength, 1);
  assert.equal(result.intervalSilence, 200);
  assert.equal(result.temperature, 0.8);
  assert.equal(result.seed, -1);
});

test('validates custom IndexTTS emotion and advanced generation controls', () => {
  const reference = path.resolve('C:\\audio\\voice.wav');
  const approved = new Set([reference.toLowerCase()]);
  const vector = [0.4, 0, 0.1, 0, 0, 0, 0.2, 0.3];
  const result = validateCloneRequest({
    name: '自定义克隆', text: '测试自定义情绪。', reference, emotionPreset: 'neutral',
    useCustomEmotion: true, emotionVector: vector, emotionStrength: 0.65, durationFactor: 1.2,
    intervalSilence: 350, temperature: 0.7, topP: 0.85, topK: 24, repetitionPenalty: 8, seed: 42
  }, approved);
  assert.deepEqual(result.emotionVector, vector);
  assert.equal(result.emotionStrength, 0.65);
  assert.equal(result.intervalSilence, 350);
  assert.equal(result.topK, 24);
  assert.equal(result.seed, 42);
});

test('validates official IndexTTS emotion-description text mode', () => {
  const reference = path.resolve('C:\\audio\\voice.wav');
  const approved = new Set([reference.toLowerCase()]);
  const result = validateCloneRequest({
    name: '文本情绪克隆', text: '你终于来啦！', reference,
    emotionMode: 'text', emotionText: '真诚开心，带轻微惊喜，明亮但克制。', emotionStrength: 0.7
  }, approved);
  assert.equal(result.emotionMode, 'text');
  assert.match(result.emotionText, /轻微惊喜/);
  assert.equal(result.emotionVector, null);
  assert.equal(result.emotionStrength, 0.7);
  assert.throws(() => validateCloneRequest({
    name: '空描述', text: '你好', reference, emotionMode: 'text', emotionText: '  '
  }, approved), /emotionText/);
});

test('validates a separately selected IndexTTS emotion reference audio', () => {
  const reference = path.resolve('C:\\audio\\voice.wav');
  const emotionAudio = path.resolve('C:\\audio\\happy.wav');
  const approved = new Set([reference.toLowerCase(), emotionAudio.toLowerCase()]);
  const result = validateCloneRequest({
    name: '情感音频克隆', text: '今天见到你真开心。', reference,
    emotionMode: 'audio', emotionAudio, emotionStrength: 0.65
  }, approved);
  assert.equal(result.emotionMode, 'audio');
  assert.equal(result.emotionAudio, emotionAudio);
  assert.equal(result.emotionVector, null);
  assert.equal(result.emotionStrength, 0.65);
  assert.throws(() => validateCloneRequest({
    name: '未授权情感音频', text: '你好', reference, emotionMode: 'audio', emotionAudio: 'C:\\secret.wav'
  }, approved), /Emotion reference audio/);
});

test('validates using the speaker reference itself as the emotion source', () => {
  const reference = path.resolve('C:\\audio\\voice.wav');
  const result = validateCloneRequest({
    name: '跟随参考表达', text: '你好，很高兴认识你。', reference,
    emotionMode: 'reference', emotionStrength: 0.2
  }, new Set([reference.toLowerCase()]));
  assert.equal(result.emotionMode, 'reference');
  assert.equal(result.emotionAudio, null);
  assert.equal(result.emotionVector, null);
});

test('accepts custom as the default quick-expression state in manual mode', () => {
  const reference = path.resolve('C:\\audio\\voice.wav');
  const vector = [0.2, 0, 0, 0, 0, 0, 0.1, 0.5];
  const result = validateCloneRequest({
    name: '自定义表达', text: '你好。', reference,
    emotionMode: 'custom', emotionPreset: 'custom', emotionVector: vector
  }, new Set([reference.toLowerCase()]));
  assert.equal(result.emotionPreset, 'custom');
  assert.deepEqual(result.emotionVector, vector);
});

test('keeps custom presets out of non-custom emotion modes', () => {
  const reference = path.resolve('C:\\audio\\voice.wav');
  const approved = new Set([reference.toLowerCase()]);
  const result = validateCloneRequest({
    name: '文本情绪克隆', text: '你好。', reference,
    emotionMode: 'text', emotionText: '自然温柔。', emotionPreset: 'neutral'
  }, approved);
  assert.equal(result.emotionPreset, 'neutral');
  assert.throws(() => validateCloneRequest({
    name: '错误预设泄漏', text: '你好。', reference,
    emotionMode: 'text', emotionText: '自然温柔。', emotionPreset: 'custom'
  }, approved), /Custom emotion preset requires custom mode/);
});

test('rejects a renderer supplied reference that was not selected', () => {
  assert.throws(() => validateCloneRequest({
    name: '测试', text: '你好', reference: 'C:\\secret.wav', emotionPreset: 'neutral'
  }, new Set()), /not selected/);
});

test('rejects free-form paths and invalid emotion presets', () => {
  const reference = path.resolve('C:\\audio\\voice.wav');
  assert.throws(() => validateCloneRequest({
    name: '测试', text: '你好', reference, emotionPreset: 'unknown'
  }, new Set([reference.toLowerCase()])), /emotion preset/);
});

test('validates Qwen VoiceDesign text, description, and language', () => {
  const result = validateDesignRequest({
    name: '温柔女声',
    text: '你好，我是小沐。',
    description: '年轻女性，声音清澈温柔，表达自然克制。',
    language: 'Chinese',
    pace: 'relaxed',
    volume: 'soft',
    paceFactor: 0.82,
    volumeFactor: 0.88,
    temperature: 0.8,
    topP: 0.95,
    topK: 40,
    repetitionPenalty: 1.06,
    seed: 123
  });
  assert.equal(result.language, 'Chinese');
  assert.match(result.description, /清澈温柔/);
  assert.equal(result.temperature, 0.8);
  assert.equal(result.seed, 123);
  assert.deepEqual(result.designProfile, { pace: 'relaxed', volume: 'soft', paceFactor: 0.82, volumeFactor: 0.88 });
  assert.match(result.instruction, /年轻女性，声音清澈温柔/);
  assert.match(result.instruction, /语速偏慢且舒缓/);
  assert.match(result.instruction, /音量偏轻/);
  assert.match(result.instruction, /0\.82/);
  assert.match(result.instruction, /0\.88/);
});

test('applies safe Qwen sampling defaults and rejects unsafe values', () => {
  const base = { name: '温柔女声', text: '你好', description: '年轻女性，声音自然。', language: 'Chinese' };
  const result = validateDesignRequest(base);
  assert.deepEqual(
    { temperature: result.temperature, topP: result.topP, topK: result.topK, repetitionPenalty: result.repetitionPenalty, seed: result.seed },
    { temperature: 0.9, topP: 1, topK: 50, repetitionPenalty: 1.05, seed: -1 }
  );
  assert.equal(validateDesignRequest({ ...base, seed: -1 }).seed, -1);
  assert.throws(() => validateDesignRequest({ ...base, temperature: 2 }), /temperature/);
  assert.throws(() => validateDesignRequest({ ...base, seed: 1.5 }), /integer/);
  assert.throws(() => validateDesignRequest({ ...base, seed: -2 }), /seed/);
  assert.throws(() => validateDesignRequest({ ...base, pace: 'racing' }), /design pace/);
  assert.throws(() => validateDesignRequest({ ...base, paceFactor: 1.5 }), /paceFactor/);
});

test('validates candidate batch metadata without accepting arbitrary group ids', () => {
  const base = { name: '温柔女声·候选 B', text: '你好', description: '年轻女性，声音自然。', language: 'Chinese' };
  const result = validateDesignRequest({
    ...base,
    batchId: '0f0d2d7f-0182-4e4b-8a04-512ba4b1db37',
    batchName: '温柔女声',
    candidateCount: 3,
    candidateIndex: 1
  });
  assert.equal(result.batchName, '温柔女声');
  assert.equal(result.candidateLabel, 'B');
  assert.throws(() => validateDesignRequest({ ...base, batchId: '../other', candidateCount: 2, candidateIndex: 0 }), /candidate batch/);
  assert.throws(() => validateDesignRequest({ ...base, batchId: '0f0d2d7f-0182-4e4b-8a04-512ba4b1db37', candidateCount: 2, candidateIndex: 2 }), /candidateIndex/);
});
