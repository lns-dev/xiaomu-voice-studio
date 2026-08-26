const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let configuredToolRoots = [];

function configureAudioTools(roots) {
  configuredToolRoots = (Array.isArray(roots) ? roots : [roots]).filter(Boolean).map((root) => path.resolve(root));
}

function resolveTool(name) {
  const fromPath = String(process.env.PATH || '').split(path.delimiter).map((entry) => path.join(entry, name));
  const candidates = [...configuredToolRoots.map((root) => path.join(root, name)), ...fromPath];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function assertTools() {
  const ffmpegPath = resolveTool('ffmpeg.exe');
  const ffprobePath = resolveTool('ffprobe.exe');
  if (!ffmpegPath || !ffprobePath) {
    throw new Error('参考音频检测工具未安装，请在“引擎设置”中检查 FFmpeg');
  }
  return { ffmpegPath, ffprobePath };
}

function runCapture(executable, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => `${current}${chunk.toString('utf8')}`.slice(-2_000_000);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('参考音频处理超时'));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`参考音频处理失败：${stderr.trim().slice(-400) || `exit ${code}`}`));
      resolve({ stdout, stderr });
    });
  });
}

function runBufferCapture(executable, args, timeoutMs = 120000, maximumBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        child.kill();
        reject(new Error('参考音频声纹数据过大'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('参考音频声纹生成超时')); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`参考音频声纹生成失败：${stderr.trim().slice(-300) || `exit ${code}`}`));
      resolve(Buffer.concat(chunks));
    });
  });
}

function waveformFromPixels(buffer, barCount = 72, height = 128) {
  if (buffer.length < barCount * height) return Array(barCount).fill(0);
  const peaks = [];
  for (let bar = 0; bar < barCount; bar += 1) {
    let top = height;
    let bottom = -1;
    for (let row = 0; row < height; row += 1) {
      if (buffer[(row * barCount) + bar] <= 8) continue;
      top = Math.min(top, row);
      bottom = Math.max(bottom, row);
    }
    peaks.push(bottom < 0 ? 0 : (bottom - top + 1) / height);
  }
  const maximum = Math.max(...peaks, 0.001);
  return peaks.map((peak) => Number(Math.max(0, Math.min(1, peak / maximum)).toFixed(3)));
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseLoudnorm(stderr) {
  const matches = [...stderr.matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/g)];
  if (!matches.length) return { integratedLufs: null, truePeakDb: null, loudnessRangeLu: null };
  try {
    const data = JSON.parse(matches.at(-1)[0]);
    return {
      integratedLufs: numberOrNull(data.input_i),
      truePeakDb: numberOrNull(data.input_tp),
      loudnessRangeLu: numberOrNull(data.input_lra)
    };
  } catch {
    return { integratedLufs: null, truePeakDb: null, loudnessRangeLu: null };
  }
}

function parseSilence(stderr, durationSeconds) {
  const durations = [...stderr.matchAll(/silence_duration:\s*([0-9.]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite);
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    silenceSeconds: Number(total.toFixed(3)),
    silenceRatio: durationSeconds > 0 ? Number(Math.min(1, total / durationSeconds).toFixed(3)) : 0
  };
}

async function analyzeAudio(inputPath) {
  const { ffmpegPath, ffprobePath } = assertTools();
  const resolved = path.resolve(inputPath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size <= 0) throw new Error('参考音频文件无效');
  if (stat.size > 1024 ** 3) throw new Error('参考音频文件不能超过 1GB');
  const probe = await runCapture(ffprobePath, [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels,channel_layout',
    '-show_entries', 'format=duration,bit_rate', '-of', 'json', resolved
  ]);
  const parsed = JSON.parse(probe.stdout || '{}');
  const stream = parsed.streams?.[0];
  const durationSeconds = numberOrNull(parsed.format?.duration);
  if (!stream || !durationSeconds || durationSeconds <= 0) throw new Error('文件中没有可用的音频轨道');
  const [loudness, silence, waveformPcm] = await Promise.all([
    runCapture(ffmpegPath, ['-hide_banner', '-nostdin', '-i', resolved, '-map', '0:a:0', '-af', 'loudnorm=I=-20:TP=-1.5:LRA=11:print_format=json', '-f', 'null', 'NUL']).then(({ stderr }) => parseLoudnorm(stderr)),
    runCapture(ffmpegPath, ['-hide_banner', '-nostdin', '-i', resolved, '-map', '0:a:0', '-af', 'silencedetect=noise=-45dB:d=0.25', '-f', 'null', 'NUL']).then(({ stderr }) => parseSilence(stderr, durationSeconds)),
    runBufferCapture(ffmpegPath, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', resolved,
      '-filter_complex', '[0:a:0]aformat=channel_layouts=mono,showwavespic=s=72x128:split_channels=0:colors=white:scale=lin:draw=full',
      '-frames:v', '1', '-an', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'
    ], 120000, 65536)
  ]);
  const sampleRate = Number(stream.sample_rate) || null;
  const channels = Number(stream.channels) || null;
  const issues = [];
  if (durationSeconds < 3) issues.push('有效时长偏短，建议至少 5 秒');
  if (durationSeconds > 30) issues.push('音频偏长，建议裁剪到 5–15 秒');
  if (sampleRate && sampleRate < 16000) issues.push('采样率偏低，可能损失音色细节');
  if (channels && channels > 1) issues.push('多声道音频会在裁剪副本中安全混为单声道');
  if (loudness.truePeakDb !== null && loudness.truePeakDb > -0.3) issues.push('峰值接近削波，建议降低录音增益');
  if (loudness.integratedLufs !== null && loudness.integratedLufs < -35) issues.push('人声音量偏低，可能包含较多底噪');
  if (silence.silenceRatio > 0.35) issues.push('静音占比较高，建议裁掉无声片段');
  return {
    path: resolved,
    name: path.basename(resolved),
    sizeBytes: stat.size,
    codec: stream.codec_name || 'unknown',
    sampleRate,
    channels,
    channelLayout: stream.channel_layout || null,
    durationSeconds: Number(durationSeconds.toFixed(3)),
    bitRate: Number(parsed.format?.bit_rate) || null,
    ...loudness,
    ...silence,
    waveform: waveformFromPixels(waveformPcm),
    status: issues.length ? 'warning' : 'ready',
    issues
  };
}

async function createReferenceCopy(inputPath, outputPath, startSeconds, endSeconds, normalize = true) {
  const { ffmpegPath } = assertTools();
  const duration = endSeconds - startSeconds;
  const resolvedOutput = path.resolve(outputPath);
  const temporary = `${resolvedOutput}.${process.pid}.part.wav`;
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', String(startSeconds), '-i', path.resolve(inputPath), '-t', String(duration), '-map', '0:a:0', '-vn'];
  if (normalize) args.push('-af', 'loudnorm=I=-20:TP=-1.5:LRA=11');
  args.push('-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', temporary);
  try {
    await runCapture(ffmpegPath, args, 180000);
    const temporaryAnalysis = await analyzeAudio(temporary);
    fs.renameSync(temporary, resolvedOutput);
    return { ...temporaryAnalysis, path: resolvedOutput, name: path.basename(resolvedOutput) };
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort cleanup */ }
    throw error;
  }
}

module.exports = { analyzeAudio, createReferenceCopy, configureAudioTools, resolveTool };
