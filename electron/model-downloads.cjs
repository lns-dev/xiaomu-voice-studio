const MODEL_DOWNLOAD_URLS = Object.freeze({
  index: 'https://huggingface.co/IndexTeam/IndexTTS-2.5',
  qwen: 'https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'
});

const allowedModelDownloadUrls = new Set(Object.values(MODEL_DOWNLOAD_URLS));

function isAllowedModelDownloadUrl(url) {
  return allowedModelDownloadUrls.has(url);
}

module.exports = { MODEL_DOWNLOAD_URLS, isAllowedModelDownloadUrl };
