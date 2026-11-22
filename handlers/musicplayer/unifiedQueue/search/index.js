// handlers/unifiedQueue/search/index.js
// 統一佇列 — /play 核心邏輯、網址清理、全部本地音樂、線上搜尋（YouTube）、即時 Autocomplete
'use strict';

const { EmbedBuilder } = require('discord.js');

const { _engines, SEARCH_MARKER, LOCAL_KEY_MARKER } = require('../state');
const { enqueue, ensureConnection } = require('../playback');
const voiceMonitor = require('../../voiceActivityMonitor');
const { isSupportedMediaUrl } = require('../../musicAntiBot');

const { cleanUrl, _isYouTubeWithoutList } = require('./urlUtils');
const { _handlePlayAll, _handleLocalMultiSelect } = require('./local');
const { _askPlaylistChoice, _handleAddPlaylist } = require('./playlist');
const { _replyPlayResult, _handleOnlineSearch } = require('./onlineSearch');
const { handleAutocomplete, resolveLocalKey } = require('./autocomplete');

// ════════════════════════════════════════════════════════
//  handlePlay（/play 核心邏輯）
// ════════════════════════════════════════════════════════
async function handlePlay(interaction, input, shuffleOpt = 'no') {
  const guildId = interaction.guildId;

  voiceMonitor.touchActivity(guildId);

  if (input === '__ALL_LOCAL__') {
    return _handlePlayAll(interaction, shuffleOpt);
  }

  if (input === '__LOCAL_MULTI__') {
    return _handleLocalMultiSelect(interaction);
  }

  let connection;
  try {
    connection = await ensureConnection(interaction);
  } catch {
    return interaction.editReply('❌ 沒能加入語音頻道，請再試一次。');
  }
  if (!connection) return interaction.editReply('🔈 先加入一個語音頻道，Bot 才知道要去哪裡播。加入後再用一次指令。');

  if (input.startsWith(SEARCH_MARKER)) {
    const keyword = input.slice(SEARCH_MARKER.length).trim();
    if (!keyword) return interaction.editReply('⚠️ 請輸入要搜尋的關鍵字。');
    return _handleOnlineSearch(interaction, keyword, guildId);
  }

  // autocomplete 選了長檔名的本地音樂（value 是標記 + 雜湊）→ 換回完整檔名
  if (input.startsWith(LOCAL_KEY_MARKER)) {
    const filename = resolveLocalKey(input);
    if (!filename) return interaction.editReply('⚠️ 音樂庫裡找不到這首（清單可能剛更新過），請重新用 /play 選一次。');
    input = filename;
  }

  const cleanInput = cleanUrl(input);
  // cleanUrl 遇到網址裡互相衝突的影片 ID（例如 /shorts/<A>?v=<B>）會回傳空字串
  if (!cleanInput && /^https?:\/\//i.test(input.trim())) {
    return interaction.editReply('⚠️ 看不出這個網址是哪一部影片，請從影片頁重新複製網址。');
  }
  // 只有「scheme://」形式才算網址：new URL('Re:Zero opening') 也會成功（協定是 're:'），
  // 這種關鍵字/檔名要走本地或線上搜尋，不能被當成不支援的網址拒絕
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(cleanInput)
    && (() => { try { new URL(cleanInput); return true; } catch { return false; } })();

  let item;

  if (isUrl) {
    if (!isSupportedMediaUrl(cleanInput)) return interaction.editReply('⚠️ 只支援 YouTube 和 Bilibili 的網址。');

    const engine = _engines.bilibili;
    if (!engine) return interaction.editReply('⏳ Bot 剛啟動，線上音樂還在準備，約 30 秒後再試一次。');

    // YouTube 網址沒有 list= 參數就不可能是播放清單，直接跳過偵測（省一次 yt-dlp）
    const needPlaylistCheck = typeof engine.checkPlaylist === 'function' && !_isYouTubeWithoutList(input);
    const infoMsg = () => interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x95A5A6).setDescription('🔍 正在讀取這個影片…（通常 5 秒內）')]
    });

    await (needPlaylistCheck
      ? interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0x95A5A6).setDescription('🔍 正在讀取這個網址…（通常 5 秒內）')]
        })
      : infoMsg());

    // 單曲資訊與播放清單偵測同時進行；結果包成 { info } / { error }，避免未等待時變成 unhandled rejection。
    // getInfo 使用 cleanInput：buildInfoArgs 已內建 --no-playlist，帶 list 參數也安全。
    const fetchInfo = (signal) => engine.getInfo(cleanInput, { signal })
      .then(info => ({ info }), error => ({ error }));
    const infoAbort = new AbortController();
    const infoResult = fetchInfo(infoAbort.signal);
    let askedPlaylist = false;

    if (needPlaylistCheck) {
      // ★ 修正：改用 input（原始未清理網址），保留 list 參數才能正確偵測 YouTube 播放清單。
      let playlistInfo = null;
      try {
        playlistInfo = await engine.checkPlaylist(input);
      } catch {
        playlistInfo = null;
      }

      if (playlistInfo && playlistInfo.isPlaylist) {
        askedPlaylist = true;
        const choice = await _askPlaylistChoice(interaction, playlistInfo);
        if (choice !== 'first') {
          infoAbort.abort(); // 不需要單曲資訊了，停掉背景的 yt-dlp
          if (choice === 'cancel') return;
          // ★ 修正：baseUrl 同步改用 input，與上方 checkPlaylist(input) 保持一致
          return _handleAddPlaylist(interaction, input, playlistInfo, guildId);
        }
        // choice === 'first' → 繼續往下走，用單曲流程處理 cleanInput
      } else {
        await infoMsg();
      }
    }

    let { info, error } = await infoResult;
    // 使用者在播放清單選單停留期間，並行的 getInfo 可能已逾時；照原本「選完才抓」的流程再抓一次
    if (error && askedPlaylist) ({ info, error } = await fetchInfo());
    if (error) return interaction.editReply('⚠️ 讀不到這個影片，可能是私人影片、有地區限制或網址打錯。請換一個網址，或改用關鍵字搜尋。');

    item = info;
    item.type = 'bilibili';
  } else {

    const localEngine = _engines.local;
    const localItem = localEngine ? localEngine.getTrackInfo(input) : null;

    if (localItem) {
      item = localItem;
      item.type = 'local';
    } else {
      return _handleOnlineSearch(interaction, input, guildId);
    }
  }

  const result = await enqueue(guildId, item, interaction.channel);
  await _replyPlayResult(interaction, item, result);
}

module.exports = {
  handlePlay,
  handleAutocomplete,
};
