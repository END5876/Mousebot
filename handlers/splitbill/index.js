'use strict';

const { MessageFlags } = require('discord.js');
const bootSummary = require('../../utils/bootSummary');
const splitbillCmd = require('./commands/splitbill');
const expenseUI = require('./interactions/expenseUI');
const memberUI = require('./interactions/memberUI');
const settleUI = require('./interactions/settleUI');
const tripUI = require('./interactions/tripUI');

// 全域輕量化快取，用於暫存使用者的跨面板操作狀態（例如記帳到一半時的數據）
const stateCache = new Map();

/**
 * 初始化分帳模組面板版
 */
function setupSplitbillCommands(client) {
  // 僅註冊唯一的面板進入點指令
  client.commands.set(splitbillCmd.data.name, splitbillCmd);

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

  bootSummary.report('分帳系統 (/splitbill)', 'ok', '多行程/多幣別記帳與結算');
}

/**
 * 分流按鈕點擊
 */
async function handleButtonInteraction(interaction) {
  const { customId } = interaction;

  if (customId === 'nav_main') {
    return splitbillCmd.showMainMenu(interaction, true);
  }

  if (customId.startsWith('exp_')) return expenseUI.handleButton(interaction, stateCache);
  if (customId.startsWith('mem_')) return memberUI.handleButton(interaction, stateCache);
  if (customId.startsWith('set_')) return settleUI.handleButton(interaction, stateCache);
  if (customId.startsWith('trip_')) return tripUI.handleButton(interaction, stateCache);
}

/**
 * 分流表單送出 (Modal)
 */
async function handleModalInteraction(interaction) {
  const { customId } = interaction;

  if (customId.startsWith('exp_')) return expenseUI.handleModal(interaction, stateCache);
  if (customId.startsWith('trip_')) return tripUI.handleModal(interaction, stateCache);
}

/**
 * 分流下拉選單 (String/User Select Menu)
 */
async function handleSelectInteraction(interaction) {
  const { customId } = interaction;

  if (customId.startsWith('exp_')) return expenseUI.handleSelectMenu(interaction, stateCache);
  if (customId.startsWith('mem_')) return memberUI.handleSelectMenu(interaction, stateCache);
  if (customId.startsWith('trip_')) return tripUI.handleSelectMenu(interaction, stateCache);
}

module.exports = { setupSplitbillCommands };