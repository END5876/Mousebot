// handlers/voice/stt/wakeup.js
// 職責：播放喚醒音效

const { createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');
const { WAKEUP_VOICE_PATH } = require('../sttConfig');

function playWakeupSound(connection) {
  return new Promise((resolve) => {
    if (!connection || !fs.existsSync(WAKEUP_VOICE_PATH)) return resolve();

    let done = false;
    let player = null;

    const finish = () => {
      if (done) return;
      done = true;
      try { player?.stop(); player?.removeAllListeners(); } catch {}
      resolve();
    };

    try {
      player = createAudioPlayer();
      const resource = createAudioResource(WAKEUP_VOICE_PATH);
      player.play(resource);
      connection.subscribe(player);
      player.once(AudioPlayerStatus.Idle, finish);
      player.once('error', finish);
      setTimeout(finish, 3000);
    } catch {
      finish();
    }
  });
}

module.exports = { playWakeupSound };
