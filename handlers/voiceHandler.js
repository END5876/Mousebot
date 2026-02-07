const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType
} = require('@discordjs/voice');
const { EmbedBuilder } = require('discord.js');
const { getQueue } = require('./musicHandler');
const { PREFIX } = require('../config/settings');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');

// 創建靜音音頻流
function createSilenceStream() {
  const silence = Buffer.alloc(3840, 0); // 48kHz, 16-bit, mono, 20ms of silence
  let index = 0;
  
  return new Readable({
      read() {
          if (index < 100) { // 播放 2 秒的靜音 (100 * 20ms)
              this.push(silence);
              index++;
          } else {
              index = 0; // 重置計數器，無限循環
              this.push(silence);
          }
      }
  });
}

// 全局變量存儲播放器和定時器
const silencePlayers = new Map();
const silenceTimers = new Map();
const dangPlayers = new Map(); // 存儲 dang 音效播放器
const dang2Players = new Map(); // 存儲 dang2 音效播放器

function setupVoiceCommands(client) {
  client.on('messageCreate', async message => {
      if (message.author.bot) return;

      const content = message.content;

      // !join
      if (content === `${PREFIX}join`) {
          if (!message.member.voice.channel) {
              return message.reply('你要我去哪?');
          }

          const channel = message.member.voice.channel;

          try {
              const connection = joinVoiceChannel({
                  channelId: channel.id,
                  guildId: channel.guild.id,
                  adapterCreator: channel.guild.voiceAdapterCreator,
                  selfDeaf: false,
                  selfMute: false,
              });

              connection.on(VoiceConnectionStatus.Ready, () => {
                  console.log('✅ 語音連接已就緒');
              });

              connection.on(VoiceConnectionStatus.Disconnected, async () => {
                  try {
                      await Promise.race([
                          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                      ]);
                  } catch (error) {
                      connection.destroy();
                      console.log('❌ 語音連接已斷開');
                      // 清理所有播放器
                      stopSilenceAudio(message.guild.id);
                      stopDangSound(message.guild.id);
                      stopDang2Sound(message.guild.id);
                  }
              });

              await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
              console.log(`✅ 已加入語音頻道：${channel.name} (${channel.guild.name})`);

              message.reply(`✅ 已加入語音頻道：**${channel.name}**`);

          } catch (error) {
              console.error('加入語音頻道時發生錯誤：', error);
              message.reply('❌ 加入語音頻道時發生錯誤');
          }
      }

      // !leave
      if (content === `${PREFIX}leave`) {
          const connection = getVoiceConnection(message.guild.id);

          if (!connection) {
              return message.reply('你要我離開哪?');
          }

          connection.destroy();
          
          const queue = getQueue(message.guild.id);
          queue.clear();
          
          // 停止所有音效
         stopSilenceAudio(message.guild.id);
        
         const { stopAllSounds } = require('./soundEffectHandler');
         stopAllSounds(message.guild.id);
        
         const { stopBilibiliAudio } = require('./bilibiliHandler');
         stopBilibiliAudio(message.guild.id);
          
          console.log(`👋 已離開語音頻道 (${message.guild.name})`);
          message.reply('👋 已離開語音頻道');
      }

      // !voice
      if (content === `${PREFIX}voice`) {
          const connection = getVoiceConnection(message.guild.id);
          
          if (!connection) {
              return message.reply('📢 Bot 目前不在任何語音頻道中');
          }

          const channel = message.guild.channels.cache.get(connection.joinConfig.channelId);
          const isSilencePlaying = silencePlayers.has(message.guild.id);
          const isDangPlaying = dangPlayers.has(message.guild.id);
          const isDang2Playing = dang2Players.has(message.guild.id);
          
          const embed = new EmbedBuilder()
              .setColor(0x00FF00)
              .setTitle('🎤 語音頻道狀態')
              .addFields(
                  { name: '頻道名稱', value: channel?.name || '未知', inline: true },
                  { name: '連接狀態', value: connection.state.status, inline: true },
                  { name: '頻道成員', value: `${channel?.members.size || 0} 人`, inline: true },
                  { name: '防踢狀態', value: isSilencePlaying ? '🔇 靜音播放中' : '⏸️ 未啟用', inline: true },
                  { name: 'Dang 音效', value: isDangPlaying ? '🔔 播放中' : '⏸️ 未播放', inline: true },
                  { name: 'Dang2 音效', value: isDang2Playing ? '🔔 播放中' : '⏸️ 未播放', inline: true }
              )
              .setTimestamp();

          message.reply({ embeds: [embed] });
      }

      // !silence - 開始播放靜音音頻
      if (content === `${PREFIX}silence`) {
          const connection = getVoiceConnection(message.guild.id);
          
          if (!connection) {
              return message.reply('❌ Bot 必須先加入語音頻道才能播放靜音音頻');
          }

          if (silencePlayers.has(message.guild.id)) {
              return message.reply('🔇 靜音音頻已經在播放中');
          }

          startSilenceAudio(message.guild.id, connection);
          message.reply('🔇 已開始播放靜音音頻，防止被踢出頻道');
      }

      // !stopsilence - 停止播放靜音音頻
      if (content === `${PREFIX}stopsilence`) {
          if (!silencePlayers.has(message.guild.id)) {
              return message.reply('❌ 目前沒有播放靜音音頻');
          }

          stopSilenceAudio(message.guild.id);
          message.reply('⏹️ 已停止播放靜音音頻');
      }

      // !autosilence - 自動靜音模式（5分鐘後自動開始播放靜音）
      if (content === `${PREFIX}autosilence`) {
          const connection = getVoiceConnection(message.guild.id);
          
          if (!connection) {
              return message.reply('❌ Bot 必須先加入語音頻道');
          }

          // 清除現有定時器
          if (silenceTimers.has(message.guild.id)) {
              clearTimeout(silenceTimers.get(message.guild.id));
          }

          // 設置 5 分鐘後自動開始靜音
          const timer = setTimeout(() => {
              if (getVoiceConnection(message.guild.id) && !silencePlayers.has(message.guild.id)) {
                  startSilenceAudio(message.guild.id, getVoiceConnection(message.guild.id));
                  console.log(`🔇 自動開始播放靜音音頻 (${message.guild.name})`);
              }
              silenceTimers.delete(message.guild.id);
          }, 5 * 60 * 1000); // 5 分鐘

          silenceTimers.set(message.guild.id, timer);
          message.reply('⏰ 已設置自動靜音模式，5分鐘後將自動開始播放靜音音頻');
      }

      // !dang - 循環播放/停止 dang.mp3
      if (content === `${PREFIX}dang`) {
          // 如果正在播放，則停止
          if (dangPlayers.has(message.guild.id)) {
              stopDangSound(message.guild.id);
              message.reply('⏹️ 已停止播放 dang.mp3');
              return;
          }

          const connection = getVoiceConnection(message.guild.id);
          
          if (!connection) {
              // 如果 bot 不在語音頻道，嘗試加入用戶的頻道
              if (!message.member.voice.channel) {
                  return message.reply('❌ 你必須先加入語音頻道！');
              }

              try {
                  const newConnection = joinVoiceChannel({
                      channelId: message.member.voice.channel.id,
                      guildId: message.guild.id,
                      adapterCreator: message.guild.voiceAdapterCreator,
                      selfDeaf: false,
                      selfMute: false,
                  });

                  await entersState(newConnection, VoiceConnectionStatus.Ready, 30_000);
                  playDangSound(message.guild.id, newConnection, message, 'dang.mp3');
              } catch (error) {
                  console.error('加入語音頻道時發生錯誤：', error);
                  return message.reply('❌ 加入語音頻道時發生錯誤');
              }
          } else {
              playDangSound(message.guild.id, connection, message, 'dang.mp3');
          }
      }

      // !dang2 - 循環播放/停止 dang2.mp3
      if (content === `${PREFIX}dang2`) {
          // 如果正在播放，則停止
          if (dang2Players.has(message.guild.id)) {
              stopDang2Sound(message.guild.id);
              message.reply('⏹️ 已停止播放 dang2.mp3');
              return;
          }

          const connection = getVoiceConnection(message.guild.id);
          
          if (!connection) {
              // 如果 bot 不在語音頻道，嘗試加入用戶的頻道
              if (!message.member.voice.channel) {
                  return message.reply('❌ 你必須先加入語音頻道！');
              }

              try {
                  const newConnection = joinVoiceChannel({
                      channelId: message.member.voice.channel.id,
                      guildId: message.guild.id,
                      adapterCreator: message.guild.voiceAdapterCreator,
                      selfDeaf: false,
                      selfMute: false,
                  });

                  await entersState(newConnection, VoiceConnectionStatus.Ready, 30_000);
                  playDangSound(message.guild.id, newConnection, message, 'dang2.mp3');
              } catch (error) {
                  console.error('加入語音頻道時發生錯誤：', error);
                  return message.reply('❌ 加入語音頻道時發生錯誤');
              }
          } else {
              playDangSound(message.guild.id, connection, message, 'dang2.mp3');
          }
      }
  });
}

// 開始播放靜音音頻
function startSilenceAudio(guildId, connection) {
  try {
      const player = createAudioPlayer();
      const silenceStream = createSilenceStream();
      const resource = createAudioResource(silenceStream, {
          inputType: StreamType.Raw,
          inlineVolume: true
      });

      // 設置音量為最低
      resource.volume.setVolume(0.01);

      player.play(resource);
      connection.subscribe(player);

      // 當音頻結束時重新播放
      player.on(AudioPlayerStatus.Idle, () => {
          if (silencePlayers.has(guildId)) {
              const newSilenceStream = createSilenceStream();
              const newResource = createAudioResource(newSilenceStream, {
                  inputType: StreamType.Raw,
                  inlineVolume: true
              });
              newResource.volume.setVolume(0.01);
              player.play(newResource);
          }
      });

      player.on('error', (error) => {
          console.error('靜音播放器錯誤：', error);
          stopSilenceAudio(guildId);
      });

      silencePlayers.set(guildId, player);
      console.log(`🔇 開始播放靜音音頻 (Guild: ${guildId})`);

  } catch (error) {
      console.error('創建靜音播放器時發生錯誤：', error);
  }
}

// 停止播放靜音音頻
function stopSilenceAudio(guildId) {
  const player = silencePlayers.get(guildId);
  if (player) {
      player.stop();
      silencePlayers.delete(guildId);
      console.log(`⏹️ 停止播放靜音音頻 (Guild: ${guildId})`);
  }

  // 清除自動靜音定時器
  const timer = silenceTimers.get(guildId);
  if (timer) {
      clearTimeout(timer);
      silenceTimers.delete(guildId);
  }
}

// 播放 dang 音效（循環）
function playDangSound(guildId, connection, message, fileName) {
  try {
      const dangPath = path.join(__dirname, '..', 'sounds', fileName);
      
      // 檢查檔案是否存在
      if (!fs.existsSync(dangPath)) {
          console.error(`❌ ${fileName} 檔案不存在:`, dangPath);
          return message.reply(`❌ 找不到 ${fileName} 音效檔`);
      }

      const player = createAudioPlayer();
      const playerMap = fileName === 'dang.mp3' ? dangPlayers : dang2Players;
      
      // 播放函數
      const playLoop = () => {
          const resource = createAudioResource(dangPath, {
              inlineVolume: true
          });

          // 設置音量
          resource.volume.setVolume(0.5);
          player.play(resource);
      };

      // 當播放結束時，重新播放（循環）
      player.on(AudioPlayerStatus.Idle, () => {
          if (playerMap.has(guildId)) {
              //console.log(`🔁 循環播放 ${fileName}`);
              playLoop();
          }
      });

      player.on('error', (error) => {
          console.error(`❌ 播放 ${fileName} 時發生錯誤：`, error);
          message.reply('❌ 播放音效時發生錯誤');
          playerMap.delete(guildId);
      });

      // 儲存播放器
      playerMap.set(guildId, player);
      
      // 開始播放
      playLoop();
      connection.subscribe(player);

      message.react('🔔').catch(() => {});
      message.reply(`🔁 開始循環播放 ${fileName}`);
      console.log(`🔔 開始循環播放 ${fileName} (Guild: ${guildId})`);

  } catch (error) {
      console.error('❌ 創建音效播放器時發生錯誤：', error);
      message.reply('❌ 播放音效時發生錯誤');
  }
}

// 停止 dang.mp3
function stopDangSound(guildId) {
  const player = dangPlayers.get(guildId);
  if (player) {
      player.stop();
      dangPlayers.delete(guildId);
      console.log(`⏹️ 停止播放 dang.mp3 (Guild: ${guildId})`);
  }
}

// 停止 dang2.mp3
function stopDang2Sound(guildId) {
  const player = dang2Players.get(guildId);
  if (player) {
      player.stop();
      dang2Players.delete(guildId);
      console.log(`⏹️ 停止播放 dang2.mp3 (Guild: ${guildId})`);
  }
}

module.exports = { 
    setupVoiceCommands, 
    startSilenceAudio, 
    stopSilenceAudio,
    stopDangSound,
    stopDang2Sound
};
