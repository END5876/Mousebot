// handlers/musicplayer/unifiedQueue/search/index.js
// 對外進入點：/play 核心邏輯（handlePlay）與 Autocomplete（handleAutocomplete）
// 彙整拆分後的子模組（utils / local / playlist / online / reply / autocomplete），
// 維持與拆分前完全相同的 module.exports 介面：{ handlePlay, handleAutocomplete }

const { _engines, SEARCH_MARKER } = require('../state');
const { enqueue, ensureConnection } = require('../playback');
const voiceMonitor = require('../../voiceActivityMonitor');

const { EmbedBuilder } = require('discord.js');

const { cleanUrl } = require('./utils');
const { handlePlayAll, handleLocalMultiSelect } = require('./local');
const { askPlaylistChoice, handleAddPlaylist } = require('./playlist');
const { handleOnlineSearch } = require('./online');
const { replyPlayResult } = require('./reply');
const { handleAutocomplete } = require('./autocomplete');

// ════════════════════════════════════════════════════════
//  handlePlay（/play 核心邏輯）
// ════════════════════════════════════════════════════════
async function handlePlay(interaction, input, shuffleOpt = 'no') {
  const guildId = interaction.guildId;

  voiceMonitor.touchActivity(guildId);

  if (input === '__ALL_LOCAL__') {
    return handlePlayAll(interaction, shuffleOpt);
  }

  if (input === '__LOCAL_MULTI__') {
    return handleLocalMultiSelect(interaction);
  }

  let connection;
  try {
    connection = await ensureConnection(interaction);
  } catch {
    return interaction.editReply('❌ 加入語音頻道時發生錯誤');
  }
  if (!connection) return interaction.editReply('❌ 你必須先加入語音頻道！');

  if (input.startsWith(SEARCH_MARKER)) {
    const keyword = input.slice(SEARCH_MARKER.length).trim();
    if (!keyword) return interaction.editReply('❌ 搜尋關鍵字不可為空');
    return handleOnlineSearch(interaction, keyword, guildId);
  }

  const cleanInput = cleanUrl(input);
  const isUrl = (() => { try { new URL(cleanInput); return true; } catch { return false; } })();

  let item;

  if (isUrl) {
    const engine = _engines.bilibili;
    if (!engine) return interaction.editReply('❌ 串流引擎未就緒');

    // 先偵測是否為播放清單
    // ★ 修正：改用 input（原始未清理網址），保留 list 參數才能正確偵測 YouTube 播放清單。
    //    getInfo 仍使用 cleanInput，因為 buildInfoArgs 已內建 --no-playlist，帶 list 參數也安全。
    let playlistInfo = null;
    if (typeof engine.checkPlaylist === 'function') {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x1DB954).setDescription('🔍 正在檢查網址類型...')]
      });
      try {
        playlistInfo = await engine.checkPlaylist(input);
      } catch {
        playlistInfo = null;
      }
    }

    if (playlistInfo && playlistInfo.isPlaylist) {
      const choice = await askPlaylistChoice(interaction, playlistInfo);
      if (choice === 'cancel') return;
      if (choice === 'all') {
        // ★ 修正：baseUrl 同步改用 input，與上方 checkPlaylist(input) 保持一致
        return handleAddPlaylist(interaction, input, playlistInfo, guildId);
      }
      // choice === 'first' → 繼續往下走，用單曲流程處理 cleanInput
    } else {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x1DB954).setDescription('🔍 正在獲取影片資訊...')]
      });
    }

    try {
      item = await engine.getInfo(cleanInput);
      item.type = 'bilibili';
    } catch (err) {
      return interaction.editReply(`❌ 無法獲取影片資訊：${err.message}`);
    }
  } else {

    const localEngine = _engines.local;
    const localItem = localEngine ? localEngine.getTrackInfo(input) : null;

    if (localItem) {
      item = localItem;
      item.type = 'local';
    } else {
      return handleOnlineSearch(interaction, input, guildId);
    }
  }

  const result = await enqueue(guildId, item, interaction.channel);
  await replyPlayResult(interaction, item, result);
}

module.exports = {
  handlePlay,
  handleAutocomplete,
};
