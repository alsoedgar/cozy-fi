// Compact Cozy-Fi side player. All Spotify calls stay in the sandboxed preload bridge.
document.addEventListener('DOMContentLoaded', () => {
  const api = window.cozyApi;
  const elements = {
    window: document.getElementById('mini-window'),
    titlebar: document.getElementById('mini-titlebar'),
    coverTab: document.getElementById('mini-cover-tab'),
    lyricsTab: document.getElementById('mini-lyrics-tab'),
    artFrame: document.getElementById('mini-art-frame'),
    lyricsPanel: document.getElementById('mini-lyrics-panel'),
    lyricsState: document.getElementById('mini-lyrics-state'),
    lyricsMode: document.getElementById('mini-lyrics-mode'),
    lyricsScroll: document.getElementById('mini-lyrics-scroll'),
    lyricsMessage: document.getElementById('mini-lyrics-message'),
    lyricsMessageTitle: document.getElementById('mini-lyrics-message-title'),
    lyricsMessageDescription: document.getElementById('mini-lyrics-message-description'),
    lyricsRetry: document.getElementById('mini-lyrics-retry'),
    lyricsFollow: document.getElementById('mini-lyrics-follow'),
    lyricsImport: document.getElementById('mini-lyrics-import'),
    cover: document.getElementById('mini-cover'),
    coverFallback: document.getElementById('mini-cover-fallback'),
    title: document.getElementById('mini-track-title'),
    artist: document.getElementById('mini-track-artist'),
    capability: document.getElementById('mini-capability'),
    progress: document.getElementById('mini-progress'),
    currentTime: document.getElementById('mini-current-time'),
    totalTime: document.getElementById('mini-total-time'),
    previous: document.getElementById('mini-previous'),
    play: document.getElementById('mini-play'),
    next: document.getElementById('mini-next'),
    message: document.getElementById('mini-message'),
    pin: document.getElementById('mini-pin'),
    hide: document.getElementById('mini-hide'),
    openMain: document.getElementById('mini-open-main'),
    resize: document.getElementById('mini-resize')
  };

  const state = {
    authenticated: false,
    capability: { mode: 'disconnected' },
    track: null,
    isPlaying: false,
    positionMs: 0,
    durationMs: 0,
    pinned: true,
    controlBusy: false,
    pollInFlight: false,
    scrubbing: false
  };
  let playbackPollTimer = null;
  let progressTimer = null;
  let activeCoverSource = '';
  let coverRequestGeneration = 0;
  const artworkCache = new Map();
  const artworkLookupsInFlight = new Set();
  const artworkRetryAfter = new Map();
  const ARTWORK_CACHE_LIMIT = 48;
  const ARTWORK_RETRY_DELAY_MS = 120_000;
  let resizePointerId = null;
  let resizing = false;
  const LyricsController = window.CozyLyrics?.LyricsController;
  const lyricsController = LyricsController
    ? new LyricsController(api.lyrics, {
      artworkTab: elements.coverTab,
      lyricsTab: elements.lyricsTab,
      artworkPanel: elements.artFrame,
      lyricsPanel: elements.lyricsPanel,
      badge: elements.lyricsState,
      modeLabel: elements.lyricsMode,
      scroller: elements.lyricsScroll,
      message: elements.lyricsMessage,
      messageTitle: elements.lyricsMessageTitle,
      messageDescription: elements.lyricsMessageDescription,
      retryButton: elements.lyricsRetry,
      followButton: elements.lyricsFollow,
      importButton: elements.lyricsImport
    }, {
      getPosition: () => state.positionMs,
      canSync: () => state.capability?.mode === 'standalone',
      isPlayerViewVisible: () => !document.hidden,
      promptModeLabel: 'LRCLIB · NO API KEY',
      importLocalLabel: 'LOCAL',
      replaceLocalLabel: 'LOCAL'
    })
    : null;

  function normalizeHex(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : fallback;
  }

  function hexToRgb(value) {
    const hex = normalizeHex(value, '#000000').slice(1);
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16)
    };
  }

  function mixHex(first, second, secondWeight) {
    const a = hexToRgb(first);
    const b = hexToRgb(second);
    const weight = Math.max(0, Math.min(1, secondWeight));
    return `#${[a.r, a.g, a.b].map((channel, index) => {
      const target = [b.r, b.g, b.b][index];
      return Math.round(channel * (1 - weight) + target * weight).toString(16).padStart(2, '0');
    }).join('')}`;
  }

  function luminance(value) {
    const { r, g, b } = hexToRgb(value);
    const channels = [r, g, b].map(channel => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }

  function contrastRatio(first, second) {
    const lighter = Math.max(luminance(first), luminance(second));
    const darker = Math.min(luminance(first), luminance(second));
    return (lighter + 0.05) / (darker + 0.05);
  }

  function clearTheme() {
    document.body.classList.remove('theme-soft-sunset', 'theme-custom', 'font-enlarged');
    [
      '--bg-primary', '--bg-secondary', '--bg-card', '--text-primary', '--text-secondary',
      '--accent-color', '--accent-color-hover', '--border-color', '--progress-bg',
      '--shadow-color', '--card-light', '--button-filled-text'
    ].forEach(property => document.body.style.removeProperty(property));
  }

  function applyTheme(theme = {}) {
    clearTheme();
    if (theme.kind === 'preset' && theme.id === 'soft-sunset') {
      document.body.classList.add('theme-soft-sunset');
    } else if (theme.kind === 'custom' && theme.colors) {
      const colors = theme.colors;
      const accent = normalizeHex(colors.accentColor, '#c08a6e');
      const border = normalizeHex(colors.borderColor, '#3c2f2f');
      const card = normalizeHex(colors.bgCard, '#ebd9c5');
      const primary = normalizeHex(colors.bgPrimary, '#f7f0e3');
      const secondary = normalizeHex(colors.bgSecondary, '#fdfaf3');
      const variables = {
        '--bg-primary': primary,
        '--bg-secondary': secondary,
        '--bg-card': card,
        '--text-primary': normalizeHex(colors.textPrimary, '#3c2f2f'),
        '--text-secondary': normalizeHex(colors.textSecondary, '#705e54'),
        '--accent-color': accent,
        '--accent-color-hover': mixHex(accent, border, 0.18),
        '--border-color': border,
        '--progress-bg': mixHex(card, primary, 0.45),
        '--shadow-color': border,
        '--card-light': mixHex(card, secondary, 0.45),
        '--button-filled-text': contrastRatio(accent, '#241b1b') >= 4.5 ? '#241b1b' : '#fffaf4'
      };
      document.body.classList.add('theme-custom');
      Object.entries(variables).forEach(([property, value]) => document.body.style.setProperty(property, value));
    }
    document.body.classList.toggle('font-enlarged', theme.fontSize === 'enlarged');
  }

  function safeImageUrl(value) {
    if (
      typeof value === 'string' &&
      value.length <= 4_200_000 &&
      /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(value)
    ) {
      return value;
    }
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' ? parsed.toString() : null;
    } catch {
      return null;
    }
  }

  function normalizeTrackText(value) {
    return typeof value === 'string'
      ? value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
      : '';
  }

  function trackIdentity(track) {
    if (!track || typeof track !== 'object') return '';
    const uri = typeof track.spotifyUri === 'string' ? track.spotifyUri.trim() : '';
    if (/^spotify:(?:track|episode):[A-Za-z0-9]+$/.test(uri)) return uri;
    const title = normalizeTrackText(track.title);
    const artist = normalizeTrackText(track.artist);
    return title ? `metadata:${title}|${artist}` : '';
  }

  function isSameTrack(first, second) {
    if (!first || !second) return false;
    const firstUri = typeof first.spotifyUri === 'string' ? first.spotifyUri.trim() : '';
    const secondUri = typeof second.spotifyUri === 'string' ? second.spotifyUri.trim() : '';
    if (firstUri || secondUri) return Boolean(firstUri && secondUri && firstUri === secondUri);
    const firstIdentity = trackIdentity(first);
    return Boolean(firstIdentity && firstIdentity === trackIdentity(second));
  }

  function rememberArtwork(identity, cover) {
    const safeCover = safeImageUrl(cover);
    if (!identity || !safeCover) return;
    artworkCache.delete(identity);
    artworkCache.set(identity, safeCover);
    while (artworkCache.size > ARTWORK_CACHE_LIMIT) {
      artworkCache.delete(artworkCache.keys().next().value);
    }
  }

  function mergeTrackWithArtwork(nextTrack) {
    if (!nextTrack || typeof nextTrack !== 'object') return null;
    const merged = { ...nextTrack };
    const identity = trackIdentity(merged);
    const suppliedCover = safeImageUrl(merged.cover);
    if (suppliedCover) {
      merged.cover = suppliedCover;
      rememberArtwork(identity, suppliedCover);
      return merged;
    }

    const previousCover = isSameTrack(merged, state.track) ? safeImageUrl(state.track?.cover) : null;
    const cachedCover = identity ? artworkCache.get(identity) : null;
    merged.cover = previousCover || cachedCover || null;
    return merged;
  }

  function artworkFromSpotifyItem(item) {
    const images = item?.album?.images || item?.images || item?.show?.images || [];
    if (!Array.isArray(images)) return null;
    for (const image of images) {
      const cover = safeImageUrl(image?.url);
      if (cover) return cover;
    }
    return null;
  }

  function findArtworkCandidate(items, track) {
    if (!Array.isArray(items)) return null;
    const exactUri = items.find(item => item?.uri && item.uri === track.spotifyUri);
    if (exactUri) return exactUri;

    const expectedTitle = normalizeTrackText(track.title);
    const expectedArtist = normalizeTrackText(track.artist);
    return items.find(item => {
      const candidateArtists = Array.isArray(item?.artists)
        ? item.artists.map(artist => artist?.name).filter(Boolean).join(', ')
        : '';
      return (
        normalizeTrackText(item?.name) === expectedTitle &&
        (!expectedArtist || normalizeTrackText(candidateArtists) === expectedArtist)
      );
    }) || null;
  }

  async function recoverMissingArtwork() {
    const track = state.track;
    const identity = trackIdentity(track);
    if (
      !track ||
      !identity ||
      !state.authenticated ||
      track.spotifyType === 'episode' ||
      safeImageUrl(track.cover) ||
      typeof api.spotify.search !== 'function'
    ) return;

    const cachedCover = artworkCache.get(identity);
    if (cachedCover) {
      state.track = { ...state.track, cover: cachedCover };
      renderCover();
      return;
    }

    if (
      artworkLookupsInFlight.has(identity) ||
      (artworkRetryAfter.get(identity) || 0) > Date.now()
    ) return;

    const query = `${track.title || ''} ${track.artist || ''}`.trim().slice(0, 200);
    if (!query) return;
    artworkLookupsInFlight.add(identity);
    artworkRetryAfter.set(identity, Date.now() + ARTWORK_RETRY_DELAY_MS);
    try {
      const result = await api.spotify.search(query, 0);
      const candidate = findArtworkCandidate(result?.items, track);
      const recoveredCover = artworkFromSpotifyItem(candidate);
      if (!recoveredCover) return;
      rememberArtwork(identity, recoveredCover);
      if (trackIdentity(state.track) !== identity || safeImageUrl(state.track?.cover)) return;
      state.track = { ...state.track, cover: recoveredCover };
      renderCover();
    } catch (error) {
      console.warn('[Side Player] Could not recover missing artwork:', error?.message || error);
    } finally {
      artworkLookupsInFlight.delete(identity);
    }
  }

  function mapSpotifyState(playerState) {
    const item = playerState?.item;
    if (!item) return null;
    const artists = Array.isArray(item.artists)
      ? item.artists.map(artist => artist?.name).filter(Boolean).join(', ')
      : '';
    const images = item.album?.images || item.images || item.show?.images || [];
    return {
      title: item.name || 'Unknown Track',
      artist: artists || item.show?.publisher || item.show?.name || 'Spotify',
      album: item.album?.name || item.show?.name || (item.type === 'episode' ? 'Podcast' : 'Single'),
      cover: images[0]?.url || null,
      spotifyUri: item.uri || null,
      spotifyUrl: item.external_urls?.spotify || null,
      spotifyType: item.type === 'episode' ? 'episode' : 'track'
    };
  }

  function setLoading(loading) {
    document.body.classList.toggle('is-loading', loading);
    elements.window.setAttribute('aria-busy', String(loading));
  }

  function setMessage(message) {
    elements.message.textContent = message || '';
  }

  function formatTime(milliseconds) {
    const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function renderTimeline() {
    const duration = Math.max(0, Number(state.durationMs) || 0);
    const position = Math.min(duration || Number.MAX_SAFE_INTEGER, Math.max(0, Number(state.positionMs) || 0));
    const displayPosition = state.scrubbing ? Math.max(0, Number(elements.progress.value) || 0) : position;
    if (!state.scrubbing) elements.progress.value = String(position);
    elements.progress.max = String(duration);
    elements.progress.style.setProperty('--progress-percent', duration > 0 ? `${(position / duration) * 100}%` : '0%');
    elements.currentTime.textContent = formatTime(displayPosition);
    elements.totalTime.textContent = formatTime(duration);
    elements.progress.disabled = state.capability.mode !== 'standalone' || duration <= 0 || state.controlBusy;
    lyricsController?.updatePosition(displayPosition, state.capability.mode === 'standalone');
  }

  function renderCover() {
    const cover = safeImageUrl(state.track?.cover);
    if (!cover) {
      activeCoverSource = '';
      coverRequestGeneration += 1;
      elements.cover.hidden = true;
      elements.cover.removeAttribute('src');
      elements.cover.alt = '';
      elements.coverFallback.hidden = false;
      elements.artFrame.classList.remove('has-artwork');
      void recoverMissingArtwork();
      return;
    }
    elements.cover.alt = `${state.track.title} cover art`;
    if (activeCoverSource === cover) return;
    activeCoverSource = cover;
    const requestGeneration = ++coverRequestGeneration;
    elements.coverFallback.hidden = true;
    elements.cover.hidden = false;
    elements.cover.src = cover;

    if (!cover.startsWith('https:') || !api.sidePlayer.resolveArtwork) return;
    api.sidePlayer.resolveArtwork(cover)
      .then(resolvedArtwork => {
        if (
          requestGeneration !== coverRequestGeneration ||
          activeCoverSource !== cover ||
          !safeImageUrl(resolvedArtwork)?.startsWith('data:image/')
        ) return;
        elements.cover.hidden = false;
        elements.cover.src = resolvedArtwork;
      })
      .catch(() => {
        if (
          requestGeneration === coverRequestGeneration &&
          (!elements.cover.complete || elements.cover.naturalWidth === 0)
        ) {
          elements.cover.hidden = true;
          elements.coverFallback.hidden = false;
          elements.artFrame.classList.remove('has-artwork');
        }
      });
  }

  function render() {
    const mode = state.capability?.mode || 'disconnected';
    const capabilityLabels = {
      standalone: state.capability?.tier === 'premium' ? 'PREMIUM · LOCAL' : 'LOCAL PLAYER',
      external: state.capability?.tier === 'free' ? 'FREE · SPOTIFY' : 'SPOTIFY APP',
      authorizing: 'AUTHORIZE',
      starting: 'STARTING',
      unavailable: 'UNAVAILABLE',
      disconnected: 'NOT CONNECTED'
    };
    elements.capability.textContent = capabilityLabels[mode] || 'CHECKING';

    if (state.track) {
      elements.title.textContent = state.track.title || 'Unknown Track';
      elements.artist.textContent = [state.track.artist, state.track.album].filter(Boolean).join(' · ');
    } else {
      elements.title.textContent = 'Awaiting Track';
      elements.artist.textContent = state.authenticated
        ? (mode === 'external' ? 'Choose a song in Cozy-Fi to open it in Spotify.' : 'Choose a song in the full Cozy-Fi app.')
        : 'Connect Spotify in the full app to begin.';
    }
    renderCover();
    lyricsController?.setTrack(state.track ? {
      ...state.track,
      durationMs: state.durationMs
    } : null);

    const local = state.authenticated && mode === 'standalone';
    const external = state.authenticated && mode === 'external';
    elements.previous.disabled = state.controlBusy || !local;
    elements.next.disabled = state.controlBusy || !local;
    elements.play.disabled = state.controlBusy || (!local && !(external && (state.track?.spotifyUri || state.track?.spotifyUrl)));
    elements.play.textContent = external ? 'OPEN' : (state.isPlaying ? 'PAUSE' : 'PLAY');
    elements.play.setAttribute('aria-label', external ? 'Open in Spotify' : (state.isPlaying ? 'Pause' : 'Play'));
    elements.pin.setAttribute('aria-pressed', String(state.pinned));
    elements.pin.title = state.pinned ? 'Unpin from on top' : 'Keep on top';

    if (mode === 'standalone') setMessage(state.isPlaying ? 'PLAYING INSIDE COZY-FI' : 'READY INSIDE COZY-FI');
    else if (mode === 'external') setMessage('OPENS IN SPOTIFY');
    else if (mode === 'authorizing') setMessage('FINISH ONE-TIME AUTHORIZATION');
    else if (mode === 'starting') setMessage('WARMING UP LOCAL PLAYER');
    else if (mode === 'unavailable') setMessage('OPEN FULL APP FOR DETAILS');
    else setMessage('CONNECT IN THE FULL APP');
    renderTimeline();
  }

  function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    state.track = mergeTrackWithArtwork(snapshot.track);
    state.isPlaying = Boolean(snapshot.isPlaying);
    state.positionMs = Math.max(0, Number(snapshot.positionMs) || 0);
    state.durationMs = Math.max(0, Number(snapshot.durationMs) || 0);
    render();
  }

  async function refreshPlayback() {
    if (
      state.pollInFlight ||
      !state.authenticated ||
      state.capability.mode !== 'standalone' ||
      document.hidden
    ) return;
    state.pollInFlight = true;
    try {
      const playerState = await api.spotify.getPlayerState();
      if (playerState?.item) {
        state.track = mergeTrackWithArtwork(mapSpotifyState(playerState));
        state.isPlaying = Boolean(playerState.is_playing);
        state.positionMs = Math.max(0, Number(playerState.progress_ms) || 0);
        state.durationMs = Math.max(0, Number(playerState.item.duration_ms) || 0);
        render();
      } else {
        state.isPlaying = false;
        render();
      }
    } catch (error) {
      setMessage(error?.message || 'COULD NOT REFRESH PLAYER');
    } finally {
      state.pollInFlight = false;
    }
  }

  async function runControl(command, optimisticPlaying) {
    if (state.controlBusy) return;
    const previousPlaying = state.isPlaying;
    let failureMessage = '';
    state.controlBusy = true;
    if (typeof optimisticPlaying === 'boolean') state.isPlaying = optimisticPlaying;
    render();
    try {
      await command();
      setTimeout(refreshPlayback, 350);
    } catch (error) {
      state.isPlaying = previousPlaying;
      failureMessage = error?.message || 'PLAYBACK COMMAND FAILED';
    } finally {
      state.controlBusy = false;
      render();
      if (failureMessage) setMessage(failureMessage);
    }
  }

  elements.play.addEventListener('click', () => {
    if (state.capability.mode === 'external') {
      if (state.track?.spotifyType !== 'episode' && state.track?.spotifyUri) {
        runControl(() => api.spotify.playTrack(state.track.spotifyUri));
      } else if (state.track?.spotifyUrl) {
        runControl(() => api.spotify.openExternal(state.track.spotifyUrl));
      }
      return;
    }
    const wasPlaying = state.isPlaying;
    runControl(
      () => wasPlaying ? api.spotify.pause() : api.spotify.resume(),
      !wasPlaying
    );
  });
  elements.previous.addEventListener('click', () => runControl(() => api.spotify.previous()));
  elements.next.addEventListener('click', () => runControl(() => api.spotify.next()));

  elements.progress.addEventListener('input', () => {
    state.scrubbing = true;
    const duration = Math.max(0, Number(state.durationMs) || 0);
    const position = Math.min(duration, Math.max(0, Number(elements.progress.value) || 0));
    elements.progress.style.setProperty('--progress-percent', duration > 0 ? `${(position / duration) * 100}%` : '0%');
    elements.currentTime.textContent = formatTime(position);
    lyricsController?.updatePosition(position, state.capability.mode === 'standalone');
  });
  elements.progress.addEventListener('change', () => {
    const position = Math.max(0, Number(elements.progress.value) || 0);
    state.positionMs = position;
    state.scrubbing = false;
    runControl(() => api.spotify.seek(position));
  });

  elements.cover.addEventListener('load', () => {
    if (!elements.cover.getAttribute('src')) return;
    elements.cover.hidden = false;
    elements.coverFallback.hidden = true;
    elements.artFrame.classList.add('has-artwork');
  });
  elements.cover.addEventListener('error', () => {
    elements.cover.hidden = true;
    elements.coverFallback.hidden = false;
    elements.artFrame.classList.remove('has-artwork');
  });
  elements.hide.addEventListener('click', () => api.sidePlayer.hide());
  elements.openMain.addEventListener('click', () => api.sidePlayer.openMain());
  elements.titlebar.addEventListener('dblclick', event => {
    if (!event.target.closest('button')) api.sidePlayer.openMain();
  });

  function finishResize(pointerId = resizePointerId) {
    if (pointerId === null || pointerId !== resizePointerId) return;
    resizePointerId = null;
    resizing = false;
    document.body.classList.remove('is-resizing');
    if (elements.resize.hasPointerCapture?.(pointerId)) elements.resize.releasePointerCapture(pointerId);
    api.sidePlayer.endResize();
  }

  elements.resize.addEventListener('pointerdown', async event => {
    if (event.button !== 0 || resizePointerId !== null) return;
    event.preventDefault();
    event.stopPropagation();
    resizePointerId = event.pointerId;
    elements.resize.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing');
    try {
      await api.sidePlayer.beginResize({ screenX: event.screenX, screenY: event.screenY });
      if (resizePointerId !== event.pointerId) {
        api.sidePlayer.endResize();
        return;
      }
      resizing = true;
    } catch (error) {
      finishResize(event.pointerId);
      setMessage(error?.message || 'COULD NOT START RESIZING');
    }
  });
  elements.resize.addEventListener('pointermove', event => {
    if (!resizing || event.pointerId !== resizePointerId) return;
    api.sidePlayer.resize({ screenX: event.screenX, screenY: event.screenY });
  });
  elements.resize.addEventListener('pointerup', event => finishResize(event.pointerId));
  elements.resize.addEventListener('pointercancel', event => finishResize(event.pointerId));
  elements.resize.addEventListener('lostpointercapture', event => finishResize(event.pointerId));
  elements.resize.addEventListener('keydown', async event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 32 : 8;
    const delta = {
      width: event.key === 'ArrowLeft' ? -step : (event.key === 'ArrowRight' ? step : 0),
      height: event.key === 'ArrowUp' ? -step : (event.key === 'ArrowDown' ? step : 0)
    };
    try {
      await api.sidePlayer.resizeBy(delta);
    } catch (error) {
      setMessage(error?.message || 'COULD NOT RESIZE SIDE PLAYER');
    }
  });

  elements.pin.addEventListener('click', async () => {
    try {
      const windowState = await api.sidePlayer.setPinned(!state.pinned);
      state.pinned = Boolean(windowState?.pinned);
      render();
    } catch (error) {
      setMessage(error?.message || 'COULD NOT CHANGE PIN');
    }
  });

  api.sidePlayer.onTheme(applyTheme);
  api.sidePlayer.onSnapshot(applySnapshot);
  api.sidePlayer.onState(windowState => {
    state.pinned = windowState?.pinned !== false;
    render();
  });
  api.events.onPlaybackCapability(capability => {
    state.capability = capability || { mode: 'disconnected' };
    render();
    if (state.capability.mode === 'standalone') refreshPlayback();
  });
  api.events.onConnectionSuccess(() => {
    state.authenticated = true;
    refreshPlayback();
  });
  api.events.onConnectionLogout(() => {
    state.authenticated = false;
    state.track = null;
    state.isPlaying = false;
    state.positionMs = 0;
    state.durationMs = 0;
    render();
  });
  api.events.onPlaybackError(message => setMessage(message || 'LOCAL PLAYER ERROR'));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      lyricsController?.onPlayerViewVisible();
      refreshPlayback();
    }
  });

  async function initialize() {
    setLoading(true);
    try {
      const [authenticated, capability, windowState] = await Promise.all([
        api.auth.getStatus(),
        api.spotify.getPlaybackCapability(),
        api.sidePlayer.getState()
      ]);
      state.authenticated = Boolean(authenticated);
      state.capability = capability || { mode: 'disconnected' };
      state.pinned = windowState?.pinned !== false;
      if (state.authenticated && state.capability.mode === 'standalone') await refreshPlayback();
    } catch (error) {
      setMessage(error?.message || 'COULD NOT START SIDE PLAYER');
    } finally {
      setLoading(false);
      render();
    }

    playbackPollTimer = setInterval(refreshPlayback, 5000);
    progressTimer = setInterval(() => {
      if (!state.isPlaying || state.scrubbing || document.hidden) return;
      state.positionMs = Math.min(state.durationMs, state.positionMs + 1000);
      renderTimeline();
    }, 1000);
  }

  window.addEventListener('beforeunload', () => {
    clearInterval(playbackPollTimer);
    clearInterval(progressTimer);
  });

  initialize();
});
