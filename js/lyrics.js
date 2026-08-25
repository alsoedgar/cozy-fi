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
    const source = ['lrclib', 'local'].includes(record.source) ? record.source : 'lrclib';
    const matchType = ['exact', 'expanded', 'local'].includes(record.matchType) ? record.matchType : 'exact';
    const matchScore = Number(record.matchScore);
    return {
      id: Number.isSafeInteger(Number(record.id)) ? Number(record.id) : null,
      trackName: normalizeMetadata(record.trackName || record.name),
      artistName: normalizeMetadata(record.artistName),
      albumName: normalizeMetadata(record.albumName),
      duration: Number.isFinite(Number(record.duration)) ? Number(record.duration) : null,
      instrumental: Boolean(record.instrumental),
      plainLyrics: limitLyricsText(record.plainLyrics),
      syncedLyrics: limitLyricsText(record.syncedLyrics),
      source,
      matchType,
      matchScore: Number.isFinite(matchScore) ? Math.max(0, Math.min(1, matchScore)) : null
    };
  }

  function comparableMetadata(value) {
    const normalized = normalizeMetadata(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    const comparable = normalized
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    return comparable || normalized.toLowerCase();
  }

  const TITLE_QUALIFIER_WORDS = '(?:feat(?:uring)?|ft|with|remaster(?:ed)?|re[-\\s]?record(?:ed)?|version|edit|mix|remix|live|acoustic|instrumental|radio|mono|stereo|demo|session|karaoke|club|extended|sped\\s*up|slowed(?:\\s*down)?|deluxe|bonus|explicit|clean|soundtrack|original\\s+motion\\s+picture|from(?:\\s+.+)?)';

  function simplifyTrackTitle(value) {
    let title = normalizeMetadata(value);
    if (!title) return '';
    const bracketedQualifier = new RegExp(`\\s*[\\(\\[\\{][^\\)\\]\\}]*\\b${TITLE_QUALIFIER_WORDS}\\b[^\\)\\]\\}]*[\\)\\]\\}]`, 'gi');
    const suffixQualifier = new RegExp(`\\s*[-–—:]\\s*(?:\\d{4}\\s+)?${TITLE_QUALIFIER_WORDS}\\b.*$`, 'i');
    title = title.replace(bracketedQualifier, ' ').replace(suffixQualifier, ' ').replace(/\s+/g, ' ').trim();
    return title || normalizeMetadata(value);
  }

  function primaryArtistName(value) {
    const artist = normalizeMetadata(value);
    if (!artist) return '';
    const primary = artist.split(/\s*(?:,|;|\bfeat(?:uring)?\.?\b|\bft\.?\b|\bwith\b)\s*/i)[0];
    return primary.trim() || artist;
  }

  function uniqueComparableVariants(value, simplifier) {
    const variants = [normalizeMetadata(value)];
    const simplified = simplifier?.(value);
    if (simplified) variants.push(simplified);
    return [...new Set(variants.map(comparableMetadata).filter(Boolean))];
  }

  function diceCoefficient(leftValue, rightValue) {
    const left = comparableMetadata(leftValue);
    const right = comparableMetadata(rightValue);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.length < 2 || right.length < 2) return 0;
    const pairs = new Map();
    for (let index = 0; index < left.length - 1; index += 1) {
      const pair = left.slice(index, index + 2);
      pairs.set(pair, (pairs.get(pair) || 0) + 1);
    }
    let intersection = 0;
    for (let index = 0; index < right.length - 1; index += 1) {
      const pair = right.slice(index, index + 2);
      const count = pairs.get(pair) || 0;
      if (count > 0) {
        intersection += 1;
        pairs.set(pair, count - 1);
      }
    }
    return (2 * intersection) / ((left.length - 1) + (right.length - 1));
  }

  function tokenCoefficient(leftValue, rightValue) {
    const left = new Set(comparableMetadata(leftValue).split(' ').filter(Boolean));
    const right = new Set(comparableMetadata(rightValue).split(' ').filter(Boolean));
    if (left.size === 0 || right.size === 0) return 0;
    let intersection = 0;
    for (const token of left) if (right.has(token)) intersection += 1;
    return (2 * intersection) / (left.size + right.size);
  }

  function metadataSimilarity(leftValue, rightValue) {
    if (!normalizeMetadata(leftValue) || !normalizeMetadata(rightValue)) return 0;
    return Math.max(diceCoefficient(leftValue, rightValue), tokenCoefficient(leftValue, rightValue));
  }

  function bestVariantSimilarity(leftVariants, rightVariants) {
    let best = 0;
    for (const left of leftVariants) {
      for (const right of rightVariants) best = Math.max(best, metadataSimilarity(left, right));
    }
    return best;
  }

  function buildLyricsSearchQueries(rawLookup) {
    const lookup = rawLookup?.cacheKey ? rawLookup : normalizeLyricsLookup(rawLookup);
    const simplifiedTitle = simplifyTrackTitle(lookup.trackName);
    const primaryArtist = primaryArtistName(lookup.artistName);
    return [
      { trackName: lookup.trackName, artistName: lookup.artistName },
      { q: `${simplifiedTitle || lookup.trackName} ${primaryArtist || lookup.artistName}` }
    ];
  }

  function scoreLyricsCandidate(rawLookup, rawCandidate) {
    const lookup = rawLookup?.cacheKey ? rawLookup : normalizeLyricsLookup(rawLookup);
    const record = sanitizeLyricsRecord(rawCandidate);
    if (!record.trackName || !record.artistName || (!record.instrumental && !record.plainLyrics && !record.syncedLyrics)) {
      return null;
    }

    const titleScore = bestVariantSimilarity(
      uniqueComparableVariants(lookup.trackName, simplifyTrackTitle),
      uniqueComparableVariants(record.trackName, simplifyTrackTitle)
    );
    const artistScore = bestVariantSimilarity(
      uniqueComparableVariants(lookup.artistName, primaryArtistName),
      uniqueComparableVariants(record.artistName, primaryArtistName)
    );
    if (titleScore < 0.68 || artistScore < 0.55) return null;

    let durationScore = 0.45;
    if (lookup.durationSeconds && record.duration) {
      const difference = Math.abs(lookup.durationSeconds - record.duration);
      durationScore = difference <= 2 ? 1 : difference <= 8 ? 0.84 : difference <= 20 ? 0.52 : difference <= 45 ? 0.2 : 0;
    }
    const albumScore = lookup.albumName && record.albumName
      ? metadataSimilarity(lookup.albumName, record.albumName)
      : 0.45;
    const qualityBonus = record.syncedLyrics ? 0.025 : record.plainLyrics ? 0.01 : 0.005;
    const score = Math.min(1, (titleScore * 0.58) + (artistScore * 0.28) + (durationScore * 0.1) + (albumScore * 0.04) + qualityBonus);
    if (score < 0.7) return null;
    return { record, score, titleScore, artistScore, durationScore, albumScore };
  }

  function selectBestLyricsCandidate(rawLookup, rawCandidates) {
    const candidates = Array.isArray(rawCandidates) ? rawCandidates : [];
    let best = null;
    for (const candidate of candidates) {
      const scored = scoreLyricsCandidate(rawLookup, candidate);
      if (!scored) continue;
      if (!best || scored.score > best.score ||
          (scored.score === best.score && scored.record.syncedLyrics && !best.record.syncedLyrics)) {
        best = scored;
      }
    }
    return best;
  }

  function finalizeLyricsMatch(rawLookup, scoredCandidate, matchType = 'expanded') {
    if (!scoredCandidate?.record) return null;
    const lookup = rawLookup?.cacheKey ? rawLookup : normalizeLyricsLookup(rawLookup);
    const record = sanitizeLyricsRecord(scoredCandidate.record);
    if (record.syncedLyrics && lookup.durationSeconds && record.duration) {
      const safeTimingDifference = Math.max(8, lookup.durationSeconds * 0.04);
      if (Math.abs(lookup.durationSeconds - record.duration) > safeTimingDifference) {
        if (!record.plainLyrics) {
          record.plainLyrics = parseSyncedLyrics(record.syncedLyrics).map(line => line.text).join('\n').trim();
        }
        record.syncedLyrics = '';
      }
    }
    return {
      found: true,
      ...record,
      source: 'lrclib',
      matchType: matchType === 'exact' ? 'exact' : 'expanded',
      matchScore: Math.round(Math.max(0, Math.min(1, Number(scoredCandidate.score) || 0)) * 1000) / 1000
    };
  }

  function createImportedLyricsRecord(rawTrack, rawText, fileName = '') {
    const lookup = normalizeLyricsLookup(rawTrack);
    const lyrics = limitLyricsText(rawText);
    if (!lyrics) throw new Error('The selected lyrics file is empty.');
    const syncedLines = parseSyncedLyrics(lyrics);
    const expectsSyncedLyrics = /\.lrc$/i.test(normalizeMetadata(fileName));
    if (expectsSyncedLyrics && syncedLines.length === 0) {
      throw new Error('This .lrc file does not contain readable timestamps.');
    }
    const syncedLyrics = syncedLines.length > 0 ? lyrics : '';
    const plainLyrics = syncedLines.length > 0
      ? syncedLines.map(line => line.text).join('\n').trim()
      : lyrics;
    return {
      found: true,
      ...sanitizeLyricsRecord({
        trackName: lookup.trackName,
        artistName: lookup.artistName,
        albumName: lookup.albumName,
        duration: lookup.durationSeconds,
        plainLyrics,
        syncedLyrics,
        source: 'local',
        matchType: 'local',
        matchScore: 1
      })
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

  function formatLyricTime(rawMilliseconds) {
    const totalSeconds = Math.max(0, Math.floor((Number(rawMilliseconds) || 0) / 1000));
    return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
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
      this.importBusy = false;
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
      this.elements.importButton?.addEventListener('click', () => this.importLocal());
      this.bridge?.onLocalUpdate?.(payload => {
        if (!payload?.cacheKey || payload.cacheKey !== this.currentTrackKey) return;
        this.requestGeneration += 1;
        this.loadingTrackKey = '';
        this.model = null;
        this.activeLineIndex = -2;
        this.lineElements = [];
        if (this.panel === 'lyrics' && this.options.isPlayerViewVisible?.() !== false) this.load();
        else this.renderPrompt();
      });
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
      this.options.onPanelChange?.(this.panel);
      if (focus) (lyricsActive ? this.elements.lyricsTab : this.elements.artworkTab)?.focus();
      if (lyricsActive && !this.model) this.load();
    }

    setTrack(track) {
      const nextKey = trackKey(track);
      this.track = track && nextKey ? { ...track } : null;
      if (nextKey === this.currentTrackKey) return;
      this.currentTrackKey = nextKey;
      this.requestGeneration += 1;
      this.loadingTrackKey = '';
      this.model = null;
      this.activeLineIndex = -2;
      this.lineElements = [];
      this.autoFollow = true;
      if (this.elements.followButton) this.elements.followButton.hidden = true;
      this.updateHeading();
      this.updateImportButton();
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

    updateImportButton() {
      const button = this.elements.importButton;
      if (!button) return;
      const available = Boolean(this.track && this.track.spotifyType !== 'episode' && this.bridge?.importLocal);
      button.hidden = !available;
      button.disabled = this.importBusy;
      const usingLocal = this.model?.record?.source === 'local';
      button.textContent = usingLocal
        ? (this.options.replaceLocalLabel || 'REPLACE LOCAL')
        : (this.options.importLocalLabel || 'ADD LOCAL');
      button.title = usingLocal
        ? 'Replace these local lyrics or return to LRCLIB'
        : 'Use a local .lrc or .txt file for this song';
    }

    renderPrompt() {
      this.updateHeading();
      this.setBadge(this.track ? 'OPTIONAL' : 'WAITING', 'idle');
      if (this.elements.modeLabel) {
        this.elements.modeLabel.textContent = this.options.promptModeLabel || 'LRCLIB · OPTIONAL LOOKUP';
      }
      this.updateImportButton();
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
      if (this.elements.modeLabel) this.elements.modeLabel.textContent = 'SEARCHING LRCLIB · EXACT + ALTERNATES';
      this.updateImportButton();
    }

    showMessage(title, description, retry) {
      this.elements.scroller.hidden = true;
      this.elements.scroller.removeAttribute('aria-busy');
      this.elements.message.hidden = false;
      this.elements.messageTitle.textContent = title;
      this.elements.messageDescription.textContent = description;
      this.elements.retryButton.hidden = !retry;
      if (this.elements.followButton) this.elements.followButton.hidden = true;
      this.updateImportButton();
    }

    trackLookupPayload() {
      return {
        title: this.track?.title,
        artist: this.track?.artist,
        album: this.track?.album,
        durationMs: this.track?.durationMs
      };
    }

    async importLocal() {
      if (!this.track || !this.bridge?.importLocal || this.importBusy) return;
      this.importBusy = true;
      this.loadingTrackKey = '';
      this.updateImportButton();
      const generation = ++this.requestGeneration;
      const requestedKey = this.currentTrackKey;
      try {
        const payload = await this.bridge.importLocal(this.trackLookupPayload());
        if (generation !== this.requestGeneration || requestedKey !== this.currentTrackKey || payload?.canceled) return;
        if (payload?.removed) {
          this.model = null;
          await this.load();
          return;
        }
        this.model = buildLyricsModel(payload);
        this.renderModel();
      } catch (error) {
        if (generation !== this.requestGeneration || requestedKey !== this.currentTrackKey) return;
        this.setBadge('TRY AGAIN', 'error');
        this.showMessage('Local lyrics could not be added.', error?.message || 'Choose a valid .lrc or .txt file and try again.', false);
        if (this.elements.modeLabel) this.elements.modeLabel.textContent = 'LOCAL LYRICS IMPORT INTERRUPTED';
      } finally {
        this.importBusy = false;
        this.updateImportButton();
      }
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
        const payload = await this.bridge.get(this.trackLookupPayload(), { force });
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
      const prefix = this.model?.record?.source === 'local'
        ? 'LOCAL LRC'
        : this.model?.record?.matchType === 'expanded' ? 'LRCLIB BROAD MATCH' : 'SYNCED';
      const seekHint = typeof this.options.onSeek === 'function' && canSync ? ' · SELECT A LINE TO JUMP' : '';
      if (!canSync) {
        this.elements.modeLabel.textContent = `${prefix} · MANUAL SCROLL IN SPOTIFY APP MODE`;
      } else if (this.autoFollow) {
        this.elements.modeLabel.textContent = `${prefix} · FOLLOWING PLAYBACK${seekHint}`;
      } else {
        this.elements.modeLabel.textContent = `${prefix} · MANUAL SCROLL · SELECT FOLLOW${seekHint}`;
      }
    }

    renderModel() {
      this.updateHeading();
      this.elements.scroller.removeAttribute('aria-busy');
      this.elements.scroller.innerHTML = '';
      this.lineElements = [];
      this.activeLineIndex = -2;
      this.updateImportButton();
      if (this.model.kind === 'synced') {
        this.setBadge('SYNCED', 'synced');
        this.updateModeLabel(Boolean(this.options.canSync?.()));
        this.renderSyncedLines();
        this.updatePosition(this.options.getPosition?.() || 0, Boolean(this.options.canSync?.()));
        return;
      }
      if (this.model.kind === 'plain') {
        this.setBadge('SCROLL', 'plain');
        if (this.elements.modeLabel) {
          const prefix = this.model.record?.source === 'local'
            ? 'LOCAL FILE'
            : this.model.record?.matchType === 'expanded' ? 'LRCLIB BROAD MATCH' : 'UNSYNCED';
          this.elements.modeLabel.textContent = `${prefix} · SCROLLABLE LYRICS`;
        }
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
      if (this.elements.modeLabel) this.elements.modeLabel.textContent = 'NO EXACT OR ALTERNATE LRCLIB MATCH';
      this.showMessage(
        'No lyrics found for this song.',
        'Cozy-Fi tried exact and alternate matches. Add a local .lrc or .txt file, or retry later for a newly released song.',
        true
      );
    }

    renderSyncedLines() {
      this.elements.message.hidden = true;
      this.elements.scroller.hidden = false;
      const fragment = document.createDocumentFragment();
      this.model.lines.forEach(line => {
        const seekable = !line.isGap && typeof this.options.onSeek === 'function';
        const row = document.createElement(seekable ? 'button' : 'div');
        row.className = `lyrics-line${line.isGap ? ' is-gap' : ''}${seekable ? ' is-seekable' : ''}`;
        row.dataset.timeMs = String(line.timeMs);
        if (seekable) {
          const timestamp = formatLyricTime(line.timeMs);
          row.type = 'button';
          row.disabled = !this.options.canSeek?.();
          row.setAttribute('aria-label', `Jump to ${timestamp}: ${line.text || 'music'}`);
          row.title = row.disabled ? 'Seeking is available during standalone playback' : `Jump to ${timestamp}`;
          row.addEventListener('click', async () => {
            if (!this.options.canSeek?.()) return;
            this.autoFollow = true;
            if (this.elements.followButton) this.elements.followButton.hidden = true;
            this.updatePosition(line.timeMs, Boolean(this.options.canSync?.()));
            this.centerActiveLine('smooth');
            row.classList.add('is-seeking');
            try {
              await this.options.onSeek(line.timeMs);
            } finally {
              row.classList.remove('is-seeking');
            }
          });
        }
        const marker = document.createElement('span');
        marker.className = 'lyrics-now-marker';
        marker.textContent = seekable ? formatLyricTime(line.timeMs) : 'NOW';
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
      const canSeek = Boolean(this.options.canSeek?.());
      this.lineElements.forEach(line => {
        if (line.tagName !== 'BUTTON') return;
        line.disabled = !canSeek;
        line.title = canSeek
          ? `Jump to ${formatLyricTime(line.dataset.timeMs)}`
          : 'Seeking is available during standalone playback';
      });
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
    simplifyTrackTitle,
    primaryArtistName,
    buildLyricsSearchQueries,
    scoreLyricsCandidate,
    selectBestLyricsCandidate,
    finalizeLyricsMatch,
    createImportedLyricsRecord,
    parseSyncedLyrics,
    parsePlainLyrics,
    findActiveLineIndex,
    buildLyricsModel,
    LyricsController
  };
});
