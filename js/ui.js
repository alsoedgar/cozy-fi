// Cozy-Fi Audio Playback Controls and Event Binding Module
class UIManager {
  constructor(audioEngine, spotifyClient, controls, sliders) {
    this.audio = audioEngine;
    this.spotify = spotifyClient;

    // Controls elements
    this.playBtn = controls.playBtn;
    this.prevBtn = controls.prevBtn;
    this.nextBtn = controls.nextBtn;
    this.onPlaybackCommand = typeof controls.onPlaybackCommand === 'function'
      ? controls.onPlaybackCommand
      : () => {};
    this.onSeekCommand = typeof controls.onSeekCommand === 'function'
      ? controls.onSeekCommand
      : () => {};

    // Sliders
    this.timelineSlider = sliders.timelineSlider;
    this.timelineFill = sliders.timelineFill;
    this.timelineThumb = sliders.timelineThumb;
    this.currentTimeLabel = sliders.currentTimeLabel;
    this.totalTimeLabel = sliders.totalTimeLabel;
    this.sessionTimerFill = sliders.sessionTimerFill;

    this.volumeSlider = sliders.volumeSlider;
    this.volumeFill = sliders.volumeFill;
    this.volumeThumb = sliders.volumeThumb;

    this.init();
  }

  init() {
    this.playBtn.addEventListener('click', async () => {
      if (this.spotify && this.spotify.isAuthenticated) {
        // Check state first to determine if we should resume or pause
        try {
          const state = await this.spotify.getMyPlayerState();
          if (state) {
            if (state.is_playing) {
              await this.spotify.pause();
              this.updatePlayPauseButtonUI(false);
              this.onPlaybackCommand(false);
            } else {
              await this.spotify.resume();
              this.updatePlayPauseButtonUI(true);
              this.onPlaybackCommand(true);
            }
          } else {
            // Default play command
            await this.spotify.resume();
            this.updatePlayPauseButtonUI(true);
            this.onPlaybackCommand(true);
          }
        } catch (err) {
          console.error(err);
          window.showCozyError?.(err?.message || 'Could not read Spotify playback state.');
        }
      } else {
        alert('Connect Spotify in Settings before starting playback.');
      }
    });

    this.prevBtn.addEventListener('click', async () => {
      if (this.spotify && this.spotify.isAuthenticated) {
        try {
          await this.spotify.prev();
          this.onPlaybackCommand();
        } catch (error) { console.error(error); }
      } else {
        alert('Connect Spotify in Settings before starting playback.');
      }
    });

    this.nextBtn.addEventListener('click', async () => {
      if (this.spotify && this.spotify.isAuthenticated) {
        try {
          await this.spotify.next();
          this.onPlaybackCommand();
        } catch (error) { console.error(error); }
      } else {
        alert('Connect Spotify in Settings before starting playback.');
      }
    });

    // Time update events
    this.audio.onTimeUpdate((current, duration) => {
      // Only update timeline from HTML5 audio if Spotify Connect is NOT currently playing
      if (this.spotify && this.spotify.isAuthenticated) {
        return;
      }
      this.currentTimeLabel.textContent = this.formatTime(current);
      if (duration) {
        this.totalTimeLabel.textContent = this.formatTime(duration);
        const pct = (current / duration) * 100;
        this.timelineFill.style.width = `${pct}%`;
        this.timelineThumb.style.left = `${pct}%`;

        // Update home view progress bar (simulate session progress)
        if (this.sessionTimerFill) {
          this.sessionTimerFill.style.width = `${Math.min(pct * 1.5, 100)}%`;
        }
      }
    });

    // Slider interactions
    this.setupVolumeSlider();
    this.setupTimelineScrubbing();
  }

  setupVolumeSlider() {
    let pendingPct = 1;
    this.isVolumeDragging = false;

    const updateVolumeVisuals = pct => {
      pendingPct = Math.max(0, Math.min(1, pct));
      this.volumeFill.style.width = `${pendingPct * 100}%`;
      this.volumeThumb.style.left = `${pendingPct * 100}%`;
      this.volumeSlider.setAttribute('aria-valuenow', String(Math.round(pendingPct * 100)));
    };
    this.updateVolumeVisuals = updateVolumeVisuals;
    updateVolumeVisuals(1);

    const setVolumeFromEvent = e => {
      const rect = this.volumeSlider.getBoundingClientRect();
      let pct = (e.clientX - rect.left) / rect.width;
      updateVolumeVisuals(pct);
    };

    const commitVolume = async () => {
      if (this.spotify && this.spotify.isAuthenticated) {
        try {
          await this.spotify.setVolume(Math.round(pendingPct * 100));
        } catch (error) {
          console.error('Could not set Spotify volume:', error);
        }
      } else {
        this.audio.setVolume(pendingPct);
      }
    };

    this.volumeSlider.addEventListener('pointerdown', event => {
      this.isVolumeDragging = true;
      this.volumeSlider.setPointerCapture(event.pointerId);
      setVolumeFromEvent(event);
    });
    this.volumeSlider.addEventListener('pointermove', event => {
      if (this.isVolumeDragging) setVolumeFromEvent(event);
    });
    this.volumeSlider.addEventListener('pointerup', event => {
      if (!this.isVolumeDragging) return;
      this.isVolumeDragging = false;
      this.volumeSlider.releasePointerCapture(event.pointerId);
      commitVolume();
    });
    this.volumeSlider.addEventListener('pointercancel', () => {
      this.isVolumeDragging = false;
    });

    this.volumeSlider.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = Number(this.volumeSlider.getAttribute('aria-valuenow')) || 0;
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? 100
          : current + (['ArrowRight', 'ArrowUp'].includes(event.key) ? 5 : -5);
      updateVolumeVisuals(Math.max(0, Math.min(100, next)) / 100);
      commitVolume();
    });
  }

  setupTimelineScrubbing() {
    let isDragging = false;
    let dragPct = 0;

    const updateVisuals = (pct) => {
      this.timelineFill.style.width = `${pct * 100}%`;
      this.timelineThumb.style.left = `${pct * 100}%`;

      // Update current time label text immediately while scrubbing
      const totalMs = window.currentSpotifyDuration || 0;
      const targetSec = Math.floor((pct * totalMs) / 1000);
      this.currentTimeLabel.textContent = this.formatTime(targetSec);
      this.timelineSlider.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
    };

    this.timelineSlider.addEventListener('pointerdown', (e) => {
      isDragging = true;
      window.isScrubbingTimeline = true;
      this.timelineSlider.setPointerCapture(e.pointerId);
      const rect = this.timelineSlider.getBoundingClientRect();
      dragPct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      updateVisuals(dragPct);
    });

    this.timelineSlider.addEventListener('pointermove', (e) => {
      if (isDragging) {
        const rect = this.timelineSlider.getBoundingClientRect();
        dragPct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        updateVisuals(dragPct);
      }
    });

    this.timelineSlider.addEventListener('pointerup', async event => {
      if (isDragging) {
        isDragging = false;
        this.timelineSlider.releasePointerCapture(event.pointerId);

        if (this.spotify && this.spotify.isAuthenticated) {
          const totalMs = window.currentSpotifyDuration || 0;
          const targetMs = Math.round(dragPct * totalMs);

          // Instantly lock visual state to avoid sync jumpback
          window.currentSpotifyPosition = targetMs;
          updateVisuals(dragPct);

          try {
            await this.spotify.seek(targetMs);
            this.onSeekCommand();
          } catch (err) {
            console.error(err);
          }

          // Wait 1.2 seconds before resuming ticks to let the Spotify API catch up
          setTimeout(() => {
            window.isScrubbingTimeline = false;
          }, 1200);
        } else {
          const dur = this.audio.audio.duration || 0;
          this.audio.audio.currentTime = dragPct * dur;
          window.isScrubbingTimeline = false;
        }
      }
    });
    this.timelineSlider.addEventListener('pointercancel', () => {
      isDragging = false;
      window.isScrubbingTimeline = false;
    });

    this.timelineSlider.addEventListener('keydown', async event => {
      if (!['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = Number(this.timelineSlider.getAttribute('aria-valuenow')) || 0;
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? 100
          : current + (['ArrowRight', 'ArrowUp'].includes(event.key) ? 5 : -5);
      const pct = Math.max(0, Math.min(100, next)) / 100;
      window.isScrubbingTimeline = true;
      updateVisuals(pct);
      if (this.spotify?.isAuthenticated) {
        window.currentSpotifyPosition = Math.round(pct * (window.currentSpotifyDuration || 0));
        try {
          await this.spotify.seek(window.currentSpotifyPosition);
          this.onSeekCommand();
        } catch (error) { console.error(error); }
      }
      setTimeout(() => { window.isScrubbingTimeline = false; }, 1200);
    });
  }

  updateVolumeUI(volumePercent) {
    if (this.isVolumeDragging || typeof this.updateVolumeVisuals !== 'function') return;
    this.updateVolumeVisuals(Math.max(0, Math.min(100, Number(volumePercent) || 0)) / 100);
  }

  updatePlayPauseButtonUI(isPlaying) {
    if (this.playBtn.disabled) return;
    if (isPlaying) {
      this.playBtn.textContent = 'PAUSE';
      this.playBtn.title = 'Pause';
      this.playBtn.setAttribute('aria-label', 'Pause');
      this.playBtn.classList.add('filled');
    } else {
      this.playBtn.textContent = 'PLAY';
      this.playBtn.title = 'Play';
      this.playBtn.setAttribute('aria-label', 'Play');
      this.playBtn.classList.remove('filled');
    }
  }

  setPlaybackCapability(capability) {
    const mode = capability?.mode || 'disconnected';
    const ready = Boolean(capability?.canPlayLocally);
    const external = mode === 'external';
    [this.playBtn, this.prevBtn, this.nextBtn].forEach(button => {
      button.disabled = !ready;
    });
    [this.timelineSlider, this.volumeSlider].forEach(slider => {
      slider.setAttribute('aria-disabled', String(!ready));
      slider.tabIndex = ready ? 0 : -1;
    });
    document.querySelector('.player-bar')?.classList.toggle('is-external', external);
    if (ready) {
      this.updatePlayPauseButtonUI(false);
    } else {
      this.playBtn.classList.remove('filled');
      this.playBtn.textContent = external ? 'SPOTIFY' : mode === 'starting' || mode === 'authorizing' ? 'WAIT' : 'PLAY';
      this.playBtn.title = external ? 'Playback controls are in Spotify' : 'Local player unavailable';
      this.playBtn.setAttribute('aria-label', this.playBtn.title);
    }
  }

  formatTime(secs) {
    const mins = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${mins}:${s.toString().padStart(2, '0')}`;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = UIManager;
} else {
  window.UIManager = UIManager;
}
