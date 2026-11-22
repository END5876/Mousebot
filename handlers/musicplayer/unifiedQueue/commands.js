// handlers/unifiedQueue/commands.js
// 統一佇列 — Slash Commands 註冊、控制面板按鈕互動、閒置監控管理指令

const C = require('../../../utils/embedColors'); // embed 色票（utils/embedColors.js）
const { getVoiceConnection } = require('@discordjs/voice');
const logger = require('../../../utils/logger');
const {
  EmbedBuilder,
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const voiceMonitor = require('../voiceActivityMonitor');

const { queues, nowPlaying, loopSettings, connections, activeSearchMessages, randomPlaySettings, resetLoopAllCycle } = require('./state');
const {
  _buildEmbed,
  updateControlPanel,
  stopAll,
  // _createIdleStopHandler, // 已停用（一般模式），保留註解供之後參考
  _createPersistentIdleHandler,
  ensureConnection,
  playRandomLocal,
  resetShuffleBag, // ★ 新增：開啟隨機連播時用來重置洗牌袋，確保是全新一輪
  skipCurrent,
  loopOneSkipText,
  pauseCurrent,
  resumeCurrent,
  prefetchUpcoming,
  refreshControlPanel,
  _buildButtons,
  buildQueueView,
} = require('./playback');
const { handlePlay, handleAutocomplete } = require('./search');
const bootSummary = require('../../../utils/bootSummary');
const session = require('./session');
const webSync = require('./webSync');
const { md } = require('../../../utils/markdown');

// 面板「停止播放」：佇列至少這麼多首時先確認（決定 6）
const STOP_CONFIRM_MIN = 5;
// 停止確認：代碼 → { 當時的播放（nowPlaying 物件）, 時間 }，2 分鐘內、而且還是同一輪播放才算數
const STOP_CONFIRM_TTL_MS = 2 * 60 * 1000;
const pendingStops = new Map();
function newStopToken(np) {
  const now = Date.now();
  for (const [k, v] of pendingStops) if (now - v.at > STOP_CONFIRM_TTL_MS) pendingStops.delete(k);
  const token = now.toString(36) + Math.random().toString(36).slice(2, 6);
  pendingStops.set(token, { np, at: now });
  return token;
}

// ════════════════════════════════════════════════════════
//  setupUnifiedCommands
// ════════════════════════════════════════════════════════
function setupUnifiedCommands(client) {
  client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'music') {
        respondQueuePositions(interaction);
        return;
      }
      handleAutocomplete(interaction);
      return;
    }

    // ── 逾時後的殭屍搜尋按鈕/選單防護 ──────────────────────
    // awaitMessageComponent 逾時後，若使用者仍點擊舊的搜尋元件，
    // 給予明確提示而非讓 Discord 顯示「互動失敗」。
    // 正常情況下，合法時間內的搜尋互動已被 awaitMessageComponent
    // 的 filter 攔截消耗掉，這裡只會接到「逾時後才點擊」的殭屍互動。
    
    const ZOMBIE_BUTTON_PREFIXES = ['srch_', 'pl_', 'lm_', 'pa_'];
    const ZOMBIE_SELECT_IDS      = ['srch_pick', 'lm_pick'];

    if ((interaction.isButton() && ZOMBIE_BUTTON_PREFIXES.some(p => interaction.customId.startsWith(p))) ||
        (interaction.isStringSelectMenu() && ZOMBIE_SELECT_IDS.includes(interaction.customId))) {
      // 若此訊息目前正被 _handleOnlineSearch() 等的 awaitMessageComponent()
      // 合法等待中，就不要搶先 reply()！否則會跟它內部真正要處理選擇結果的
      // selection.update() 搶著 ACK 同一個 interaction，導致對方拿到
      // DiscordAPIError[10062] Unknown interaction。交給那邊的 collector 處理即可。
      if (interaction.message && activeSearchMessages.has(interaction.message.id)) {
        // 別人點了這則搜尋結果：collector 只收原本搜尋的人，這裡回一句說明，不讓 Discord 顯示「此互動失敗」
        const owner = activeSearchMessages.get(interaction.message.id);
        if (owner && owner !== interaction.user.id) {
          return interaction.reply({
            content: `這是 <@${owner}> 的搜尋結果，想點歌請用 /play。`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          }).catch(() => {});
        }
        return;
      }
      return interaction.reply({
        content: '⌛ 這個選單已經過期，請重新用 /play 搜尋。',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }

    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('uq_')) return;

    const guildId = interaction.guildId;
    // 面板按鈕的回覆只有按的人看得到（面板本身會跟著更新，大家都看得到狀態）
    const say = (text) => interaction.reply({ content: text, flags: MessageFlags.Ephemeral });

    try {
      // ── 不需要正在播放的按鈕：佇列換頁、停止的確認 ──
      if (interaction.customId.startsWith('uq_qpage:')) {
        const page = Number(interaction.customId.split(':')[1]) || 0;
        return await interaction.update(buildQueueView(guildId, page));
      }
      if (interaction.customId === 'uq_stop_no') {
        return await interaction.update({ content: '好，繼續播放。', embeds: [], components: [] });
      }
      if (interaction.customId.startsWith('uq_stop_yes:')) {
        const pending = pendingStops.get(interaction.customId.split(':')[1]);
        if (!nowPlaying.has(guildId)) {
          return await interaction.update({ content: 'ℹ️ 已經停止了。', embeds: [], components: [] });
        }
        if (!pending || pending.np !== nowPlaying.get(guildId) || Date.now() - pending.at > STOP_CONFIRM_TTL_MS) {
          return await interaction.update({ content: 'ℹ️ 這個確認已經過期，請再按一次「停止播放」。', embeds: [], components: [] });
        }
        const count = (queues.get(guildId) || []).length;
        stopAll(guildId);
        await interaction.update({ content: `⏹️ 已停止播放${count ? `，清空了 ${count} 首佇列` : ''}。`, embeds: [], components: [] });
        webSync.notifyChange();
        return;
      }

      const np = nowPlaying.get(guildId);
      if (!np) {
        return await interaction.reply({ content: 'ℹ️ 目前沒有播放音樂。用 /play 點歌。', flags: MessageFlags.Ephemeral });
      }

      // ★ 使用者操作控制面板按鈕，視為頻道仍活躍，重置閒置計時器
      voiceMonitor.touchActivity(guildId);

      switch (interaction.customId) {
        case 'uq_skip': {
          const queue = queues.get(guildId) || [];
          const loopMode = loopSettings.get(guildId) || 'off';
          const isRandomPlay = randomPlaySettings.get(guildId) || false;

          // 隨機連播模式下，skip 直接觸發 player.stop()，Idle 事件會自動隨機挑下一首
          if (isRandomPlay) {
            skipCurrent(guildId);
            await say('⏭️ 已跳過，接著隨機連播下一首。');
          } else if (queue.length === 0 && loopMode === 'off') {
            // 只有「佇列真的空了」且「循環模式關閉」時才整組停止；
            // 否則交給 player.stop() 觸發 Idle 事件，讓 playback.js 的循環邏輯接手
            stopAll(guildId);
            await say('⏭️ 已跳過。佇列是空的，已停止播放。');
          } else if (loopMode === 'one') {
            const text = loopOneSkipText(guildId);
            skipCurrent(guildId);
            await say(text);
          } else {
            skipCurrent(guildId);
            await say('⏭️ 已跳過這首。');
          }
          webSync.notifyChange();
          break;
        }

        case 'uq_pause':
        case 'uq_resume': {
          const isPause = interaction.customId === 'uq_pause';
          const r = isPause ? pauseCurrent(guildId) : resumeCurrent(guildId);
          if (r === 'busy') {
            await interaction.reply({ content: PAUSE_REPLIES.busy, flags: MessageFlags.Ephemeral });
            break;
          }
          // 成功或本來就是該狀態：都把這則面板就地換成最新的按鈕（面板可能是舊的）
          const embed = _buildEmbed(guildId);
          await interaction.update({ embeds: embed ? [embed] : [], components: _buildButtons(guildId) });
          webSync.notifyChange();
          break;
        }

        // 停止＝停止播放並清空佇列（決定 6）：佇列 5 首以上先問一次，只有按的人看得到
        case 'uq_stop': {
          const count = (queues.get(guildId) || []).length;
          if (count >= STOP_CONFIRM_MIN) {
            const token = newStopToken(np);
            await interaction.reply({
              embeds: [new EmbedBuilder().setColor(C.DANGER).setTitle(`停止播放並清空 ${count} 首佇列？`)],
              components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`uq_stop_yes:${token}`).setLabel('停止並清空').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('uq_stop_no').setLabel('繼續播放').setStyle(ButtonStyle.Secondary),
              )],
              flags: MessageFlags.Ephemeral,
            });
            break;
          }
          stopAll(guildId);
          await say(`⏹️ 已停止播放${count ? `，清空了 ${count} 首佇列` : ''}。`);
          webSync.notifyChange();
          break;
        }

        case 'uq_loop_one':
        case 'uq_loop_all': {
          const mode = interaction.customId === 'uq_loop_one' ? 'one' : 'all';
          // 開啟循環時關閉隨機連播（互斥）
          randomPlaySettings.set(guildId, false);
          const next = loopSettings.get(guildId) === mode ? 'off' : mode;
          loopSettings.set(guildId, next);
          if (next === 'all') resetLoopAllCycle(guildId);
          await say(next === 'one' ? '🔂 已開啟單曲循環' : next === 'all' ? '🔁 已開啟列表循環' : '➡️ 已改回不循環');
          // 走面板更新的排隊（換歌時正在重發面板也不會互相蓋掉）；會順便排程寫出播放快照
          await updateControlPanel(guildId, interaction.channel, { preferEdit: true });
          webSync.notifyChange();
          break;
        }

        case 'uq_random_play': {
          const next = !(randomPlaySettings.get(guildId) || false);
          randomPlaySettings.set(guildId, next);
          if (next) {
            // 開啟隨機連播時，關閉其他循環模式（互斥）；每次開啟都是全新一輪，
            // 重置洗牌袋，與 /music randomplay（playRandomLocal 內部）的行為一致
            loopSettings.set(guildId, 'off');
            resetShuffleBag(guildId);
          }
          await say(next ? '🎲 已開啟隨機連播' : '➡️ 已關閉隨機連播');
          await updateControlPanel(guildId, interaction.channel, { preferEdit: true });
          webSync.notifyChange();
          break;
        }

        case 'uq_queue':
          await interaction.reply({ ...buildQueueView(guildId, 0), flags: MessageFlags.Ephemeral });
          break;
      }
    } catch (err) {
      logger.error('UnifiedQueue', '按鈕互動錯誤:', err);
      try { await interaction.reply({ content: '⚠️ 沒能完成，請再按一次；還是不行就用 /music nowplaying 叫出新面板。', flags: MessageFlags.Ephemeral }); } catch {}
    }
  });

  client.commands.set(playCommand.data.name, playCommand);
  client.commands.set(musicCommand.data.name, musicCommand);

  bootSummary.report('音樂播放（/play, /music）', 'ok', 'YouTube / Bilibili / 本地音樂佇列已就緒');
}

// ════════════════════════════════════════════════════════
//  /play：獨立頂層指令（依需求維持原樣，不併入 /music）
// ════════════════════════════════════════════════════════
const playCommand = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('播放 YouTube、Bilibili 影片或音樂庫的歌')
    .addStringOption(opt =>
      opt.setName('input')
        .setDescription('影片網址或歌名')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(opt =>
      opt.setName('shuffle')
        .setDescription('全部加入時的播放順序')
        .setRequired(false)
        .addChoices(
          { name: '📋 照歌名順序（預設）', value: 'no' },
          { name: '🔀 打亂順序', value: 'yes' },
        )
    ),
  async execute(interaction) {
    return handleMusicPlay(interaction);
  }
};

// ════════════════════════════════════════════════════════
//  /music 單一指令，底下掛 stop / skip / loop / queue /
//  clear / nowplaying / randomplay /
//  list / idle（★ 已從 group 合併為單一 subcommand）
//  （play 已依需求拆回獨立的 /play 指令）
// ════════════════════════════════════════════════════════
const musicCommand = {
  data: new SlashCommandBuilder()
    .setName('music')
    .setDescription('音樂播放相關功能')
    .addSubcommand(sub => sub.setName('stop').setDescription('停止播放並清空佇列'))
    .addSubcommand(sub => sub.setName('skip').setDescription('跳過當前歌曲'))
    .addSubcommand(sub => sub.setName('pause').setDescription('暫停播放（用 /music resume 繼續）'))
    .addSubcommand(sub => sub.setName('resume').setDescription('繼續播放'))
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('從佇列移除指定的一首歌')
        .addIntegerOption(opt =>
          opt.setName('position')
            .setDescription('要移除第幾首（打數字會列出對應的歌名）')
            .setMinValue(1)
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand(sub => sub.setName('loop').setDescription('切換循環模式（不循環 → 單曲循環 → 列表循環）'))
    .addSubcommand(sub => sub.setName('queue').setDescription('查看播放佇列'))
    .addSubcommand(sub => sub.setName('clear').setDescription('清空播放佇列'))
    .addSubcommand(sub => sub.setName('nowplaying').setDescription('查看目前播放的詳細資訊'))
    .addSubcommand(sub =>
      sub.setName('randomplay')
        .setDescription('從音樂庫隨機播一首')
        .addStringOption(opt =>
          opt.setName('continuous')
            .setDescription('播完要不要繼續隨機播下去')
            .setRequired(false)
            .addChoices(
              { name: '🎲 開啟隨機連播', value: 'yes' },
              { name: '▶️ 只播一首', value: 'no' },
            )
        )
    )
    // 原本是 local 群組底下只有 list 一個子指令，拿掉多餘的一層
    .addSubcommand(sub =>
      sub.setName('list').setDescription('列出音樂庫的歌（常播的在前面）')
    )
    // ★ 修改：idle 從 addSubcommandGroup（3個獨立子指令）
    //   合併為單一 addSubcommand + 可選 action 參數，
    //   邏輯與 /timeannounce 的合併方式一致：
    //   留空 = 查看狀態，帶 action = 開啟/關閉
    .addSubcommand(sub =>
      sub.setName('idle')
        .setDescription('沒人聽時自動停止播放（管理員）')
        .addStringOption(opt =>
          opt.setName('action')
            .setDescription('留空＝查看目前設定')
            .addChoices(
              { name: '開啟', value: 'enable' },
              { name: '關閉', value: 'disable' },
              { name: '查看狀態', value: 'status' },
            )
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'list':         return handleMusicList(interaction);
      case 'stop':         return handleMusicStop(interaction);
      case 'skip':         return handleMusicSkip(interaction);
      case 'pause':        return handleMusicPause(interaction);
      case 'resume':       return handleMusicResume(interaction);
      case 'remove':       return handleMusicRemove(interaction);
      case 'loop':         return handleMusicLoop(interaction);
      case 'queue':        return handleMusicQueue(interaction);
      case 'clear':        return handleMusicClear(interaction);
      case 'nowplaying':   return handleMusicNowPlaying(interaction);
      case 'randomplay':   return handleMusicRandomPlay(interaction);
      // ★ 修改：idle 不再依賴 subcommandGroup 判斷，
      //   直接從 sub === 'idle' 進入，action 未帶時預設為 'status'
      case 'idle': {
        const action = interaction.options.getString('action') ?? 'status';
        return handleMusicIdle(interaction, action);
      }
    }
  }
};

// ── /play ──────────────────────────────────────────
async function handleMusicPlay(interaction) {
  await interaction.deferReply();
  const input = interaction.options.getString('input');
  const shuffleOpt = interaction.options.getString('shuffle') ?? 'no';
  await handlePlay(interaction, input, shuffleOpt);
}

// ── /music stop ──────────────────────────────────────────
async function handleMusicStop(interaction) {
  if (!nowPlaying.has(interaction.guildId)) {
    return interaction.reply({ content: 'ℹ️ 目前沒有播放音樂。用 /play 點歌。', flags: MessageFlags.Ephemeral });
  }
  const count = (queues.get(interaction.guildId) || []).length;
  stopAll(interaction.guildId);
  await interaction.reply({ content: `⏹️ 已停止播放${count ? `，清空了 ${count} 首佇列` : ''}。` });
}

// ── /music skip ──────────────────────────────────────────
async function handleMusicSkip(interaction) {
  const np = nowPlaying.get(interaction.guildId);
  if (!np) return interaction.reply({ content: 'ℹ️ 目前沒有播放音樂。用 /play 點歌。', flags: MessageFlags.Ephemeral });

  const queue = queues.get(interaction.guildId) || [];
  const loopMode = loopSettings.get(interaction.guildId) || 'off';
  const isRandomPlay = randomPlaySettings.get(interaction.guildId) || false;

  // 隨機連播模式下，skip 直接觸發 player.stop()，Idle 事件自動隨機下一首
  if (isRandomPlay) {
    skipCurrent(interaction.guildId);
    return interaction.reply({ content: '⏭️ 已跳過，接著隨機連播下一首。' });
  }

  // 邏輯與 uq_skip 按鈕保持一致：尊重循環模式，不再無條件停止
  if (queue.length === 0 && loopMode === 'off') {
    stopAll(interaction.guildId);
    return interaction.reply({ content: '⏭️ 已跳過。佇列是空的，已停止播放。' });
  }
  if (loopMode === 'one') {
    const text = loopOneSkipText(interaction.guildId);
    skipCurrent(interaction.guildId);
    return interaction.reply({ content: text });
  }
  skipCurrent(interaction.guildId);
  await interaction.reply({ content: '⏭️ 已跳過這首' });
}

// ── /music pause / resume ─────────────────────────────────
const PAUSE_REPLIES = {
  none:    'ℹ️ 目前沒有播放音樂。用 /play 點歌。',
  busy:    '⏳ Bot 正在播報語音或載入歌曲，請過幾秒再試。',
};
async function handleMusicPause(interaction) {
  const r = pauseCurrent(interaction.guildId);
  if (r === 'ok') {
    voiceMonitor.touchActivity(interaction.guildId);
    refreshControlPanel(interaction.guildId);
    webSync.notifyChange();
    return interaction.reply({ content: '⏸️ 已暫停。輸入 /music resume 繼續播放。' });
  }
  const msg = r === 'already' ? 'ℹ️ 已經是暫停狀態。輸入 /music resume 繼續播放。' : PAUSE_REPLIES[r];
  return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
}

async function handleMusicResume(interaction) {
  const r = resumeCurrent(interaction.guildId);
  if (r === 'ok') {
    voiceMonitor.touchActivity(interaction.guildId);
    refreshControlPanel(interaction.guildId);
    webSync.notifyChange();
    return interaction.reply({ content: '▶️ 繼續播放' });
  }
  const msg = r === 'already' ? 'ℹ️ 目前正在播放，沒有暫停' : PAUSE_REPLIES[r];
  return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
}

// ── /music remove ─────────────────────────────────────────
async function handleMusicRemove(interaction) {
  const queue = queues.get(interaction.guildId) || [];
  if (queue.length === 0) {
    return interaction.reply({ content: 'ℹ️ 佇列是空的，沒有歌可以移除。', flags: MessageFlags.Ephemeral });
  }
  const pos = interaction.options.getInteger('position', true);
  if (pos > queue.length) {
    return interaction.reply({
      content: `⚠️ 佇列只有 ${queue.length} 首，請輸入 1～${queue.length} 的編號（用 /music queue 查看）。`,
      flags: MessageFlags.Ephemeral,
    });
  }
  const [removed] = queue.splice(pos - 1, 1);
  session.schedule();
  if (pos <= 2) prefetchUpcoming(interaction.guildId); // 前兩首會預先下載，移除後換新的補上
  await interaction.reply({ content: `🗑️ 已從佇列移除第 ${pos} 首：**${md(removed.title)}**` });
}

// ── /music loop ───────────────────────────────────────────
async function handleMusicLoop(interaction) {
  const np = nowPlaying.get(interaction.guildId);
  if (!np) return interaction.reply({ content: 'ℹ️ 目前沒有播放音樂。用 /play 點歌。', flags: MessageFlags.Ephemeral });

  // 切換循環模式時，關閉隨機連播（互斥）
  randomPlaySettings.set(interaction.guildId, false);

  const cur = loopSettings.get(interaction.guildId) || 'off';
  const next = cur === 'off' ? 'one' : cur === 'one' ? 'all' : 'off';
  loopSettings.set(interaction.guildId, next);
  if (next === 'all') resetLoopAllCycle(interaction.guildId);
  session.schedule();

  const loopText = next === 'one' ? '🔂 已開啟單曲循環' : next === 'all' ? '🔁 已開啟列表循環' : '➡️ 已改回不循環';

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(next === 'off' ? C.NEUTRAL : C.MUSIC)
        .setTitle(loopText)
        .addFields({
          name: '正在播放',
          value: np.item.type === 'bilibili'
            ? `[${md(np.item.title)}](${np.item.url})`
            : `**${md(np.item.title)}**`,
          inline: false,
        })
        .setTimestamp()
    ]
  });
  await updateControlPanel(interaction.guildId, interaction.channel);
}

// ── /music queue ──────────────────────────────────────────
// 每頁 20 首，超過時 ◀ ▶ 換頁（buildQueueView，跟面板的「佇列」按鈕共用）
async function handleMusicQueue(interaction) {
  const np = nowPlaying.get(interaction.guildId);
  const queueList = queues.get(interaction.guildId) || [];
  if (!np && queueList.length === 0) {
    return interaction.reply({ content: 'ℹ️ 目前沒有播放音樂，佇列也是空的。用 /play 點歌。', flags: MessageFlags.Ephemeral });
  }
  await interaction.reply(buildQueueView(interaction.guildId, 0));
}

// /music remove 的位置自動完成：「3. 歌名」，可以打編號或歌名過濾（Discord 一次最多 25 個）
function respondQueuePositions(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'position') { interaction.respond([]).catch(() => {}); return; }
  const queue = queues.get(interaction.guildId) || [];
  const q = String(focused.value || '').trim().toLowerCase();
  const choices = queue
    .map((t, i) => ({ name: `${i + 1}. ${t.title}`.slice(0, 100), value: i + 1 }))
    .filter((c) => !q || String(c.value).startsWith(q) || c.name.toLowerCase().includes(q))
    .slice(0, 25);
  interaction.respond(choices).catch(() => {});
}

// ── /music clear ──────────────────────────────────────────
async function handleMusicClear(interaction) {
  const queue = queues.get(interaction.guildId);
  if (!queue || queue.length === 0) {
    return interaction.reply({ content: 'ℹ️ 佇列已經是空的。', flags: MessageFlags.Ephemeral });
  }
  const count = queue.length;
  queues.set(interaction.guildId, []);
  session.schedule();
  await interaction.reply({ content: `🗑️ 已清空佇列（${count} 首）` });
}

// ── /music nowplaying ─────────────────────────────────────
async function handleMusicNowPlaying(interaction) {
  const np = nowPlaying.get(interaction.guildId);
  if (!np) return interaction.reply({ content: 'ℹ️ 目前沒有播放音樂。用 /play 點歌。', flags: MessageFlags.Ephemeral });
  const embed = _buildEmbed(interaction.guildId);
  await interaction.reply({ embeds: [embed] });
}

// ── /music randomplay ─────────────────────────────────────
async function handleMusicRandomPlay(interaction) {
  await interaction.deferReply();

  const guildId = interaction.guildId;
  const continuousOpt = interaction.options.getString('continuous') ?? 'no';
  const enableContinuous = continuousOpt === 'yes';

  // 確保語音連線
  let connection;
  try {
    connection = await ensureConnection(interaction);
  } catch {
    return interaction.editReply('❌ 沒能加入語音頻道，請再試一次。');
  }
  if (!connection) return interaction.editReply('🔈 先加入一個語音頻道，Bot 才知道要去哪裡播。加入後再用一次指令。');

  // 同 /play：下指令就算頻道仍活躍，重置沉默計時（剛進頻道還沒開麥的人不會被立刻判定無人說話）
  voiceMonitor.touchActivity(guildId);

  // 若目前正在播放，先停止（隨機播放視為全新開始）
  if (nowPlaying.has(guildId)) {
    stopAll(guildId, { reason: 'restart' });
  }

  const track = await playRandomLocal(guildId, interaction.channel, { enableContinuous });

  if (!track) {
    return interaction.editReply('ℹ️ 音樂庫還沒有歌。加歌之後就能用 /play 點播。');
  }

  const embed = new EmbedBuilder()
    .setColor(C.MUSIC)
    .setTitle(enableContinuous ? '🎲 隨機連播已開始' : '🎲 隨機播一首')
    .setDescription(`🎧 **${md(track.title)}**`)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  await updateControlPanel(guildId, interaction.channel);
}

// ── /music list ───────────────────────────────────────────
// 延遲 require 避免與 localMusicHandler.js → unifiedQueue/index.js 形成循環依賴
async function handleMusicList(interaction) {
  const { buildLocalListReply } = require('../localMusicHandler');
  await interaction.reply(buildLocalListReply());
}

// ── /music idle（單一指令版）：enable / disable / status（管理員專用） ──
// ★ 修改：改接收 action 字串（'enable' | 'disable' | 'status'），
//   由外層呼叫時已預設補上 'status'，內部邏輯完全沿用原本判斷方式
async function handleMusicIdle(interaction, action) {
  // 執行期權限二次檢查（防止管理員在「整合」設定中覆寫了指令權限）
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      content: '🔒 只有管理員可以使用這個指令。',
      flags: MessageFlags.Ephemeral,
    });
  }

  const guildId = interaction.guildId;

  if (action === 'status') {
    const enabled = voiceMonitor.isEnabled(guildId);
    return interaction.reply({
      content: `📊 閒置自動停止播放：${enabled ? '開啟' : '關閉'}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const enable = action === 'enable';
  voiceMonitor.setEnabled(guildId, enable);

  if (enable) {
    // 若機器人目前已在語音頻道內，立即啟動監控（不需等下次重新連線）
    const connection = connections.get(guildId) || getVoiceConnection(guildId);
    let monitorStarted = false;

    if (connection) {
      const channelId = connection.joinConfig?.channelId;
      const voiceChannel = channelId ? interaction.guild.channels.cache.get(channelId) : null;

      if (voiceChannel) {
        // ★ 本專案目前只使用常駐模式（閒置只停止播放、不離開頻道）。
        //   一般模式（依頻道是否為 TARGET_VOICE_CHANNEL_ID 決定要不要離開頻道）
        //   已停用，保留註解供之後參考：
        //
        // const isTargetChannel = voiceChannel.id === process.env.TARGET_VOICE_CHANNEL_ID;
        // onStop: isTargetChannel
        //   ? _createPersistentIdleHandler(guildId, voiceChannel)
        //   : _createIdleStopHandler(guildId, connection, interaction.channel),

        voiceMonitor.startMonitoring({
          guildId,
          connection,
          channel: voiceChannel,
          client: interaction.client,
          onStop: _createPersistentIdleHandler(guildId, voiceChannel),
        });
        monitorStarted = true;
      }
    }

    // Bot 不在語音頻道時，設定要等下次點歌才開始計時
    const statusNote = monitorStarted ? '' : '，下次點歌時生效';

    await interaction.reply({
      content: `✅ 已開啟閒置自動停止播放${statusNote}：頻道沒人 30 分鐘或 60 分鐘沒人說話就停止。`,
      flags: MessageFlags.Ephemeral,
    });
  } else {
    // 立即停止當前監控計時器（若有正在跑的）
    voiceMonitor.stopMonitoring(guildId);

    await interaction.reply({
      content: '➡️ 已關閉閒置自動停止播放。',
      flags: MessageFlags.Ephemeral,
    });
  }
}

module.exports = {
  setupUnifiedCommands,
};