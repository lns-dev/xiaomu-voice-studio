const path = require('node:path');

const EMOTION_PRESETS = Object.freeze({
  neutral: [0, 0, 0, 0, 0, 0, 0, 0.55],
  warm: [0.08, 0, 0, 0, 0, 0, 0.08, 0.46],
  happy: [0.72, 0, 0, 0, 0, 0, 0.10, 0.18],
  concerned: [0, 0, 0.20, 0.04, 0, 0, 0.05, 0.55],
  playful: [0.48, 0, 0, 0, 0, 0, 0.22, 0.20]
});

const EMOTION_MODES = new Set(['text', 'audio', 'reference', 'preset', 'custom']);

const DESIGN_PROFILE_OPTIONS = Object.freeze({
  pace: Object.freeze({ relaxed: '语速偏慢且舒缓', normal: '自然语速', brisk: '语速偏快且利落' }),
  volume: Object.freeze({ soft: '音量偏轻但清晰', normal: '自然音量', loud: '音量较强但不喊叫' })
});

const DESIGN_FINE_DEFAULTS = Object.freeze({
  pace: Object.freeze({ relaxed: 0.85, normal: 1, brisk: 1.15 }),
  volume: Object.freeze({ soft: 0.85, normal: 1, loud: 1.15 })
});

function requireText(value, name, maxLength) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be text`);
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (!normalized) throw new Error(`${name} cannot be empty`);
  if (normalized.length > maxLength) throw new Error(`${name} is too long`);
  return normalized;
}

function requireLanguage(value) {
  const allowed = new Set(['Auto', 'Chinese', 'English', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian']);
  if (!allowed.has(value)) throw new Error('Unsupported language');
  return value;
}

function requireSafeName(value) {
  const name = requireText(value, 'name', 60).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim();
  if (!name) throw new Error('Name contains no usable characters');
  return name;
}

function requireNumber(value, name, minimum, maximum, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function requireInteger(value, name, minimum, maximum, fallback) {
  const number = requireNumber(value, name, minimum, maximum, fallback);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
}

function requireProfileOption(group, value, fallback) {
  const selected = value ?? fallback;
  if (!Object.hasOwn(DESIGN_PROFILE_OPTIONS[group], selected)) throw new Error(`Unsupported design ${group}`);
  return selected;
}

function validateCloneRequest(input, approvedReferences) {
  if (!input || typeof input !== 'object') throw new TypeError('Invalid clone request');
  const reference = path.resolve(requireText(input.reference, 'reference', 2048));
  if (!approvedReferences.has(reference.toLowerCase())) throw new Error('Reference audio was not selected in this app');
  const preset = input.emotionPreset ?? 'neutral';
  const durationFactor = Number(input.durationFactor ?? 1);
  if (!Number.isFinite(durationFactor) || durationFactor < 0.7 || durationFactor > 1.8) {
    throw new Error('Duration factor must be between 0.7 and 1.8');
  }
  const emotionStrength = requireNumber(input.emotionStrength, 'emotionStrength', 0, 1, 1);
  const legacyCustomMode = input.useCustomEmotion === true;
  const emotionMode = input.emotionMode ?? (legacyCustomMode ? 'custom' : 'preset');
  if (!EMOTION_MODES.has(emotionMode)) throw new Error('Unsupported emotion control mode');
  if (preset === 'custom') {
    if (emotionMode !== 'custom') throw new Error('Custom emotion preset requires custom mode');
  } else if (!Object.hasOwn(EMOTION_PRESETS, preset)) throw new Error('Unsupported emotion preset');
  const emotionText = emotionMode === 'text' ? requireText(input.emotionText, 'emotionText', 300) : null;
  const emotionAudio = emotionMode === 'audio'
    ? path.resolve(requireText(input.emotionAudio, 'emotionAudio', 2048))
    : null;
  if (emotionAudio && !approvedReferences.has(emotionAudio.toLowerCase())) {
    throw new Error('Emotion reference audio was not selected in this app');
  }
  const useCustomEmotion = emotionMode === 'custom';
  const customEmotionVector = Array.isArray(input.emotionVector)
    ? input.emotionVector.map((value, index) => requireNumber(value, `emotionVector[${index}]`, 0, 1, 0))
    : [];
  if (useCustomEmotion && customEmotionVector.length !== 8) throw new Error('Custom emotion vector must contain 8 values');
  const emotionVector = ['text', 'audio', 'reference'].includes(emotionMode) ? null : (useCustomEmotion ? customEmotionVector : EMOTION_PRESETS[preset]);
  return {
    name: requireSafeName(input.name ?? '克隆音色'),
    text: requireText(input.text, 'text', 800),
    reference,
    emotionPreset: preset,
    emotionMode,
    emotionText,
    emotionAudio,
    emotionStrength,
    useCustomEmotion,
    emotionVector,
    durationFactor,
    intervalSilence: requireInteger(input.intervalSilence, 'intervalSilence', 0, 1000, 200),
    temperature: requireNumber(input.temperature, 'temperature', 0.1, 2, 0.8),
    topP: requireNumber(input.topP, 'topP', 0.1, 1, 0.8),
    topK: requireInteger(input.topK, 'topK', 0, 100, 30),
    repetitionPenalty: requireNumber(input.repetitionPenalty, 'repetitionPenalty', 0.1, 20, 10),
    seed: requireInteger(input.seed, 'seed', -1, 2147483647, -1)
  };
}

function validateDesignRequest(input) {
  if (!input || typeof input !== 'object') throw new TypeError('Invalid design request');
  const profile = {
    pace: requireProfileOption('pace', input.pace, 'relaxed'),
    volume: requireProfileOption('volume', input.volume, 'normal')
  };
  const description = requireText(input.description, 'description', 500);
  const profileInstruction = Object.entries(profile).map(([group, value]) => DESIGN_PROFILE_OPTIONS[group][value]).join('、');
  const paceFactor = requireNumber(input.paceFactor, 'paceFactor', 0.7, 1.3, DESIGN_FINE_DEFAULTS.pace[profile.pace]);
  const volumeFactor = requireNumber(input.volumeFactor, 'volumeFactor', 0.7, 1.3, DESIGN_FINE_DEFAULTS.volume[profile.volume]);
  const paceDetail = paceFactor < 0.92 ? '明显舒缓' : paceFactor < 0.98 ? '略慢' : paceFactor <= 1.02 ? '接近自然' : paceFactor <= 1.08 ? '略快' : '明显利落';
  const volumeDetail = volumeFactor < 0.92 ? '明显轻柔' : volumeFactor < 0.98 ? '略轻' : volumeFactor <= 1.02 ? '接近自然' : volumeFactor <= 1.08 ? '略强' : '明显有力';
  const batchId = input.batchId === undefined || input.batchId === null || input.batchId === '' ? null : String(input.batchId);
  if (batchId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(batchId)) throw new Error('Invalid candidate batch');
  const candidateCount = batchId ? requireInteger(input.candidateCount, 'candidateCount', 1, 3, 1) : 1;
  const candidateIndex = batchId ? requireInteger(input.candidateIndex, 'candidateIndex', 0, candidateCount - 1, 0) : 0;
  return {
    name: requireSafeName(input.name ?? '设计音色'),
    text: requireText(input.text, 'text', 800),
    description,
    designProfile: { ...profile, paceFactor, volumeFactor },
    instruction: `${description}。表达控制：${profileInstruction}；语速精调为${paceDetail}（${paceFactor.toFixed(2)}，1.00为自然，数值越大越快）；音量精调为${volumeDetail}（${volumeFactor.toFixed(2)}，1.00为自然，数值越大越强）。`,
    language: requireLanguage(input.language ?? 'Chinese'),
    temperature: requireNumber(input.temperature, 'temperature', 0.3, 1.5, 0.9),
    topP: requireNumber(input.topP, 'topP', 0.1, 1, 1),
    topK: requireInteger(input.topK, 'topK', 1, 100, 50),
    repetitionPenalty: requireNumber(input.repetitionPenalty, 'repetitionPenalty', 1, 1.3, 1.05),
    seed: requireInteger(input.seed, 'seed', -1, 2147483647, -1),
    batchId,
    batchName: batchId ? requireSafeName(input.batchName ?? input.name ?? '设计音色') : null,
    candidateCount,
    candidateIndex,
    candidateLabel: batchId ? String.fromCharCode(65 + candidateIndex) : null
  };
}

module.exports = { EMOTION_PRESETS, DESIGN_PROFILE_OPTIONS, validateCloneRequest, validateDesignRequest };
