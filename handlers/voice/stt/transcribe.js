// handlers/voice/stt/transcribe.js
// 職責：Groq 語音轉文字 + 共用的「PCM → STT 驗證 + Groq 轉文字」流程

const fs   = require('fs');
const path = require('path');
const Groq = require('groq-sdk');

const {
  TEMP_DIR,
  MIN_AUDIO_DURATION_MS, VAD_VOICE_RATIO_MIN, RMS_THRESHOLD,
  NO_SPEECH_THRESHOLD,
  ensureTempDir, safeUnlink, writeWav,
  calcRMS, calcVoiceRatio, calcDurationMs,
  isHallucination,
} = require('../sttConfig');

// ── Groq 客戶端 ─────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ══════════════════════════════════════════════════════════
// Groq 語音轉文字
// ══════════════════════════════════════════════════════════
async function transcribeWithGroq(wavFilePath) {
  const fileStream = fs.createReadStream(wavFilePath);
  try {
    const transcription = await groq.audio.transcriptions.create({
      file:            fileStream,
      model:           'whisper-large-v3',
      language:        'zh',
      response_format: 'verbose_json',
      prompt:          '以下是使用者對語音助理說的指令。',
    });

    if (transcription.segments?.length > 0) {
      const avgNoSpeech = transcription.segments.reduce(
        (sum, seg) => sum + (seg.no_speech_prob ?? 0), 0
      ) / transcription.segments.length;

      if (avgNoSpeech > NO_SPEECH_THRESHOLD) {
        console.warn(`[STT] 幻覺過濾 (no_speech=${avgNoSpeech.toFixed(2)})`);
        return '';
      }
    }

    return transcription.text?.trim() || '';
  } finally {
    try { fileStream.destroy(); } catch {}
  }
}

// ══════════════════════════════════════════════════════════
// 共用：PCM → STT 驗證 + Groq 轉文字
// ══════════════════════════════════════════════════════════
async function processPCMToText(guildId, userId, recordedChunks, textChannel) {
  if (recordedChunks.length === 0) {
    await textChannel?.send('❌ 沒有偵測到語音，請再試一次').catch(() => {});
    return { ok: false, reason: 'no_audio' };
  }

  const pcmBuffer  = Buffer.concat(recordedChunks);
  const durationMs = calcDurationMs(pcmBuffer);

  if (durationMs < MIN_AUDIO_DURATION_MS) {
    await textChannel?.send('❌ 音訊太短，請再試一次').catch(() => {});
    return { ok: false, reason: 'too_short' };
  }

  const voiceRatio = calcVoiceRatio(pcmBuffer);
  if (voiceRatio < VAD_VOICE_RATIO_MIN && calcRMS(pcmBuffer) < RMS_THRESHOLD) {
    await textChannel?.send('❌ 沒有偵測到有效語音，請再試一次').catch(() => {});
    return { ok: false, reason: 'low_voice' };
  }

  ensureTempDir();
  const wavFile = path.join(TEMP_DIR, `stt_${guildId}_${userId}_${Date.now()}.wav`);
  await writeWav(wavFile, pcmBuffer);

  let text = '';
  try {
    text = await transcribeWithGroq(wavFile);
  } catch (err) {
    console.error(`[STT] Groq 失敗: ${err.message}`);
    await textChannel?.send('❌ 語音辨識失敗，請稍後再試').catch(() => {});
    return { ok: false, reason: 'stt_failed' };
  } finally {
    safeUnlink(wavFile);
  }

  if (!text || isHallucination(text)) {
    await textChannel?.send('❌ 無法辨識語音內容').catch(() => {});
    return { ok: false, reason: 'empty_or_hallucination' };
  }

  return { ok: true, text, pcmBuffer };
}

module.exports = { transcribeWithGroq, processPCMToText };
