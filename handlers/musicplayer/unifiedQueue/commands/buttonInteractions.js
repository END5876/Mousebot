// handlers/musicplayer/unifiedQueue/commands/buttonInteractions.js
// 職責：控制面板按鈕（uq_*）互動處理，以及逾時搜尋元件的殭屍互動防護。
// 透過 registerButtonInteractions(client) 掛載於 interactionCreate，
// 與 Autocomplete 分流處理放在同一個監聽器內（維持原始行為）。

const { EmbedBuilder, MessageFlags } = require('discord.js');
const voiceMonitor = require('../../voiceActivityMonitor');
const { queues, nowPlaying, loopSettings, activeSearchMessages, randomPlaySettings } = require('../state');
const { updateControlPanel, stopAll } = require('../playback');
const { handleAutocomplete } = require('../search');

function registerButtonInteractions(client) {
  client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
      handleAutocomplete(interaction);
      return;
    }

    // ── 逾時後的殭屍搜尋按鈕/選單防護 ──────────────────────
    // awaitMessageComponent 逾時後，若使用者仍點擊舊的搜尋元件，
    // 給予明確提示而非讓 Discord 顯示「互動失敗」。
    // 正常情況下，合法時間內的搜尋互動已被 awaitMessageComponent
    // 的 filter 攔截消耗掉，這裡只會接到「逾時後才點擊」的殭屍互動。

    const ZOMBIE_BUTTON_PREFIXES = ['srch_', 'pl_', 'lm_'];
    const ZOMBIE_SELECT_IDS      = ['srch_pick', 'lm_pick'];

    if ((interaction.isButton() && ZOMBIE_BUTTON_PREFIXES.some(p => interaction.customId.startsWith(p))) ||
        (interaction.isStringSelectMenu() && ZOMBIE_SELECT_IDS.includes(interaction.customId))) {
      // 若此訊息目前正被 _handleOnlineSearch() 等的 awaitMessageComponent()
      // 合法等待中，就不要搶先 reply()！否則會跟它內部真正要處理選擇結果的
      // selection.update() 搶著 ACK 同一個 interaction，導致對方拿到
      // DiscordAPIError[10062] Unknown interaction。交給那邊的 collector 處理即可。
      if (interaction.message && activeSearchMessages.has(interaction.message.id)) {
        return;
      }
      return interaction.reply({
        content: '⌛ 此選單/按鈕已逾時或已被處理，請重新使用 /play',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }

    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('uq_')) return;

    const guildId = interaction.guildId;
    const np = nowPlaying.get(guildId);
    if (!np) {
      return interaction.reply({ content: '❌ 目前沒有播放音樂', flags: MessageFlags.Ephemeral });
    }

    // ★ 使用者操作控制面板按鈕，視為頻道仍活躍，重置閒置計時器
    voiceMonitor.touchActivity(guildId);

    try {
      switch (interaction.customId) {
        case 'uq_skip': {
          const queue = queues.get(guildId) || [];
          const loopMode = loopSettings.get(guildId) || 'off';
          const isRandomPlay = randomPlaySettings.get(guildId) || false;

          // 隨機連播模式下，skip 直接觸發 player.stop()，
          // Idle 事件會自動隨機挑下一首
          if (isRandomPlay) {
            np.player.stop();
            await interaction.reply({ content: '⏭️ 跳過，隨機連播下一首', flags: MessageFlags.Ephemeral });
            break;
          }

          // 只有「佇列真的空了」且「循環模式關閉」時才整組停止；
          // 否則交給 player.stop() 觸發 Idle 事件，讓 playback.js 的
          // 循環邏輯（單曲重播 / 列表循環）接手判斷，避免跳過鍵誤殺循環設定
          if (queue.length === 0 && loopMode === 'off') {
            stopAll(guildId);
            await interaction.reply({ content: '⏭️ 已跳過，佇列為空，停止播放', flags: MessageFlags.Ephemeral });
          } else {
            np.player.stop();
            await interaction.reply({ content: '⏭️ 跳過當前歌曲', flags: MessageFlags.Ephemeral });
          }
          break;
        }

        case 'uq_stop':
          stopAll(guildId);
          await interaction.reply({ content: '⏹️ 已停止播放', flags: MessageFlags.Ephemeral });
          break;

        case 'uq_loop_one': {
          // 開啟單曲循環時，關閉隨機連播（互斥）
          randomPlaySettings.set(guildId, false);
          const cur = loopSettings.get(guildId);
          const next = cur === 'one' ? 'off' : 'one';
          loopSettings.set(guildId, next);
          await interaction.reply({
            content: next === 'one' ? '🔂 單曲循環已開啟' : '❌ 循環已關閉',
            flags: MessageFlags.Ephemeral,
          });
          await updateControlPanel(guildId, interaction.channel);
          break;
        }

        case 'uq_loop_all': {
          // 開啟列表循環時，關閉隨機連播（互斥）
          randomPlaySettings.set(guildId, false);
          const cur = loopSettings.get(guildId);
          const next = cur === 'all' ? 'off' : 'all';
          loopSettings.set(guildId, next);
          await interaction.reply({
            content: next === 'all' ? '🔁 列表循環已開啟' : '❌ 循環已關閉',
            flags: MessageFlags.Ephemeral,
          });
          await updateControlPanel(guildId, interaction.channel);
          break;
        }

        case 'uq_random_play': {
          const cur = randomPlaySettings.get(guildId) || false;
          const next = !cur;
          randomPlaySettings.set(guildId, next);

          if (next) {
            // 開啟隨機連播時，關閉其他循環模式（互斥）
            loopSettings.set(guildId, 'off');
            await interaction.reply({
              content: '🎲 隨機連播已開啟，播完當前歌曲後將自動隨機挑選下一首本地音樂',
              flags: MessageFlags.Ephemeral,
            });
          } else {
            await interaction.reply({
              content: '❌ 隨機連播已關閉',
              flags: MessageFlags.Ephemeral,
            });
          }
          await updateControlPanel(guildId, interaction.channel);
          break;
        }

        case 'uq_queue': {
          const queueList = queues.get(guildId) || [];
          const loopMode = loopSettings.get(guildId) || 'off';
          const isRandomPlay = randomPlaySettings.get(guildId) || false;
          let loopText = '❌ 關閉';
          if (loopMode === 'one') loopText = '🔂 單曲循環';
          if (loopMode === 'all') loopText = '🔁 列表循環';
          if (isRandomPlay) loopText = '🎲 隨機連播';

          const embed = new EmbedBuilder()
            .setColor(isRandomPlay ? 0xFF8C00 : 0x1DB954)
            .setTitle('🎵 播放佇列')
            .addFields(
              {
                name: '🎧 正在播放',
                value: np.item.type === 'bilibili'
                  ? `[${np.item.title}](${np.item.url})`
                  : `**${np.item.title}**`,
                inline: false,
              },
              { name: '循環模式', value: loopText, inline: true },
              { name: '佇列數量', value: `${queueList.length} 首`, inline: true },
            )
            .setTimestamp();

          if (queueList.length > 0) {
            const listText = queueList.map((t, i) =>
              t.type === 'bilibili'
                ? `${i + 1}. [${t.title}](${t.url})`
                : `${i + 1}. **${t.title}**`
            ).join('\n');
            embed.addFields({
              name: '📋 佇列',
              value: listText.length > 1024 ? listText.slice(0, 1021) + '...' : listText,
              inline: false,
            });
          }

          await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
          break;
        }
      }
    } catch (err) {
      console.error('❌ [UnifiedQueue] 按鈕互動錯誤:', err);
      try { await interaction.reply({ content: '❌ 操作失敗', flags: MessageFlags.Ephemeral }); } catch {}
    }
  });
}

module.exports = { registerButtonInteractions };
