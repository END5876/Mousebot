'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'data/**', 'temp/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // 所有輸出請走 utils/logger.js（等級、格式、stderr 分流都在那裡統一處理）
      'no-console': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // UI 文字裡刻意用全形空白對齊
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipComments: true }],
    },
  },
  {
    // logger 本身、開機摘要表格、測試
    files: ['utils/logger.js', 'utils/bootSummary.js', 'test/**/*.js'],
    rules: { 'no-console': 'off' },
  },
];
