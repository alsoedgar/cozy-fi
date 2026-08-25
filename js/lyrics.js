(function exposeLyrics(globalScope, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.CozyLyrics = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const MAX_METADATA_LENGTH = 300;
  const MAX_LYRICS_LENGTH = 200000;
  const MAX_LYRIC_LINES = 2000;
  const MAX_LYRIC_LINE_LENGTH = 2000;

  function normalizeMetadata(value, maximum = MAX_METADATA_LENGTH) {
    return typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum)
      : '';
  }

  function normalizeLyricsLookup(rawTrack) {
    const track = rawTrack && typeof rawTrack === 'object' ? rawTrack : {};
    const trackName = normalizeMetadata(track.trackName || track.title);
    const artistName = normalizeMetadata(track.artistName || track.artist);
    const albumName = normalizeMetadata(track.albumName || track.album);
    if (!trackName || !artistName) throw new Error('A song title and artist are required to find lyrics.');

    const durationMs = Number(track.durationMs);
    const durationSeconds = Number.isFinite(durationMs) && durationMs >= 1000 && durationMs <= 3600000
      ? Math.round(durationMs / 1000)
      : null;
    const cacheKey = [trackName, artistName, albumName, durationSeconds || ''].map(value => String(value).toLowerCase()).join('\u001f');
    return { trackName, artistName, albumName, durationSeconds, cacheKey };
  }

  function limitLyricsText(value) {
    return typeof value === 'string'
      ? value
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .trim()
        .slice(0, MAX_LYRICS_LENGTH)
      : '';
  }

  function sanitizeLyricsRecord(rawRecord) {
    const record = rawRecord && typeof rawRecord === 'object' ? rawRecord : {};
    return {
      id: Number.isSafeInteger(Number(record.id)) ? Number(record.id) : null,
      trackName: normalizeMetadata(record.trackName || record.name),
      artistName: normalizeMetadata(record.artistName),
      albumName: normalizeMetadata(record.albumName),
      duration: Number.isFinite(Number(record.duration)) ? Number(record.duration) : null,
      instrumental: Boolean(record.instrumental),
      plainLyrics: limitLyricsText(record.plainLyrics),
      syncedLyrics: limitLyricsText(record.syncedLyrics)
    };
  }

  function fractionToMilliseconds(rawFraction = '') {
    const fraction = String(rawFraction);
    if (!fraction) return 0;
    if (fraction.length === 1) return Number(fraction) * 100;
    if (fraction.length === 2) return Number(fraction) * 10;
    return Number(fraction.slice(0, 3));
  }

  function parseSyncedLyrics(rawLyrics) {
    const lyrics = limitLyricsText(rawLyrics);
    if (!lyrics) return [];
    const parsed = [];
    const timestampPattern = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    const enhancedTimestampPattern = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g;
    const offsetMatch = lyrics.match(/^\s*\[offset:([+-]?\d{1,7})\]\s*$/im);
    const offsetMs = Math.max(-60000, Math.min(60000, Number(offsetMatch?.[1]) || 0));

    for (const rawLine of lyrics.split('\n')) {
      if (parsed.length >= MAX_LYRIC_LINES) break;
      const matches = Array.from(rawLine.matchAll(timestampPattern));
      if (matches.length === 0) continue;
      const text = rawLine
        .replace(timestampPattern, '')
        .replace(enhancedTimestampPattern, '')
        .trim()
        .slice(0, MAX_LYRIC_LINE_LENGTH);
      for (const match of matches) {
        if (parsed.length >= MAX_LYRIC_LINES) break;
        const minutes = Number(match[1]);
        const seconds = Number(match[2]);
        if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds > 59) continue;
        parsed.push({
          timeMs: Math.max(0, (minutes * 60 * 1000) + (seconds * 1000) + fractionToMilliseconds(match[3]) + offsetMs),
          text,
          isGap: !text
        });
      }
    }

    parsed.sort((left, right) => left.timeMs - right.timeMs);
    return parsed.filter((line, index) => (
      index === 0 || line.timeMs !== parsed[index - 1].timeMs || line.text !== parsed[index - 1].text
    ));
  }

  function parsePlainLyrics(rawLyrics) {
    const lyrics = limitLyricsText(rawLyrics);
    if (!lyrics) return [];
    return lyrics
      .split('\n')
      .slice(0, MAX_LYRIC_LINES)
      .map(line => line.trim().slice(0, MAX_LYRIC_LINE_LENGTH));
  }

  function findActiveLineIndex(lines, rawPositionMs) {
    if (!Array.isArray(lines) || lines.length === 0) return -1;
    const positionMs = Math.max(0, Number(rawPositionMs) || 0);
    let low = 0;
    let high = lines.length - 1;
    let match = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (Number(lines[middle]?.timeMs) <= positionMs) {
        match = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return match;
  }

  function buildLyricsModel(payload) {
    if (!payload?.found) {
      return {
        kind: payload?.status === 'rate_limited' ? 'rate_limited' : 'unavailable',
        retryAfter: Math.max(0, Number(payload?.retryAfter) || 0),
        lines: []
      };
    }
    const record = sanitizeLyricsRecord(payload);
    if (record.instrumental) return { kind: 'instrumental', record, lines: [] };
    const syncedLines = parseSyncedLyrics(record.syncedLyrics);
    if (syncedLines.length > 0) return { kind: 'synced', record, lines: syncedLines };
    const plainLines = parsePlainLyrics(record.plainLyrics);
    if (plainLines.length > 0) return { kind: 'plain', record, lines: plainLines };
    return { kind: 'unavailable', record, lines: [] };
  }

  function trackKey(track) {
    if (!track || typeof track !== 'object') return '';
    try {
      return normalizeLyricsLookup(track).cacheKey;
    } catch {
      return '';
    }
  }

  class LyricsController {
    constructor(bridge, elements, options = {}) {
      this.bridge = bridge;
      this.elements = elements;
      this.options = options;
      this.track = null;
      this.currentTrackKey = '';
      this.panel = 'artwork';
      this.model = null;
      this.activeLineIndex = -2;
      this.requestGeneration = 0;
      this.loadingTrackKey = '';
      this.autoFollow = true;
      this.lineElements = [];
      this.initialize();
    }

    initialize() {
      const tabs = [this.elements.artworkTab, this.elements.lyricsTab].filter(Boolean);
      this.elements.artworkTab?.addEventListener('click', () => this.activate('artwork'));
      this.elements.lyricsTab?.addEventListener('click', () => this.activate('lyrics'));
      tabs.forEach((tab, index) => {
        tab.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const nextIndex = event.key === 'Home' ? 0
            : event.key === 'End' ? tabs.length - 1
              : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          tabs[nextIndex].focus();
          tabs[nextIndex].click();
        });
      });
      const pauseFollow = event => {
        if (event.type === 'keydown' && !['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) return;
        if (this.model?.kind !== 'synced' || !this.options.canSync?.()) return;
        this.autoFollow = false;
        if (this.elements.followButton) this.elements.followButton.hidden = false;
        this.updateModeLabel(true);
      };
      this.elements.scroller?.addEventListener('wheel', pauseFollow, { passive: true });
      this.elements.scroller?.addEventListener('touchstart', pauseFollow, { passive: true });
      this.elements.scroller?.addEventListener('keydown', pauseFollow);
      this.elements.followButton?.addEventListener('click', () => {
        this.autoFollow = true;
        this.elements.followButton.hidden = true;
        this.updateModeLabel(Boolean(this.options.canSync?.()));
        this.centerActiveLine('smooth');
      });
      this.elements.retryButton?.addEventListener('click', () => this.load(true));
      this.activate('artwork', false);
      this.renderPrompt();
    }

    activate(panel, focus = true) {
      this.panel = panel === 'lyrics' ? 'lyrics' : 'artwork';
      const lyricsActive = this.panel === 'lyrics';
      this.elements.artworkTab?.setAttribute('aria-selected', String(!lyricsActive));
      this.elements.lyricsTab?.setAttribute('aria-selected', String(lyricsActive));
      if (this.elements.artworkTab) this.elements.artworkTab.tabIndex = lyricsActive ? -1 : 0;
      if (this.elements.lyricsTab) this.elements.lyricsTab.tabIndex = lyricsActive ? 0 : -1;
      if (this.elements.artworkPanel) this.elements.artworkPanel.hidden = lyricsActive;
      if (this.elements.lyricsPanel) this.elements.lyricsPanel.hidden = !lyricsActive;
      if (focus) (lyricsActive ? this.elements.lyricsTab : this.elements.artworkTab)?.focus();
      if (lyricsActive && !this.model) this.load();
    }

    setTrack(track) {
      const nextKey = trackKey(track);
      this.track = track && nextKey ? { ...track } : null;
      if (nextKey === this.currentTrackKey) return;
      this.currentTrackKey = nextKey;
      this.requestGeneration += 1;
      this.model = null;
      this.activeLineIndex = -2;
      this.lineElements = [];
      this.autoFollow = true;
      if (this.elements.followButton) this.elements.followButton.hidden = true;
      this.updateHeading();
      if (this.panel === 'lyrics' && this.options.isPlayerViewVisible?.() !== false) this.load();
      else this.renderPrompt();
    }

    onPlayerViewVisible() {
      if (this.panel === 'lyrics' && !this.model) this.load();
    }

    updateHeading() {
      if (this.elements.trackTitle) this.elements.trackTitle.textContent = this.track?.title || 'Lyrics';
      if (this.elements.trackArtist) this.elements.trackArtist.textContent = this.track?.artist || 'Select a song to begin';
    }

    setBadge(label, state = '') {
      if (!this.elements.badge) return;
      this.elements.badge.textContent = label;
      this.elements.badge.dataset.state = state;
    }

    renderPrompt() {
      this.updateHeading();
      this.setBadge(this.track ? 'OPTIONAL' : 'WAITING', 'idle');
      if (this.elements.modeLabel) {
        this.elements.modeLabel.textContent = this.options.promptModeLabel || 'LRCLIB · OPTIONAL LOOKUP';
      }
      this.showMessage(
        this.track ? 'Lyrics are ready when you are.' : 'Choose a song first.',
        this.track
          ? 'Open the Lyrics tab to make a one-time keyless lookup through LRCLIB.'
          : 'Play a Spotify track, then return here for available lyrics.',
        false
      );
    }

    renderLoading() {
      this.updateHeading();
      this.setBadge('LOOKING UP', 'loading');
      this.elements.message.hidden = true;
      this.elements.scroller.hidden = false;
      this.elements.scroller.setAttribute('aria-busy', 'true');
      this.elements.scroller.innerHTML = '';
      [78, 60, 88, 52, 72, 64, 84].forEach(width => {
        const line = document.createElement('div');
        line.className = 'skeleton lyrics-skeleton-line';
        line.style.width = `${width}%`;
        line.setAttribute('aria-hidden', 'true');
        this.elements.scroller.appendChild(line);
      });
      if (this.elements.modeLabel) this.elements.modeLabel.textContent = 'CONTACTING LRCLIB · NO API KEY';
    }

    showMessage(title, description, retry) {
      this.elements.scroller.hidden = true;
      this.elements.scroller.removeAttribute('aria-busy');
      this.elements.message.hidden = false;
      this.elements.messageTitle.textContent = title;
      this.elements.messageDescription.textContent = description;
      this.elements.retryButton.hidden = !retry;
      if (this.elements.followButton) this.elements.followButton.hidden = true;
    }

    async load(force = false) {
      if (this.panel !== 'lyrics') return;
      if (!this.track) {
        this.renderPrompt();
        return;
      }
      if (this.track.spotifyType === 'episode') {
        this.model = { kind: 'unavailable', lines: [] };
        this.setBadge('NOT AVAILABLE', 'empty');
        this.showMessage('Song lyrics only for now.', 'LRCLIB matching is enabled for music tracks, not podcast episodes.', false);
        return;
      }
      if (!this.bridge?.get) {
        this.setBadge('UNAVAILABLE', 'error');
        this.showMessage('Lyrics service is unavailable.', 'This build does not include the LRCLIB bridge.', false);
        return;
      }
      if (this.loadingTrackKey === this.currentTrackKey) return;

      const generation = ++this.requestGeneration;
      const requestedKey = this.currentTrackKey;
      this.loadingTrackKey = requestedKey;
      this.renderLoading();
      try {
        const payload = await this.bridge.get({
          title: this.track.title,
          artist: this.track.artist,
          album: this.track.album,
          durationMs: this.track.durationMs
        }, { force });
        if (generation !== this.requestGeneration || requestedKey !== this.currentTrackKey) return;
        this.model = buildLyricsModel(payload);
        this.renderModel();
      } catch (error) {
        if (generation !== this.requestGeneration || requestedKey !== this.currentTrackKey) return;
        this.model = null;
        this.setBadge('TRY AGAIN', 'error');
        this.showMessage('Lyrics could not load.', error?.message || 'Check your connection and try again.', true);
        if (this.elements.modeLabel) this.elements.modeLabel.textContent = 'LRCLIB LOOKUP INTERRUPTED';
      } finally {
        if (generation === this.requestGeneration && requestedKey === this.currentTrackKey) {
          this.loadingTrackKey = '';
        }
      }
    }

    updateModeLabel(canSync = Boolean(this.options.canSync?.())) {
      if (!this.elements.modeLabel) return;
      if (!canSync) {
        this.elements.modeLabel.textContent = 'SYNCED · MANUAL SCROLL IN SPOTIFY APP MODE';
      } else if (this.autoFollow) {
        this.elements.modeLabel.textContent = 'SYNCED · FOLLOWING PLAYBACK';
      } else {
        this.elements.modeLabel.textContent = 'SYNCED · MANUAL SCROLL · SELECT FOLLOW';
      }
    }

    renderModel() {
      this.updateHeading();
      this.elements.scroller.removeAttribute('aria-busy');
      this.elements.scroller.innerHTML = '';
      this.lineElements = [];
      this.activeLineIndex = -2;
      if (this.model.kind === 'synced') {
        this.setBadge('SYNCED', 'synced');
        this.updateModeLabel(Boolean(this.options.canSync?.()));
        this.renderSyncedLines();
        this.updatePosition(this.options.getPosition?.() || 0, Boolean(this.options.canSync?.()));
        return;
      }
      if (this.model.kind === 'plain') {
        this.setBadge('SCROLL', 'plain');
        if (this.elements.modeLabel) this.elements.modeLabel.textContent = 'UNSYNCED · SCROLLABLE LYRICS';
        this.renderPlainLines();
        return;
      }
      if (this.model.kind === 'instrumental') {
        this.setBadge('INSTRUMENTAL', 'instrumental');
        if (this.elements.modeLabel) this.elements.modeLabel.textContent = 'LRCLIB · INSTRUMENTAL';
        this.showMessage('This one is instrumental.', 'LRCLIB marks this track as having no sung lyrics.', false);
        return;
      }
      if (this.model.kind === 'rate_limited') {
        const seconds = Math.max(1, Math.ceil(this.model.retryAfter || 1));
        this.setBadge('COOLING DOWN', 'error');
        if (this.elements.modeLabel) this.elements.modeLabel.textContent = 'LRCLIB RATE LIMIT';
        this.showMessage('Lyrics need a short coffee break.', `LRCLIB asked Cozy-Fi to wait about ${seconds} seconds before another lookup.`, true);
        return;
      }
      this.setBadge('NOT FOUND', 'empty');
      if (this.elements.modeLabel) this.elements.modeLabel.textContent = 'NO LRCLIB MATCH';
      this.showMessage('No lyrics found for this song.', 'The song may be instrumental, newly released, or not yet available in LRCLIB.', true);
    }

    renderSyncedLines() {
      this.elements.message.hidden = true;
      this.elements.scroller.hidden = false;
      const fragment = document.createDocumentFragment();
      this.model.lines.forEach(line => {
        const row = document.createElement('div');
        row.className = `lyrics-line${line.isGap ? ' is-gap' : ''}`;
        row.dataset.timeMs = String(line.timeMs);
        const marker = document.createElement('span');
        marker.className = 'lyrics-now-marker';
        marker.textContent = 'NOW';
        marker.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'lyrics-line-text';
        text.textContent = line.text || '♪';
        row.append(marker, text);
        fragment.appendChild(row);
        this.lineElements.push(row);
      });
      this.elements.scroller.appendChild(fragment);
    }

    renderPlainLines() {
      this.elements.message.hidden = true;
      this.elements.scroller.hidden = false;
      const container = document.createElement('div');
      container.className = 'plain-lyrics-lines';
      this.model.lines.forEach(line => {
        const row = document.createElement('div');
        row.className = `plain-lyrics-line${line ? '' : ' is-gap'}`;
        row.textContent = line || ' ';
        container.appendChild(row);
      });
      this.elements.scroller.appendChild(container);
    }

    updatePosition(positionMs, canSync = true) {
      if (this.model?.kind !== 'synced' || this.lineElements.length === 0) return;
      this.updateModeLabel(canSync);
      if (!canSync) {
        this.lineElements.forEach(line => line.classList.remove('is-active', 'is-past'));
        this.activeLineIndex = -2;
        if (this.elements.followButton) this.elements.followButton.hidden = true;
        return;
      }
      if (this.elements.followButton) this.elements.followButton.hidden = this.autoFollow;
      const nextIndex = findActiveLineIndex(this.model.lines, positionMs);
      if (nextIndex === this.activeLineIndex) return;
      this.activeLineIndex = nextIndex;
      this.lineElements.forEach((line, index) => {
        line.classList.toggle('is-active', index === nextIndex);
        line.classList.toggle('is-past', index < nextIndex);
        if (index === nextIndex) line.setAttribute('aria-current', 'true');
        else line.removeAttribute('aria-current');
      });
      if (this.autoFollow) this.centerActiveLine();
    }

    centerActiveLine(preferredBehavior) {
      const activeLine = this.lineElements[this.activeLineIndex];
      const scroller = this.elements.scroller;
      if (!activeLine || !scroller) return;
      const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const top = activeLine.offsetTop - (scroller.clientHeight / 2) + (activeLine.offsetHeight / 2);
      scroller.scrollTo({
        top: Math.max(0, top),
        behavior: reducedMotion ? 'auto' : (preferredBehavior || 'smooth')
      });
    }
  }

  return {
    MAX_LYRICS_LENGTH,
    MAX_LYRIC_LINES,
    normalizeLyricsLookup,
    sanitizeLyricsRecord,
    parseSyncedLyrics,
    parsePlainLyrics,
    findActiveLineIndex,
    buildLyricsModel,
    LyricsController
  };
});
