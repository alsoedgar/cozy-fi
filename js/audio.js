// Cozy-Fi Modular Audio Engine

class AudioEngine {
  constructor() {
    this.audio = new Audio();
    this.isPlaying = false;
    this.playlist = [];
    this.currentIndex = 0;
    this.onTimeUpdateCallback = null;
    this.onTrackChangeCallback = null;

    // Wire HTML5 audio events
    this.audio.addEventListener('timeupdate', () => {
      if (this.onTimeUpdateCallback) {
        this.onTimeUpdateCallback(this.audio.currentTime, this.audio.duration);
      }
    });

    this.audio.addEventListener('ended', () => {
      this.next();
    });
  }

  updatePlaylist(tracks) {
    if (!Array.isArray(tracks) || tracks.length === 0) {
      this.playlist = [];
      this.currentIndex = 0;
      this.audio.removeAttribute('src');
      return;
    }
    this.playlist = tracks;
    this.currentIndex = 0;
    this.loadTrack(0);
  }

  getCurrentTrack() {
    return this.playlist[this.currentIndex];
  }

  loadTrack(index) {
    if (index < 0 || index >= this.playlist.length) return;
    this.currentIndex = index;
    const track = this.playlist[index];
    if (!track || !track.url) return;
    this.audio.src = track.url;
    this.audio.load();
    if (this.isPlaying) {
      this.audio.play().catch(e => console.log('Audio autoplay prevented:', e));
    }
    if (this.onTrackChangeCallback) {
      this.onTrackChangeCallback(track);
    }
  }

  play() {
    if (!this.audio.src || !this.getCurrentTrack()) return false;
    this.isPlaying = true;
    this.audio.play().catch(e => console.log('Audio play failed:', e));
    return true;
  }

  pause() {
    this.isPlaying = false;
    this.audio.pause();
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
    return this.isPlaying;
  }

  next() {
    if (this.playlist.length === 0) return;
    let nextIndex = (this.currentIndex + 1) % this.playlist.length;
    this.loadTrack(nextIndex);
  }

  prev() {
    if (this.playlist.length === 0) return;
    let prevIndex = this.currentIndex - 1;
    if (prevIndex < 0) prevIndex = this.playlist.length - 1;
    this.loadTrack(prevIndex);
  }

  seek(percent) {
    if (this.audio.duration) {
      this.audio.currentTime = (percent / 100) * this.audio.duration;
    }
  }

  setVolume(volume) {
    // volume is expected to be 0 to 1
    this.audio.volume = Math.max(0, Math.min(1, volume));
  }

  getVolume() {
    return this.audio.volume;
  }

  onTimeUpdate(callback) {
    this.onTimeUpdateCallback = callback;
  }

  onTrackChange(callback) {
    this.onTrackChangeCallback = callback;
  }

  // Find tracks matching mood
  getTracksByMood(mood) {
    return this.playlist.filter(t => t.mood === mood);
  }

  addToQueue(track) {
    if (track) this.playlist.push(track);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AudioEngine;
} else {
  window.AudioEngine = AudioEngine;
}
