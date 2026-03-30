const { EndBehaviorType, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk');
const { PassThrough } = require('stream');
const prism = require('prism-media');
const http = require('http');
const FormData = require('form-data');

ffmpeg.setFfmpegPath(ffmpegPath);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ====== 設定 ======
const GROQ_SILENCE_TIMEOUT_MS = 800;    //  Groq 靜音等待
const VOSK_SILENCE_TIMEOUT_MS = 800;   //  Vosk 靜音等待
const VOSK_MAX_DURATION_MS = 1000;      //  Vosk 最長錄音時間
const WAKE_SOUND_PATH = path.join(__dirname, '/sttwakeupvoice.wav');
const AWAKE_TIMEOUT_MS = 5000;

const VOSK_SERVER_URL = process.env.VOSK_SERVER_URL || 'http://127.0.0.1:5050';

const WAKE_WORDS = [
  '宝宝', '寶寶', '抱抱', '宝包', '寶包', '包包', '寶貝', '儀器', '仪器', '豆包',
  '機器鳥', '机器鸟',
  '機器牛', '机器牛',
  '機器妞', '机器妞',
  '機器扭', '机器扭',
  '雞器鳥', '鸡器鸟',
  '機氣鳥', '机气鸟',
  '機器鈕', '机器钮',
];

const CONF_THRESHOLD = 0.6;
const AVG_CONF_THRESHOLD = 0.5;

// ✅ 並發控制
const VOSK_MAX_CONCURRENT = 4;   // 同時最多 4 個 Vosk 辨識
const GROQ_MAX_CONCURRENT = 3;   // 同時最多 3 個 Groq 辨識
let voskConcurrent = 0;
let groqConcurrent = 0;

const guildStates = new Map();

// ====== Vosk 伺服器通訊 ======

async function recognizeWithVosk(pcmBuffer) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', pcmBuffer, {
      filename: 'audio.pcm',
      contentType: 'application/octet-stream',
    });

    const url = new URL(`${VOSK_SERVER_URL}/recognize-raw`);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: form.getHeaders(),
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve({
              text: json.text || '',
              words: json.words || [],
              avg_conf: json.avg_conf ?? 0,
            });
          } catch (e) {
            reject(new Error(`Vosk 回應解析失敗：${data}`));
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Vosk 伺服器超時'));
    });

    form.pipe(req);
  });
}

function filterByConfidence(words, threshold = CONF_THRESHOLD) {
  const passed = [];
  const dropped = [];

  for (const w of words) {
    const conf = w.conf ?? 1;
    if (conf >= threshold) {
      passed.push(w.word);
    } else {
      dropped.push(`${w.word}(${conf.toFixed(2)})`);
    }
  }

  return { filtered: passed.join(''), dropped };
}

async function checkVoskHealth() {
  return new Promise((resolve) => {
    const url = new URL(`${VOSK_SERVER_URL}/health`);

    const req = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname, timeout: 5000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.status === 'ok');
          } catch {
            resolve(false);
          }
        });
      }
    );

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ====== 音效播放 ======

function playWakeSound(connection) {
  try {
    if (!fs.existsSync(WAKE_SOUND_PATH)) {
      console.warn(`[STT] ⚠️ 找不到喚醒音效：${WAKE_SOUND_PATH}`);
      return;
    }

    const player = createAudioPlayer();
    const resource = createAudioResource(WAKE_SOUND_PATH);

    connection.subscribe(player);
    player.play(resource);

    player.on(AudioPlayerStatus.Idle, () => player.stop());
    player.on('error', (err) => console.error(`[STT] ❌ 播放喚醒音效失敗：${err.message}`));
  } catch (err) {
    console.error(`[STT] ❌ 播放喚醒音效例外：${err.message}`);
  }
}

// ====== 主要邏輯 ======

async function startSTTListening(connection, guild, textChannel, onTranscribed) {
  const guildId = guild.id;

  const voskOk = await checkVoskHealth();
  if (!voskOk) {
    console.error(`[STT] ❌ Vosk 伺服器無回應（${VOSK_SERVER_URL}），請確認 Python 服務已啟動`);
    return;
  }

  console.log(`[STT] ✅ 開始監聽 Guild: ${guild.name}`);

  const speakingHandler = (userId) => {
    const state = guildStates.get(guildId);
    if (!state?.listening) return;

    if (state.activeStreams.has(userId)) return;
    if (state.activeUserId && state.activeUserId !== userId) return;

    if (!state.activeUserId) {
      handleLocalWakeDetection(connection, guild, textChannel, userId, onTranscribed);
    } else if (state.activeUserId === userId) {
      handleGroqTranscription(connection, guild, textChannel, userId, onTranscribed);
    }
  };

  guildStates.set(guildId, {
    listening: true,
    activeUserId: null,
    activeStreams: new Set(),
    connection,
    awakeTimer: null,
    speakingHandler,
  });

  connection.receiver.speaking.setMaxListeners(30);
  connection.receiver.speaking.on('start', speakingHandler);
}

/**
 * 待機模式：錄音最多 VOSK_MAX_DURATION_MS → 降採樣 → Vosk → 喚醒詞偵測
 */
function handleLocalWakeDetection(connection, guild, textChannel, userId, onTranscribed) {
  const guildId = guild.id;
  const state = guildStates.get(guildId);
  if (!state) return;

  // ✅ Vosk 並發限制
  if (voskConcurrent >= VOSK_MAX_CONCURRENT) {
    console.log(`[STT] ⚠️ Vosk 並發已滿（${voskConcurrent}），跳過用戶 ${userId}`);
    return;
  }

  state.activeStreams.add(userId);
  voskConcurrent++;

  const opusStream = connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: VOSK_SILENCE_TIMEOUT_MS,  // ✅ 縮短靜音等待
    },
  });

  opusStream.setMaxListeners(20);

  const opusDecoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });

  const pcmChunks = [];
  const passThrough = new PassThrough();
  let forceStopped = false;

  passThrough.on('data', (chunk) => {
    pcmChunks.push(chunk);
  });

  opusStream.pipe(opusDecoder).pipe(passThrough);

  // ✅ 強制截斷：超過 VOSK_MAX_DURATION_MS 就停止錄音
  const forceStopTimer = setTimeout(() => {
    if (!forceStopped) {
      forceStopped = true;
      console.log(`[STT] ✂️ Vosk 強制截斷（用戶：${userId}，超過 ${VOSK_MAX_DURATION_MS}ms）`);
      opusStream.destroy();
      passThrough.end();
    }
  }, VOSK_MAX_DURATION_MS);

  opusStream.on('end', () => {
    if (!forceStopped) {
      clearTimeout(forceStopTimer);
      passThrough.end();
    }
  });

  passThrough.on('end', async () => {
    clearTimeout(forceStopTimer);
    voskConcurrent--;

    const currentState = guildStates.get(guildId);
    if (currentState) currentState.activeStreams.delete(userId);

    const fullBuffer = Buffer.concat(pcmChunks);

    if (fullBuffer.length < 1000) return;

    const monoBuffer = downsampleTo16kMono(fullBuffer, 48000, 2);

    try {
      const { text: rawText, words, avg_conf } = await recognizeWithVosk(monoBuffer);

      if (!rawText) return;

      if (avg_conf < AVG_CONF_THRESHOLD) {
        console.log(`[STT] ⚠️ [Vosk] 用戶 ${userId} 信心分數過低（${avg_conf.toFixed(2)}），忽略`);
        return;
      }

      const { filtered: recognizedText, dropped } = filterByConfidence(words);

      if (dropped.length > 0) {
        console.log(`[STT] ⚠️ [Vosk] 過濾低信心詞：${dropped.join(', ')}`);
      }

      const wakeDetected =
        WAKE_WORDS.some((word) => recognizedText.includes(word)) ||
        WAKE_WORDS.some((word) => rawText.includes(word));

      if (wakeDetected) {
        console.log(`[STT] ✅ 偵測到喚醒詞！用戶：${userId}，辨識：「${recognizedText || rawText}」`);

        const state = guildStates.get(guildId);
        if (!state) return;

        state.activeUserId = userId;
        playWakeSound(state.connection);

        const member = guild.members.cache.get(userId);
        const displayName = member?.displayName || userId;

        textChannel.send(`🎙️ **${displayName}** 說吧，我在聽`);

        if (state.awakeTimer) clearTimeout(state.awakeTimer);
        state.awakeTimer = setTimeout(() => {
          const currentState = guildStates.get(guildId);
          if (currentState?.activeUserId === userId) {
            currentState.activeUserId = null;
            currentState.awakeTimer = null;
            textChannel.send(`⏱️ 等太久了，回到待機模式`);
            console.log(`[STT] ⏱️ 喚醒超時，回到待機（用戶：${userId}）`);
          }
        }, AWAKE_TIMEOUT_MS);
      }
    } catch (err) {
      console.error(`[STT] ❌ Vosk 通訊失敗：${err.message}`);
    }
  });

  opusDecoder.on('error', (err) => {
    clearTimeout(forceStopTimer);
    voskConcurrent--;
    const currentState = guildStates.get(guildId);
    if (currentState) currentState.activeStreams.delete(userId);
    console.error(`[STT] ❌ Opus 解碼錯誤：${err.message}`);
  });
}

/**
 * 已喚醒模式：錄音送 Groq API 轉錄（靜音等待縮短）
 */
function handleGroqTranscription(connection, guild, textChannel, userId, onTranscribed) {
  const guildId = guild.id;
  const state = guildStates.get(guildId);
  if (!state) return;

  // ✅ Groq 並發限制
  if (groqConcurrent >= GROQ_MAX_CONCURRENT) {
    console.log(`[STT] ⚠️ Groq 並發已滿（${groqConcurrent}），跳過用戶 ${userId}`);
    return;
  }

  state.activeStreams.add(userId);
  groqConcurrent++;

  const tempDir = path.join(__dirname, '../../temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const outputPath = path.join(tempDir, `stt_${guildId}_${userId}_${Date.now()}.wav`);

  if (state?.awakeTimer) {
    clearTimeout(state.awakeTimer);
    state.awakeTimer = null;
  }

  console.log(`[STT] 🎙️ 錄製指令中（用戶：${userId}）`);

  const opusStream = connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: GROQ_SILENCE_TIMEOUT_MS,  // ✅ 縮短靜音等待
    },
  });

  opusStream.setMaxListeners(20);

  const opusDecoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });

  let receivedBytes = 0;
  const passThrough = new PassThrough();
  passThrough.on('data', (chunk) => {
    receivedBytes += chunk.length;
  });

  opusStream.pipe(opusDecoder).pipe(passThrough);

  ffmpeg(passThrough)
    .inputFormat('s16le')
    .inputOptions(['-ar 48000', '-ac 2'])
    .audioFrequency(16000)
    .audioChannels(1)
    .audioCodec('pcm_s16le')
    .format('wav')
    .on('error', (err) => {
      groqConcurrent--;
      const currentState = guildStates.get(guildId);
      if (currentState) currentState.activeStreams.delete(userId);

      if (!err.message.includes('SIGKILL') && !err.message.includes('ffmpeg was killed')) {
        console.error(`[STT] ❌ ffmpeg 錯誤：${err.message}`);
      }
      cleanup(outputPath);
    })
    .on('end', async () => {
      groqConcurrent--;
      const currentState = guildStates.get(guildId);
      if (currentState) currentState.activeStreams.delete(userId);

      await processAudioWithGroq(outputPath, guild, textChannel, userId, onTranscribed);
    })
    .save(outputPath);

  opusDecoder.on('error', (err) => {
    const currentState = guildStates.get(guildId);
    if (currentState) currentState.activeStreams.delete(userId);
    console.error(`[STT] ❌ Opus 解碼錯誤：${err.message}`);
  });
}

/**
 * 送出音訊給 Groq Whisper 轉錄
 */
async function processAudioWithGroq(filePath, guild, textChannel, userId, onTranscribed) {
  const guildId = guild.id;

  if (!fs.existsSync(filePath)) {
    console.warn(`[STT] ⚠️ 檔案不存在：${filePath}`);
    return;
  }

  const stat = fs.statSync(filePath);

  if (stat.size < 1000) {
    console.warn(`[STT] ⚠️ 音訊檔太小（${stat.size} bytes），跳過`);
    cleanup(filePath);
    const state = guildStates.get(guildId);
    if (state) state.activeUserId = null;
    return;
  }

  try {
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-large-v3-turbo',
      language: 'zh',
      response_format: 'text',
    });

    const text = transcription.trim();

    const state = guildStates.get(guildId);
    if (state) {
      state.activeUserId = null;
      if (state.awakeTimer) {
        clearTimeout(state.awakeTimer);
        state.awakeTimer = null;
      }
    }

    if (!text) {
      console.warn(`[STT] ⚠️ Groq 轉錄結果為空`);
      cleanup(filePath);
      return;
    }

    console.log(`[STT] ✅ Groq 轉錄 [${userId}]：${text}`);

    const member = guild.members.cache.get(userId);
    const displayName = member?.displayName || userId;

    await textChannel.send(`🗣️ **${displayName}**：${text}`);

    if (onTranscribed) {
      await onTranscribed(userId, displayName, text, textChannel);
    }
  } catch (err) {
    console.error(`[STT] ❌ Groq 轉錄失敗：${err.message}`);
    const state = guildStates.get(guildId);
    if (state) {
      state.activeUserId = null;
      if (state.awakeTimer) {
        clearTimeout(state.awakeTimer);
        state.awakeTimer = null;
      }
    }
  } finally {
    cleanup(filePath);
  }
}

// ====== 工具函式 ======

function downsampleTo16kMono(buffer, inputRate, inputChannels) {
  const bytesPerSample = 2;
  const ratio = inputRate / 16000;
  const inputSampleCount = buffer.length / (bytesPerSample * inputChannels);
  const outputSampleCount = Math.floor(inputSampleCount / ratio);
  const output = Buffer.alloc(outputSampleCount * bytesPerSample);

  for (let i = 0; i < outputSampleCount; i++) {
    const srcIndex = Math.floor(i * ratio);
    const byteOffset = srcIndex * bytesPerSample * inputChannels;

    let sum = 0;
    for (let ch = 0; ch < inputChannels; ch++) {
      const offset = byteOffset + ch * bytesPerSample;
      if (offset + 1 < buffer.length) {
        sum += buffer.readInt16LE(offset);
      }
    }
    const mono = Math.round(sum / inputChannels);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, mono)), i * bytesPerSample);
  }

  return output;
}

function stopSTTListening(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  if (state.speakingHandler && state.connection) {
    state.connection.receiver.speaking.off('start', state.speakingHandler);
  }

  if (state.awakeTimer) clearTimeout(state.awakeTimer);

  guildStates.delete(guildId);
  console.log(`[STT] 🛑 停止監聽 Guild: ${guildId}`);
}

function cleanup(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {}
}

module.exports = { startSTTListening, stopSTTListening };