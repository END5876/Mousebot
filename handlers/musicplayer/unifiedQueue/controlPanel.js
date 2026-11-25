// 統一佇列 — 控制面板與佇列畫面。

const { AudioPlayerStatus } = require('@discordjs/voice');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const C = require('../../../utils/embedColors'); // embed 色票（utils/embedColors.js）
const { queues, nowPlaying, loopSettings, controlMsgs, randomPlaySettings } = require('./state');
const session = require('./session');
const logger = require('../../../utils/logger');
const { musicUrl, linkButton } = require('../../../utils/publicUrls');
const { md } = require('../../../utils/markdown');
const { _getNotifyChannel } = require('./requestChannels');

// ════════════════════════════════════════════════════════
//  控制面板
// ════════════════════════════════════════════════════════
function _buildEmbed(guildId) {
  const np = nowPlaying.get(guildId);
  const queue = queues.get(guildId) || [];
  const loopMode = loopSettings.get(guildId) || 'off';
  const isRandomPlay = randomPlaySettings.get(guildId) || false;

  if (!np) return null;

  let loopText = '➡️ 不循環';
  if (loopMode === 'one') loopText = '🔂 單曲循環';
  if (loopMode === 'all') loopText = '🔁 列表循環';
  if (isRandomPlay) loopText = '🎲 隨機連播';

  const { item } = np;
  const paused = np.player?.state?.status === AudioPlayerStatus.Paused;

  const embed = new EmbedBuilder()
    .setColor(paused ? C.NEUTRAL : C.MUSIC)
    .setTitle(paused ? '⏸️ 已暫停' : '🎵 正在播放')
    .setTimestamp();

  if (item.type === 'bilibili') {
    embed
      .setDescription(`[${md(item.title)}](${item.url})`)
      .addFields(
        { name: '作者', value: item.author || '未知', inline: true },
        { name: '時長', value: item.duration || '未知', inline: true },
        { name: '循環模式', value: loopText, inline: true },
        { name: '佇列', value: `${queue.length} 首`, inline: true },
      );
    if (item.thumbnail) embed.setThumbnail(item.thumbnail);
  } else {
    embed
      .setDescription(`🎧 **${md(item.title)}**`)
      .addFields(
        { name: '循環模式', value: loopText, inline: true },
        { name: '佇列', value: `${queue.length} 首`, inline: true },
      );
  }

  return embed;
}

// 一列最多 5 個按鈕：第一列放播放控制（暫停／繼續、跳過、停止播放、佇列），
// 第二列放模式切換，有設定 MUSIC_PUBLIC_URL 時最後加「在網頁開啟」
function _buildButtons(guildId) {
  const loopMode = loopSettings.get(guildId) || 'off';
  const isRandomPlay = randomPlaySettings.get(guildId) || false;
  const paused = nowPlaying.get(guildId)?.player?.state?.status === AudioPlayerStatus.Paused;
  const controls = new ActionRowBuilder().addComponents(
    paused
      ? new ButtonBuilder().setCustomId('uq_resume').setLabel('繼續').setEmoji('▶️').setStyle(ButtonStyle.Success)
      : new ButtonBuilder().setCustomId('uq_pause').setLabel('暫停').setEmoji('⏸️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('uq_skip')
      .setLabel('跳過')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('uq_stop')
      .setLabel('停止播放')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('uq_queue')
      .setLabel('佇列')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary),
  );
  const modes = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('uq_loop_one')
      .setLabel('單曲循環')
      .setEmoji('🔂')
      .setStyle(loopMode === 'one' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('uq_loop_all')
      .setLabel('列表循環')
      .setEmoji('🔁')
      .setStyle(loopMode === 'all' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('uq_random_play')
      .setLabel('隨機連播')
      .setEmoji('🎲')
      .setStyle(isRandomPlay ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  const web = linkButton('在網頁開啟', musicUrl(), '🌐');
  if (web) modes.addComponents(web);
  return [controls, modes];
}

// ════════════════════════════════════════════════════════
//  佇列畫面（/music queue 與面板的「佇列」按鈕共用）：每頁 20 首，◀ ▶ 換頁
// ════════════════════════════════════════════════════════
const QUEUE_PAGE_SIZE = 20;

function buildQueueView(guildId, page = 0) {
  const np = nowPlaying.get(guildId);
  const list = queues.get(guildId) || [];
  const loopMode = loopSettings.get(guildId) || 'off';
  const isRandomPlay = randomPlaySettings.get(guildId) || false;
  const loopText = isRandomPlay ? '🎲 隨機連播' : loopMode === 'one' ? '🔂 單曲循環' : loopMode === 'all' ? '🔁 列表循環' : '➡️ 不循環';

  const pages = Math.max(1, Math.ceil(list.length / QUEUE_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const start = p * QUEUE_PAGE_SIZE;
  const shown = list.slice(start, start + QUEUE_PAGE_SIZE);

  const lines = [];
  if (np) {
    lines.push(`🎧 正在播放：${np.item.type === 'bilibili' ? `[${md(np.item.title)}](${np.item.url})` : `**${md(np.item.title)}**`}`);
    lines.push('');
  }
  if (shown.length) {
    lines.push(...shown.map((t, i) => (t.type === 'bilibili'
      ? `${start + i + 1}. [${md(t.title)}](${t.url})`
      : `${start + i + 1}. ${md(t.title)}`)));
  } else {
    lines.push('佇列是空的。');
  }
  let desc = lines.join('\n');
  if (desc.length > 4096) desc = desc.slice(0, 4095) + '…';

  const embed = new EmbedBuilder()
    .setColor(C.MUSIC)
    .setTitle(list.length > QUEUE_PAGE_SIZE
      ? `📋 佇列：第 ${start + 1}～${start + shown.length} 首，共 ${list.length} 首`
      : `📋 佇列（${list.length} 首）`)
    .setDescription(desc)
    .addFields({ name: '循環模式', value: loopText, inline: true });

  const components = [];
  if (pages > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`uq_qpage:${p - 1}`).setLabel('上一頁').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
      new ButtonBuilder().setCustomId(`uq_qpage:${p + 1}`).setLabel('下一頁').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(p >= pages - 1),
    ));
  }
  return { embeds: [embed], components };
}

// 就地更新現有的控制面板（暫停／繼續時用）：不像 updateControlPanel 會刪掉重發、把面板移到最底下
async function refreshControlPanel(guildId) {
  const msg = controlMsgs.get(guildId);
  const embed = _buildEmbed(guildId);
  if (!msg || !embed) return;
  await msg.edit({ embeds: [embed], components: _buildButtons(guildId) }).catch(() => {});
}

// guildId → 進行中的面板更新（同一個 guild 的更新排隊執行）
const _panelUpdates = new Map();

// preferEdit：換歌時就地編輯原本的面板（不刪掉重發，手機上要按的按鈕才不會在手指底下消失）；
//   面板已經被聊天推上去（後面有 PANEL_BURY_LIMIT 則以上訊息）才刪掉重發到最底下
async function updateControlPanel(guildId, channel, { preferEdit = false } = {}) {
  // 循環 / 隨機連播 / 佇列變動後都會更新面板，順便排程寫出播放快照
  session.schedule();
  // 播完換曲、/play 回覆、按鈕、網頁都會各自更新面板；同時進行時會讀到同一個舊面板、
  // 各送出一個新的，只有最後一個被記住，其他的永遠刪不掉 → 同一個 guild 排隊依序執行
  const prev = _panelUpdates.get(guildId) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => _doUpdateControlPanel(guildId, channel, { preferEdit }));
  _panelUpdates.set(guildId, run);
  try {
    await run;
  } finally {
    if (_panelUpdates.get(guildId) === run) _panelUpdates.delete(guildId);
  }
}

const PANEL_BURY_LIMIT = 8;

async function _doUpdateControlPanel(guildId, channel, { preferEdit = false } = {}) {
  const embed = _buildEmbed(guildId);
  if (!embed) return;
  const rows = _buildButtons(guildId);

  const targetChannel = _getNotifyChannel(guildId, channel);

  const current = controlMsgs.get(guildId);
  if (preferEdit && current && targetChannel && current.channelId === targetChannel.id) {
    try {
      const after = await targetChannel.messages.fetch({ after: current.id, limit: PANEL_BURY_LIMIT });
      if (after.size < PANEL_BURY_LIMIT) {
        await current.edit({ embeds: [embed], components: rows });
        return;
      }
    } catch {
      // 沒有讀取訊息紀錄的權限、或面板已被刪掉：照舊刪掉重發
    }
  }

  try {
    const oldMsg = controlMsgs.get(guildId);
    if (oldMsg) {
      try {
        await oldMsg.delete();
      } catch {
        // 舊訊息可能已被使用者手動刪除或找不到，忽略即可
      }
    }

    const newMsg = await targetChannel.send({ embeds: [embed], components: rows });
    controlMsgs.set(guildId, newMsg);
  } catch (err) {
    logger.error('UnifiedQueue', '更新控制面板失敗:', err);
  }
}

// 停止或播完後，把頻道裡的控制面板就地改成「已結束」並拿掉按鈕，
// 不然面板會一直寫「正在播放」，按鈕按了只回「目前沒有播放音樂」。
// 排在進行中的面板更新之後：那次更新可能剛送出新面板（舊的已刪），也要一起改掉
function _endControlPanel(guildId, panel, lastItem, reason) {
  const embed = new EmbedBuilder()
    .setColor(C.NEUTRAL)
    .setTitle(reason === 'finished' ? '✅ 佇列播完了' : '⏹️ 已停止播放')
    .setDescription(lastItem?.title
      ? `最後播的是「${md(lastItem.title)}」。用 /play 再點歌。`
      : '用 /play 再點歌。')
    .setTimestamp();
  const end = reason === 'restart'
    ? (msg) => msg?.delete().catch(() => {})
    : (msg) => msg?.edit({ embeds: [embed], components: [] }).catch(() => {});
  const pending = _panelUpdates.get(guildId);
  if (!pending) { end(panel); return; }
  pending.catch(() => {}).then(() => {
    const late = controlMsgs.get(guildId);
    // 更新期間又開始播放（有新的 nowPlaying）就不要動新面板
    if (late && late !== panel && !nowPlaying.has(guildId)) {
      controlMsgs.delete(guildId);
      end(late);
    }
    end(panel);
  });
}

module.exports = {
  updateControlPanel,
  _endControlPanel,
  _buildEmbed,
  _buildButtons,
  buildQueueView,
  refreshControlPanel,
};
