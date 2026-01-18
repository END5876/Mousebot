const {
    createAudioPlayer,
    NoSubscriberBehavior
} = require('@discordjs/voice');

class MusicQueue {
    constructor() {
        this.songs = [];
        this.player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
            },
        });
        this.currentSong = null;
        this.isPlaying = false;
    }

    addSong(song) {
        this.songs.push(song);
    }

    getNextSong() {
        return this.songs.shift();
    }

    clear() {
        this.songs = [];
        this.currentSong = null;
        this.isPlaying = false;
        this.player.stop();
    }

    isEmpty() {
        return this.songs.length === 0;
    }

    getQueueLength() {
        return this.songs.length;
    }
}

// 格式化時長
function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

module.exports = { MusicQueue, formatDuration };