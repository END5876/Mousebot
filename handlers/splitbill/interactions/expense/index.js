'use strict';

// handlers/splitbill/interactions/expense/index.js
// 對外進入點：彙整拆分後的子模組（helpers / ledger / logging / buttons /
// modals / selects），維持與拆分前完全相同的 module.exports 介面
// （handleButton / handleModal / handleSelectMenu）。

const { handleButton } = require('./buttons');
const { handleModal } = require('./modals');
const { handleSelectMenu } = require('./selects');

module.exports = { handleButton, handleModal, handleSelectMenu };
