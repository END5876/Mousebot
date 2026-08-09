'use strict';

const { MessageFlags } = require('discord.js');
const bootSummary = require('../../utils/bootSummary');
const splitbillCmd = require('./commands/splitbill');
const splitbillQuickCmd = require('./commands/splitbillQuick');
const expenseUI = require('./interactions/expenseUI');
const memberUI = require('./interactions/memberUI');
const settleUI = require('./interactions/settleUI');
const tripUI = require('./interactions/tripUI');
const quickSplitUI = require('./interactions/quickSplitUI');
const { StateCache } = require('./utils/stateCache');
const storage = require('./utils/storage');
const { resolveTrip, isTripMember } = require('./utils/tripHelper');

// ────────────────────────────────────────────────────────────────
// 🔒 行程操作權限管控：行程一旦建立，只有「行程內的成員」才能對該行程
// 進行任何操作（記帳、成員管理、結算、行程設定…），非成員一律擋下。
//
// 這裡集中在路由層做一次性檢查，而不是每個 interactions/*.js 各自補，
// 原因：
//   1. 所有分帳相關的按鈕／表單／選單最終都會經過這裡的 handle*Interaction，
//      集中攔截可以確保沒有漏網之魚，也不用擔心未來新增功能時忘記補檢查。
//   2. customId 前綴（exp_ / mem_ / set_ / trip_）已經清楚標示「這是對某個
//      行程的操作」，可以直接依前綴判斷是否需要做成員身分檢查。
//
// 例外（不需要是行程成員也能操作）：
//   - nav_main／trip_nav：單純瀏覽主控台或行程設定總覽，非破壞性操作
//   - trip_btn_create_modal／trip_modal_create：建立「新」行程，此時行程
//     還不存在、自然也就沒有「行程內成員」的概念，建立者會自動成為成員
//   - qs_ 開頭：⚡ 快速分帳，本來就設計成不綁定任何行程，任何人都能用
// ────────────────────────────────────────────────────────────────
const TRIP_SCOPED_PREFIXES = ['exp_', 'mem_', 'set_', 'trip_'];
const TRIP_PERMISSION_EXEMPT_IDS = new Set([
  'nav_main',
  'trip_nav',
  'trip_btn_create_modal',
  'trip_modal_create',
]);

function isTripScopedCustomId(customId) {
  if (!customId) return false;
  if (TRIP_PERMISSION_EXEMPT_IDS.has(customId)) return false;
  if (customId.startsWith('qs_')) return false;
  return TRIP_SCOPED_PREFIXES.some((prefix) => customId.startsWith(prefix));
}

/**
 * 依 customId 決定這次互動實際要操作的行程物件。
 * 絕大多數 customId 操作的都是「目前作用中行程」，但切換行程
 * (trip_select_switch) 是唯一的例外：它操作的是使用者選單裡選中的目標行程，
 * 而不是目前作用中的行程，所以要單獨處理。
 */
function resolveTargetTrip(interaction) {
  const { customId, guildId } = interaction;

  if (customId === 'trip_select_switch') {
    const guild = storage.getGuild(guildId);
    const targetTripId = interaction.values && interaction.values[0];
    return targetTripId ? guild.trips[targetTripId] || null : null;
  }

  const { trip } = resolveTrip(guildId);
  return trip;
}

/**
 * 檢查發起互動的使用者是否有權限操作這次互動指向的行程。
 * 回傳 false 時，代表已經直接回覆使用者「無權限」的提示，呼叫端應立即 return，不再繼續往下處理。
 */
async function enforceTripPermission(interaction) {
  const { customId, user } = interaction;
  if (!isTripScopedCustomId(customId)) return true;

  const targetTrip = resolveTargetTrip(interaction);
  // 找不到行程（例如行程已被刪除、或尚未建立）時，交給原本的 handler 處理對應的錯誤訊息，
  // 這裡不重複攔截，避免蓋掉更精準的錯誤提示。
  if (!targetTrip) return true;

  if (!isTripMember(targetTrip, user.id)) {
    const msg = `❌ 你不是行程「${targetTrip.name}」的成員，無法操作此行程。請先請行程內的成員從「👥 成員管理 → ➕ 新增成員」把你加入。`;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
    return false;
  }

  return true;
}

// 全域輕量化快取，用於暫存使用者的跨面板操作狀態（例如記帳到一半時的數據）
// 以 guildId + userId 為 key，並帶有 TTL 自動過期清除，避免跨伺服器狀態污染與記憶體洩漏
const stateCache = new StateCache();

/**
 * 初始化分帳模組面板版
 */
function setupSplitbillCommands(client) {
  // 註冊面板進入點指令，以及給熟手用的免面板快速記帳指令
  client.commands.set(splitbillCmd.data.name, splitbillCmd);
  client.commands.set(splitbillQuickCmd.data.name, splitbillQuickCmd);

  // 攔截所有元件互動事件
  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isButton()) {
        await handleButtonInteraction(interaction);
      } else if (interaction.isModalSubmit()) {
        await handleModalInteraction(interaction);
      } else if (interaction.isAnySelectMenu()) {
        await handleSelectInteraction(interaction);
      }
    } catch (error) {
      console.error('⚠️ Splitbill UI 發生異常錯誤:', error);
      const errorMsg = `❌ 操作失敗：${error.message || '未知錯誤'}`;
      
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
      }
    }
  });

  bootSummary.report('分帳系統 (/splitbill, /splitbill-quick)', 'ok', '多行程/多幣別記帳與結算，支援面板與快速指令兩種操作方式');
}

/**
 * 分流按鈕點擊
 */
async function handleButtonInteraction(interaction) {
  const { customId } = interaction;

  if (!(await enforceTripPermission(interaction))) return;

  if (customId === 'nav_main') {
    return splitbillCmd.showMainMenu(interaction, true);
  }

  if (customId.startsWith('exp_')) return expenseUI.handleButton(interaction, stateCache);
  if (customId.startsWith('mem_')) return memberUI.handleButton(interaction, stateCache);
  if (customId.startsWith('set_')) return settleUI.handleButton(interaction, stateCache);
  if (customId.startsWith('trip_')) return tripUI.handleButton(interaction, stateCache);
  if (customId.startsWith('qs_')) return quickSplitUI.handleButton(interaction, stateCache);
}

/**
 * 分流表單送出 (Modal)
 */
async function handleModalInteraction(interaction) {
  const { customId } = interaction;

  if (!(await enforceTripPermission(interaction))) return;

  if (customId.startsWith('exp_')) return expenseUI.handleModal(interaction, stateCache);
  if (customId.startsWith('trip_')) return tripUI.handleModal(interaction, stateCache);
  if (customId.startsWith('qs_')) return quickSplitUI.handleModal(interaction, stateCache);
}

/**
 * 分流下拉選單 (String/User Select Menu)
 */
async function handleSelectInteraction(interaction) {
  const { customId } = interaction;

  if (!(await enforceTripPermission(interaction))) return;

  if (customId.startsWith('exp_')) return expenseUI.handleSelectMenu(interaction, stateCache);
  if (customId.startsWith('mem_')) return memberUI.handleSelectMenu(interaction, stateCache);
  if (customId.startsWith('set_')) return settleUI.handleSelectMenu(interaction, stateCache);
  if (customId.startsWith('trip_')) return tripUI.handleSelectMenu(interaction, stateCache);
  // 注意：⚡ 快速分帳全部改用單一 Modal（含代墊人／分攤方式文字欄位）完成，
  // 不再需要下拉選單這一步，因此這裡不需要 qs_ 的路由。
}

module.exports = { setupSplitbillCommands };