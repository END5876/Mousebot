// handlers/musicplayer/antibot/index.js
// 對外進入點：彙整拆分後的子模組（config / bilibili / youtube / combined），
// 維持與拆分前 musicAntiBot.js 完全相同的 module.exports 介面。

const { prepareBilibiliCookies, getBilibiliCookieState, ...bilibiliExports } = require('./bilibili');
const { prepareYouTubeCookies, YT_PO_TOKEN, getYoutubeCookieState, ...youtubeExports } = require('./youtube');
const { buildInfoArgs, buildPlaylistCheckArgs } = require('./combined');

function initCookies() {
  prepareBilibiliCookies();
  prepareYouTubeCookies();
  return {
    BILIBILI_COOKIES_FILE: getBilibiliCookieState().file,
    YT_COOKIES_FILE: getYoutubeCookieState().file,
  };
}

function getCookieStatus() {
  const bili = getBilibiliCookieState();
  const yt   = getYoutubeCookieState();
  return {
    bilibili : bili.file || bili.header,
    youtube  : yt.file   || yt.header,
    poToken  : YT_PO_TOKEN,
  };
}

module.exports = {
  initCookies,
  isYouTubeUrl: youtubeExports.isYouTubeUrl,
  YT_CLIENT_STRATEGIES: youtubeExports.YT_CLIENT_STRATEGIES,
  getYtClientStrategy: youtubeExports.getYtClientStrategy,
  rotateYtClient: youtubeExports.rotateYtClient,
  resetYtClient: youtubeExports.resetYtClient,
  buildYouTubeArgs: youtubeExports.buildYouTubeArgs,
  classifyYouTubeError: youtubeExports.classifyYouTubeError,
  buildBilibiliArgs: bilibiliExports.buildBilibiliArgs,
  buildBilibiliSearchArgs: bilibiliExports.buildBilibiliSearchArgs,
  buildYouTubeSearchArgs: youtubeExports.buildYouTubeSearchArgs,
  buildPlaylistCheckArgs,
  classifyBilibiliError: bilibiliExports.classifyBilibiliError,
  buildInfoArgs,
  getCookieStatus,
};
