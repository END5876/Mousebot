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
// 注意：原指令未指定 -ar / -b:a，因此不強制取樣率與碼率，維持原始檔案設定

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
 * 對外主函式：將指定音檔正規化為統一響度
 * 成功：覆蓋原檔案，resolve(filePath)
 * 失敗：保留原檔案不動，reject(err)（呼叫端應 catch 但不中斷主流程）
 */
function normalizeAudioFile(filePath) {
  return _enqueue(() => _normalizeOne(filePath));
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

function _normalizeOne(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`檔案不存在: ${filePath}`));
    }

    const dir  = path.dirname(filePath);
    const ext  = path.extname(filePath);
    const base = path.basename(filePath, ext);

    // ★ 關鍵：暫存檔必須建在「與原檔相同的資料夾」下（例如 /app/data/music/cache），
    //   確保跟目標檔案同一個檔案系統掛載點，rename 才不會拋出 EXDEV 錯誤。
    //   命名風格與 musicCache.js 的 downloadAndCache() 一致（.tmp 字尾）。
    const tmpPath = path.join(dir, `${base}.norm_${Date.now()}.tmp${ext}`);

    _analyzeLoudness(filePath)
      .then((measured) => _applyLoudnorm(filePath, tmpPath, measured))
      .then(() => {
        // 同目錄內的 rename 屬於原子操作，安全、不會產生半寫入的損毀檔案
        fs.renameSync(tmpPath, filePath);
        logger.debug('MusicNormalizer', `✅ 響度正規化完成: ${path.basename(filePath)}`);
        resolve(filePath);
      })
      .catch((err) => {
        if (fs.existsSync(tmpPath)) {
          try { fs.unlinkSync(tmpPath); } catch {}
        }
        logger.warn('MusicNormalizer', `⚠️ 正規化失敗，保留原檔: ${path.basename(filePath)} - ${err.message}`);
        reject(err);
      });
  });
}

// ── 第一階段：分析原始檔案的響度數值 ──────────────────────
function _analyzeLoudness(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostats',
      '-i', filePath,
      '-af', `loudnorm=I=${TARGET_LUFS}:LRA=${TARGET_LRA}:TP=${TARGET_TP}:print_format=json`,
      '-f', 'null', '-',
    ];
    const ff = spawn('ffmpeg', args);
    let stderr = '';

    ff.stderr.on('data', (d) => { stderr += d.toString(); });

    ff.on('close', () => {
      const match = stderr.match(/\{[\s\S]*\}/);
      if (!match) return reject(new Error('無法解析 loudnorm 分析結果（可能是不支援的音訊格式）'));
      try {
        resolve(JSON.parse(match[0]));
      } catch (e) {
        reject(new Error('loudnorm JSON 解析失敗: ' + e.message));
      }
    });

    ff.on('error', (err) => reject(new Error('執行 ffmpeg 分析失敗: ' + err.message)));
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
    '-hide_banner', '-y',
    '-i', inputPath,
    '-vn', // 原始下載可能是帶影像的格式（bestaudio 不可用時退回 best），只取音訊
    '-af', af,
    // 未指定 -ar / -b:a，維持原始取樣率與編碼設定，與參考指令行為一致
    outputPath,
  ];
  return _runFfmpeg(args, 'ffmpeg 套用正規化失敗');
}

// ── 正規化失敗時的退路：一般轉檔為 MP3（等同 yt-dlp --audio-format mp3 --audio-quality 0）──
function _plainMp3(inputPath, outputPath) {
  return _runFfmpeg(
    ['-hide_banner', '-y', '-i', inputPath, '-vn', '-c:a', 'libmp3lame', '-q:a', '0', outputPath],
    'ffmpeg 轉檔 MP3 失敗',
  );
}

function _runFfmpeg(args, failLabel) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let stderr = '';

    ff.stderr.on('data', (d) => { stderr += d.toString(); });

    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${failLabel} (code ${code}): ${stderr.slice(-300)}`));
    });

    ff.on('error', (err) => reject(new Error('執行 ffmpeg 轉檔失敗: ' + err.message)));
  });
}

module.exports = {
  normalizeAudioFile,
  encodeNormalizedMp3,
  TARGET_LUFS,
  TARGET_LRA,
  TARGET_TP,
};