// handlers/musicNormalizer.js
// 職責：對已下載的音檔進行響度正規化 (Loudness Normalization)
// 原理：使用 ffmpeg 內建 loudnorm 濾鏡，雙通道 (two-pass) 分析 + 套用
// 參數對齊指令：ffmpeg-normalize "$f" -o "output/$f" -nt ebu -t -16 -lrt 20
// 依賴：系統需安裝 ffmpeg（專案已依賴，無需額外套件）
// 被 musicCache.js 引用：下載的原始音訊經 encodeNormalizedMp3() 一次編碼成已正規化的 MP3

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

// ════════════════════════════════════════════════════════
//  正規化目標參數
//  對應 ffmpeg-normalize -nt ebu -t -16 -lrt 20（未指定 -tp 時的預設值）
// ════════════════════════════════════════════════════════
const TARGET_LUFS = -16;   // -t -16
const TARGET_LRA  = 20;    // -lrt 20
const TARGET_TP   = -2.0;  // 未指定 -tp 時，ffmpeg-normalize 於 ebu 模式的預設值

// 只取第一條音軌；編碼品質明確指定 VBR -q:a 0（不指定的話 ffmpeg 會用 LAME 預設的 128 kbps）
const MP3_ARGS = ['-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '0'];

// ffmpeg 依「內容」判斷格式：偽裝成音訊的播放清單會讓它去讀其他檔案或連內網，
// 只允許一般影音容器與本機檔案（同 music-library-service；mpegts／flv 是 yt-dlp 可能抓到的原始格式）
const SAFE_INPUT_ARGS = [
  '-protocol_whitelist', 'file,pipe',
  '-format_whitelist', 'mp3,wav,ogg,flac,aac,mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mpegts,flv',
];

// ════════════════════════════════════════════════════════
//  併發控制：避免同時大量正規化任務把 CPU 吃滿
// ════════════════════════════════════════════════════════
const MAX_CONCURRENT = 2;
let running = 0;
const queue = [];

function _runNext() {
  if (running >= MAX_CONCURRENT || queue.length === 0) return;
  running++;
  const { task, resolve, reject } = queue.shift();
  task()
    .then(resolve, reject)
    .finally(() => {
      running--;
      _runNext();
    });
}

function _enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    _runNext();
  });
}

/**
 * 從原始音訊（yt-dlp 下載的 webm / m4a 等，未經轉檔）直接產生「已正規化」的 MP3，
 * 整個流程只編碼一次。原本是 yt-dlp 先轉 MP3、正規化時再重新編碼一次 MP3。
 * 正規化失敗時退回一般轉檔（參數與 yt-dlp --audio-format mp3 --audio-quality 0 相同），
 * 確保仍產出可播放的檔案，等同舊流程「正規化失敗、保留原檔」的結果。
 * @returns {Promise<{ normalized: boolean }>}
 */
function encodeNormalizedMp3(inputPath, outputPath) {
  return _enqueue(async () => {
    try {
      const measured = await _analyzeLoudness(inputPath);
      await _applyLoudnorm(inputPath, outputPath, measured);
      logger.debug('MusicNormalizer', `✅ 響度正規化完成: ${path.basename(outputPath)}`);
      return { normalized: true };
    } catch (err) {
      try { fs.unlinkSync(outputPath); } catch {}
      logger.warn('MusicNormalizer', `⚠️ 正規化失敗，改為一般轉檔: ${path.basename(outputPath)} - ${err.message}`);
      await _plainMp3(inputPath, outputPath);
      return { normalized: false };
    }
  });
}

// ── 第一階段：分析原始檔案的響度數值 ──────────────────────
function _analyzeLoudness(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostats',
      ...SAFE_INPUT_ARGS,
      '-i', filePath,
      '-map', '0:a:0', '-vn',
      '-af', `loudnorm=I=${TARGET_LUFS}:LRA=${TARGET_LRA}:TP=${TARGET_TP}:print_format=json`,
      '-f', 'null', '-',
    ];
    const ff = spawn('ffmpeg', args);
    let stderr = '';

    ff.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-20000); });

    ff.on('close', () => {
      // 結果的 JSON 一定在最後；從最後一個 { 取，標題（檔案標籤）含大括號才不會干擾
      const start = stderr.lastIndexOf('{');
      const end   = stderr.lastIndexOf('}');
      if (start < 0 || end < start) return reject(new Error('無法解析 loudnorm 分析結果（可能是不支援的音訊格式）'));
      try {
        resolve(JSON.parse(stderr.slice(start, end + 1)));
      } catch (e) {
        reject(new Error('loudnorm JSON 解析失敗：' + e.message));
      }
    });

    ff.on('error', (err) => reject(new Error('執行 ffmpeg 分析失敗：' + err.message)));
  });
}

// ── 第二階段：依分析結果套用實際轉檔 ──────────────────────
//  對應 ffmpeg-normalize 未指定 --dynamic 時的預設行為：linear=true
function _applyLoudnorm(inputPath, outputPath, measured) {
  const af =
    `loudnorm=I=${TARGET_LUFS}:LRA=${TARGET_LRA}:TP=${TARGET_TP}:` +
    `measured_I=${measured.input_i}:measured_LRA=${measured.input_lra}:` +
    `measured_TP=${measured.input_tp}:measured_thresh=${measured.input_thresh}:` +
    `offset=${measured.target_offset}:linear=true:print_format=summary`;

  const args = [
    '-hide_banner', '-nostats', '-y',
    ...SAFE_INPUT_ARGS,
    '-i', inputPath,
    ...MP3_ARGS,
    '-af', af,
    outputPath,
  ];
  return _runFfmpeg(args, 'ffmpeg 套用正規化失敗');
}

// ── 正規化失敗時的退路：一般轉檔為 MP3（等同 yt-dlp --audio-format mp3 --audio-quality 0）──
function _plainMp3(inputPath, outputPath) {
  return _runFfmpeg(
    ['-hide_banner', '-nostats', '-y', ...SAFE_INPUT_ARGS, '-i', inputPath, ...MP3_ARGS, outputPath],
    'ffmpeg 轉檔 MP3 失敗',
  );
}

function _runFfmpeg(args, failLabel) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let stderr = '';

    ff.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-20000); });

    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${failLabel} (code ${code}): ${stderr.slice(-300)}`));
    });

    ff.on('error', (err) => reject(new Error('執行 ffmpeg 轉檔失敗：' + err.message)));
  });
}

module.exports = {
  encodeNormalizedMp3,
  TARGET_LUFS,
  TARGET_LRA,
  TARGET_TP,
};