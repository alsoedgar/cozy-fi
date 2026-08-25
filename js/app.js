// Cozy-Fi Main Bootstrapper and glue code
const AudioEngineClass = window.AudioEngine;
const SpotifyClientClass = window.SpotifyClient;
const RouterClass = window.Router;
const ThemeManagerClass = window.ThemeManager;
const RenderEngineClass = window.RenderEngine;
const SearchManagerClass = window.SearchManager;
const UIManagerClass = window.UIManager;
const LyricsControllerClass = window.CozyLyrics.LyricsController;

document.addEventListener('DOMContentLoaded', () => {
  localStorage.removeItem('spotify_access_token');
  localStorage.removeItem('spotify_client_secret');
  localStorage.removeItem('spotify_client_id');
  const audio = new AudioEngineClass();
  const spotify = new SpotifyClientClass();
  let currentDisplayedTrack = null;
  let currentSpotifyPosition = 0;
  let currentSpotifyDuration = 0;
  let isSpotifyPlaying = false;
  let lastSpotifyTrackId = null;
  let playbackAuthorizationPending = false;
  const playbackAuthorizationMessage = 'Complete the one-time local-player authorization in the Cozy-Fi window. Spotify does not need to be open afterward.';

  window.cozyApi?.events.onRateLimit(data => showRateLimitBanner(data?.retryAfter || 2));
  window.cozyApi?.events.onPlaybackAuthRequired(data => {
    playbackAuthorizationPending = true;
    const message = data?.message || playbackAuthorizationMessage;
    const status = document.getElementById('spotify-connection-status');
    if (status) status.textContent = message;
    showStatusBanner(message);
  });
  window.cozyApi?.events.onDeviceReady(() => {
    playbackAuthorizationPending = false;
    const status = document.getElementById('spotify-connection-status');
    if (status) status.textContent = 'Connected. Audio plays directly inside Cozy-Fi; Spotify can stay closed.';
  });

  function showErrorBanner(message) {
    let banner = document.getElementById('app-error-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'app-error-banner';
      banner.setAttribute('role', 'alert');
      banner.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);max-width:min(560px,90vw);background:var(--bg-secondary);color:var(--text-primary);padding:12px 18px;border:3px solid var(--border-color);box-shadow:3px 3px 0 var(--shadow-color);z-index:10000;font-family:Space Mono,monospace;font-size:var(--font-xs);';
      document.body.appendChild(banner);
    }
    banner.textContent = message || 'Something went wrong.';
    clearTimeout(showErrorBanner.timeoutId);
    showErrorBanner.timeoutId = setTimeout(() => banner.remove(), 7000);
  }
  window.showCozyError = showErrorBanner;

  function showStatusBanner(message) {
    let banner = document.getElementById('app-status-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'app-status-banner';
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');
      banner.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);max-width:min(620px,90vw);background:var(--bg-secondary);color:var(--text-primary);padding:12px 18px;border:3px solid var(--border-color);box-shadow:3px 3px 0 var(--shadow-color);z-index:9999;font-family:Space Mono,monospace;font-size:var(--font-xs);';
      document.body.appendChild(banner);
    }
    banner.textContent = message;
    clearTimeout(showStatusBanner.timeoutId);
    showStatusBanner.timeoutId = setTimeout(() => banner.remove(), 12000);
  }
  window.showCozyStatus = showStatusBanner;

  function showRateLimitBanner(retryAfter) {
    let banner = document.getElementById('rate-limit-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'rate-limit-banner';
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');
      banner.style.position = 'fixed';
      banner.style.top = '16px';
      banner.style.right = '16px';
      banner.style.backgroundColor = 'var(--accent-color)';
      banner.style.color = 'var(--button-filled-text)';
      banner.style.padding = '12px 20px';
      banner.style.borderRadius = 'var(--border-radius)';
      banner.style.border = '2px solid var(--border-color)';
      banner.style.boxShadow = '3px 3px 0px var(--shadow-color)';
      banner.style.zIndex = '9999';
      banner.style.fontFamily = "'Space Mono', monospace";
      banner.style.fontSize = 'var(--font-xs)';
      banner.style.display = 'flex';
      banner.style.alignItems = 'center';
      banner.style.gap = '10px';
      document.body.appendChild(banner);
    }
    const mins = Math.ceil(retryAfter / 60);
    const waitLabel = retryAfter < 60 ? `${retryAfter} sec` : `${mins} min`;
    banner.innerHTML = `
      <div>
        <strong>Spotify Rate Limit Active</strong><br>
        <span style="font-size: 0.75rem;">Retrying shortly. Spotify wait: ~${waitLabel}.</span>
      </div>
    `;
    setTimeout(() => {
      if (banner && banner.parentNode) {
        banner.remove();
      }
    }, 6000);
  }

  // Dynamic Greeting based on time of day
  const hrs = new Date().getHours();
  let greet = 'Good Morning';
  if (hrs >= 12 && hrs < 17) {
    greet = 'Good Afternoon';
  } else if (hrs >= 17 || hrs < 5) {
    greet = 'Good Evening';
  }
  const welcomeGreeting = document.getElementById('welcome-greeting');
  if (welcomeGreeting) {
    welcomeGreeting.textContent = greet + '.';
  }

  // 1. Initialize Route Router
  const navItems = document.querySelectorAll('.nav-item');
  const mainViews = document.querySelectorAll('.main-view');
  const headerBar = document.getElementById('top-header-bar');

  const router = new RouterClass(navItems, mainViews, headerBar, (viewId) => {
    if (viewId === 'player') {
      updatePlayerView(currentDisplayedTrack || audio.getCurrentTrack());
      lyricsController.onPlayerViewVisible();
    }
    // Collapse sidebar automatically on page transition (mobile/desktop responsive feel)
    setSidebarExpanded(false);
  });

  // 2. Initialize Sidebar Toggle Drawer
  const sidebar = document.getElementById('app-sidebar');
  const sidebarToggle = document.getElementById('sidebar-toggle');

  const setSidebarExpanded = expanded => {
    const shouldReturnFocus = !expanded && sidebar.contains(document.activeElement);
    sidebar.classList.toggle('expanded', expanded);
    sidebar.inert = !expanded;
    sidebarToggle.setAttribute('aria-expanded', String(expanded));
    sidebar.setAttribute('aria-hidden', String(!expanded));
    sidebar.querySelectorAll('.nav-item, .side-player-nav-button').forEach(item => {
      item.tabIndex = expanded ? 0 : -1;
    });
    if (shouldReturnFocus) sidebarToggle.focus();
  };
  setSidebarExpanded(false);

  sidebarToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setSidebarExpanded(!sidebar.classList.contains('expanded'));
  });

  // Click outside sidebar to close it
  document.addEventListener('click', (e) => {
    if (sidebar.classList.contains('expanded') && !sidebar.contains(e.target) && e.target !== sidebarToggle) {
      setSidebarExpanded(false);
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && sidebar.classList.contains('expanded')) {
      setSidebarExpanded(false);
      sidebarToggle.focus();
    }
  });

  const sidePlayerToggle = document.getElementById('side-player-toggle');
  const sidePlayerToggleState = document.getElementById('side-player-toggle-state');
  const updateSidePlayerToggle = state => {
    const visible = Boolean(state?.visible);
    sidePlayerToggle?.setAttribute('aria-pressed', String(visible));
    if (sidePlayerToggleState) sidePlayerToggleState.textContent = visible ? 'HIDE' : 'SHOW';
    if (sidePlayerToggle) {
      sidePlayerToggle.title = visible ? 'Hide the compact side player' : 'Show the compact side player';
    }
  };
  const sidePlayerApi = window.cozyApi?.sidePlayer;
  sidePlayerApi?.onState(updateSidePlayerToggle);
  if (sidePlayerApi) {
    sidePlayerApi.getState()
      .then(updateSidePlayerToggle)
      .catch(error => console.warn('Could not read side-player state:', error));
  }
  sidePlayerToggle?.addEventListener('click', async () => {
    sidePlayerToggle.disabled = true;
    try {
      updateSidePlayerToggle(await sidePlayerApi.toggle());
      setSidebarExpanded(false);
    } catch (error) {
      showErrorBanner(error?.message || 'Could not open the side player.');
    } finally {
      sidePlayerToggle.disabled = false;
    }
  });

  // 3. Initialize Theme Manager
  const themeBoxes = document.querySelectorAll('.theme-option-box');
  const saveThemeBtn = document.getElementById('save-theme-btn');
  const typoRows = document.querySelectorAll('.typo-option-row');
  new ThemeManagerClass(themeBoxes, saveThemeBtn, typoRows);

  const lyricsController = new LyricsControllerClass(window.cozyApi?.lyrics, {
    artworkTab: document.getElementById('player-now-playing-tab'),
    lyricsTab: document.getElementById('player-lyrics-tab'),
    artworkPanel: document.getElementById('player-now-playing-panel'),
    lyricsPanel: document.getElementById('player-lyrics-panel'),
    badge: document.getElementById('lyrics-tab-badge'),
    trackTitle: document.getElementById('lyrics-track-title'),
    trackArtist: document.getElementById('lyrics-track-artist'),
    modeLabel: document.getElementById('lyrics-mode-label'),
    scroller: document.getElementById('lyrics-scroll'),
    message: document.getElementById('lyrics-message'),
    messageTitle: document.getElementById('lyrics-message-title'),
    messageDescription: document.getElementById('lyrics-message-description'),
    retryButton: document.getElementById('lyrics-retry-button'),
    followButton: document.getElementById('lyrics-follow-button')
  }, {
    getPosition: () => currentSpotifyPosition,
    canSync: () => spotify.isStandalonePlayback,
    isPlayerViewVisible: () => document.getElementById('view-player')?.classList.contains('active')
  });

  // 4. Initialize Renderer
  const recentListEl = document.getElementById('recent-sessions-list');
  const likedListEl = document.getElementById('liked-tracks-container');
  const playlistsGridEl = document.getElementById('library-playlists-grid');
  const trackPaginationEl = document.getElementById('liked-tracks-pagination');
  const libraryPaginationEl = document.getElementById('library-grid-pagination');

  const renderer = new RenderEngineClass(audio, spotify, {
    recentListEl,
    likedListEl,
    playlistsGridEl,
    trackPaginationEl,
    libraryPaginationEl
  }, (trackIndexOrTrack, isSpotify, openedExternally = false) => {
    if (isSpotify) {
      if (trackIndexOrTrack) {
        updatePlayerBarUI(trackIndexOrTrack, !openedExternally);
        updatePlayerView(trackIndexOrTrack);
        updateDailyBrewCard(trackIndexOrTrack);
      }
      if (!openedExternally) handlePlaybackCommand(true);
      else syncSidePlayerSnapshot(true);
    } else {
      audio.loadTrack(trackIndexOrTrack);
      audio.play();
      ui.updatePlayPauseButtonUI(true);
    }
  });

  // 5. Initialize Search Manager
  const searchInput = document.getElementById('main-search-input');
  const resultsContainer = document.getElementById('search-results-container');
  const placeholderContainer = document.getElementById('search-placeholder');
  const recommendationsGrid = document.getElementById('search-recommendations-grid');
  const searchPaginationEl = document.getElementById('search-pagination');

  const searchManager = new SearchManagerClass(
    audio,
    spotify,
    { searchInput, resultsContainer, placeholderContainer, recommendationsGrid, paginationEl: searchPaginationEl },
    (trackIndexOrTrack, isSpotify, openedExternally = false) => {
      if (isSpotify) {
        if (trackIndexOrTrack) {
          updatePlayerBarUI(trackIndexOrTrack, !openedExternally);
          updatePlayerView(trackIndexOrTrack);
          updateDailyBrewCard(trackIndexOrTrack);
        }
        if (!openedExternally) handlePlaybackCommand(true);
        else syncSidePlayerSnapshot(true);
      } else {
        audio.loadTrack(trackIndexOrTrack);
        audio.play();
        ui.updatePlayPauseButtonUI(true);
      }
    },
    (mood) => {
      const moodVal = document.querySelector('.current-mood-value');
      if (moodVal) moodVal.textContent = capitalizeFirst(mood);
    }
  );

  // Library category tags click handlers
  const libraryTags = document.querySelectorAll('.library-tag');
  libraryTags.forEach(tag => {
    tag.addEventListener('click', async () => {
      libraryTags.forEach(t => t.classList.remove('active'));
      libraryTags.forEach(t => t.setAttribute('aria-selected', 'false'));
      tag.classList.add('active');
      tag.setAttribute('aria-selected', 'true');
      const type = tag.getAttribute('data-type');
      const normalizedType = type === 'all' ? 'playlists' : type;
      try {
        if (normalizedType === 'playlists') {
          await Promise.all([
            renderer.renderLibraryPlaylists(normalizedType),
            renderer.renderLibraryTracks('liked', 'Liked Songs', 'liked')
          ]);
        } else {
          await renderer.renderLibraryPlaylists(normalizedType);
        }
      } catch (error) {
        console.error('Could not switch Library categories:', error);
      }
    });
    tag.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tags = Array.from(libraryTags);
      const currentIndex = tags.indexOf(tag);
      const nextIndex = event.key === 'Home' ? 0
        : event.key === 'End' ? tags.length - 1
          : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tags.length) % tags.length;
      tags[nextIndex].focus();
      tags[nextIndex].click();
    });
  });

  // Link "View All" on Home page to Library route
  const viewAllLink = document.querySelector('.section-link');
  if (viewAllLink) {
    viewAllLink.addEventListener('click', (e) => {
      e.preventDefault();
      router.navigate('library');
    });
  }

  // 6. Initialize Player Controls UI
  const playBtn = document.getElementById('player-play-btn');
  const prevBtn = document.getElementById('player-prev-btn');
  const nextBtn = document.getElementById('player-next-btn');

  const sliders = {
    timelineSlider: document.getElementById('timeline-slider'),
    timelineFill: document.getElementById('timeline-fill'),
    timelineThumb: document.getElementById('timeline-thumb'),
    currentTimeLabel: document.getElementById('current-time'),
    totalTimeLabel: document.getElementById('total-time'),
    sessionTimerFill: document.getElementById('session-timer-fill'),
    volumeSlider: document.getElementById('volume-slider'),
    volumeFill: document.getElementById('volume-fill'),
    volumeThumb: document.getElementById('volume-thumb')
  };

  const ui = new UIManagerClass(audio, spotify, {
    playBtn,
    prevBtn,
    nextBtn,
    onPlaybackCommand: handlePlaybackCommand,
    onSeekCommand: () => schedulePlaybackPoll(1300)
  }, sliders);

  const playbackModeSelect = document.getElementById('playback-mode-select');
  const playbackCapabilityBadge = document.getElementById('playback-capability-badge');
  let lastExternalPlaybackState = null;
  spotify.onPlaybackCapabilityChange(capability => {
    updatePlaybackCapabilityUI(capability);
    ui.setPlaybackCapability(capability);
    const external = capability?.mode === 'external';
    document.querySelectorAll('[data-play-action]').forEach(button => {
      button.textContent = external ? 'OPEN' : 'PLAY';
    });
    if (lastExternalPlaybackState !== null && lastExternalPlaybackState !== external) {
      renderer.renderLibraryPlaylists(renderer.activeType).catch(error => console.error(error));
      if (renderer.currentTrackContext) {
        const context = renderer.currentTrackContext;
        renderer.renderLibraryTracks(context.id, context.name, context.type, context.cover).catch(error => console.error(error));
      }
      searchManager.triggerSearch(searchInput.value.trim(), searchManager.searchPage).catch(error => console.error(error));
    }
    lastExternalPlaybackState = external;
  });

  // 7. Track change synchronization
  audio.onTrackChange(track => {
    // Only update UI from HTML5 if Spotify player is not active
    if (!track || (spotify.isAuthenticated && spotify.isDeviceReady)) {
      return;
    }
    updatePlayerBarUI(track, audio.isPlaying);
    updatePlayerView(track);
    updateDailyBrewCard(track);
    updateQueueOverlay();
  });

  // Serialized, adaptive Spotify Connect state synchronization.
  let playbackPollTimer;
  let spotifyStateInterval;
  let playbackPollGeneration = 0;
  let sidePlayerSnapshotTimer = null;

  function syncSidePlayerSnapshot(immediate = false) {
    const api = window.cozyApi?.sidePlayer;
    if (!api?.syncSnapshot) return;
    const sendSnapshot = () => {
      sidePlayerSnapshotTimer = null;
      const track = currentDisplayedTrack ? {
        title: currentDisplayedTrack.title,
        artist: currentDisplayedTrack.artist,
        album: currentDisplayedTrack.album,
        cover: currentDisplayedTrack.cover,
        spotifyUri: currentDisplayedTrack.spotifyUri,
        spotifyUrl: currentDisplayedTrack.spotifyUrl,
        spotifyType: currentDisplayedTrack.spotifyType
      } : null;
      api.syncSnapshot({
        track,
        isPlaying: spotify.isStandalonePlayback ? isSpotifyPlaying : Boolean(audio.isPlaying),
        positionMs: spotify.isStandalonePlayback ? currentSpotifyPosition : 0,
        durationMs: spotify.isStandalonePlayback
          ? currentSpotifyDuration
          : Math.max(0, Number(currentDisplayedTrack?.durationMs) || 0),
        loading: false
      }).catch(error => console.warn('Could not sync the side player:', error));
    };
    clearTimeout(sidePlayerSnapshotTimer);
    if (immediate) sendSnapshot();
    else sidePlayerSnapshotTimer = setTimeout(sendSnapshot, 60);
  }

  function handlePlaybackCommand(playingState) {
    if (typeof playingState === 'boolean') {
      isSpotifyPlaying = playingState;
      ui.updatePlayPauseButtonUI(playingState);
    }
    syncSidePlayerSnapshot(true);
    schedulePlaybackPoll(typeof playingState === 'boolean' ? 250 : 650);
    refreshOpenQueue();
  }

  function schedulePlaybackPoll(delay = 0) {
    const pollGeneration = ++playbackPollGeneration;
    clearTimeout(playbackPollTimer);
    playbackPollTimer = setTimeout(() => pollPlaybackState(pollGeneration), delay);
  }

  async function pollPlaybackState(pollGeneration) {
    if (pollGeneration !== playbackPollGeneration) return;
    if (!spotify.isAuthenticated || !spotify.isStandalonePlayback) {
      isSpotifyPlaying = false;
      ui.updatePlayPauseButtonUI(false);
      schedulePlaybackPoll(5000);
      return;
    }
    try {
      const state = await spotify.getMyPlayerState();
      if (pollGeneration !== playbackPollGeneration || !spotify.isAuthenticated) return;
      if (state && state.item) {
        const currentTrack = state.item;
        const isPlaying = state.is_playing;
        isSpotifyPlaying = isPlaying;
        currentSpotifyPosition = Number(state.progress_ms) || 0;
        currentSpotifyDuration = Number(currentTrack.duration_ms) || 0;
        window.currentSpotifyPosition = currentSpotifyPosition;
        window.currentSpotifyDuration = currentSpotifyDuration;
        if (Number.isFinite(Number(state.device?.volume_percent))) {
          ui.updateVolumeUI(Number(state.device.volume_percent));
        }

        const artistNames = Array.isArray(currentTrack.artists)
          ? currentTrack.artists.map(artist => artist?.name).filter(Boolean).join(', ')
          : '';
        const albumOrShow = currentTrack.album || currentTrack.show || null;
        const coverImages = currentTrack.album?.images || currentTrack.images || currentTrack.show?.images || [];
        const previousCover = currentDisplayedTrack?.spotifyUri === currentTrack.uri
          ? currentDisplayedTrack.cover
          : null;
        const previousContextPosition = currentDisplayedTrack?.spotifyUri === currentTrack.uri
          ? currentDisplayedTrack.playbackContextPosition
          : null;
        const playbackContextUri = /^spotify:(playlist|album):/.test(state.context?.uri || '')
          ? state.context.uri
          : null;
        const mockTrack = {
          id: currentTrack.id,
          title: currentTrack.name || 'Unknown Track',
          artist: artistNames || currentTrack.show?.publisher || currentTrack.show?.name || 'Spotify',
          album: albumOrShow?.name || (currentTrack.type === 'episode' ? 'Podcast' : 'Single'),
          cover: coverImages[0]?.url || previousCover || null,
          durationMs: currentTrack.duration_ms || 0,
          spotifyUri: currentTrack.uri,
          spotifyUrl: currentTrack.external_urls?.spotify || null,
          spotifyType: currentTrack.type || 'track',
          playbackContextUri,
          playbackContextPosition: previousContextPosition
        };

        if (currentTrack.id !== lastSpotifyTrackId) {
          lastSpotifyTrackId = currentTrack.id;
          updatePlayerBarUI(mockTrack, isPlaying);
          updatePlayerView(mockTrack);
          updateDailyBrewCard(mockTrack);
          refreshOpenQueue();
        } else {
          ui.updatePlayPauseButtonUI(isPlaying);
        }
        if (!window.isScrubbingTimeline) {
          updateTimelineUI(currentSpotifyPosition, currentSpotifyDuration);
        }
      } else {
        isSpotifyPlaying = false;
        ui.updatePlayPauseButtonUI(false);
      }
      schedulePlaybackPoll(isSpotifyPlaying ? 5000 : 10000);
    } catch (e) {
      if (pollGeneration !== playbackPollGeneration) return;
      console.warn('Playback polling failed:', e);
      schedulePlaybackPoll(15000);
    }
  }

  spotifyStateInterval = setInterval(() => {
    if (!spotify.isAuthenticated || !isSpotifyPlaying || window.isScrubbingTimeline) return;
    const previousPosition = currentSpotifyPosition;
    currentSpotifyPosition = Math.min(
      Number(window.currentSpotifyPosition) + 1000 || 0,
      currentSpotifyDuration
    );
    window.currentSpotifyPosition = currentSpotifyPosition;
    updateTimelineUI(currentSpotifyPosition, currentSpotifyDuration);
    if (currentSpotifyDuration > 0 && previousPosition < currentSpotifyDuration && currentSpotifyPosition >= currentSpotifyDuration) {
      schedulePlaybackPoll(250);
    }
  }, 1000);
  schedulePlaybackPoll(1000);

  function updateTimelineUI(posMs, durMs) {
    const posSec = Math.floor(posMs / 1000);
    const durSec = Math.floor(durMs / 1000);

    const currentTimeLabel = document.getElementById('current-time');
    const totalTimeLabel = document.getElementById('total-time');
    const timelineFill = document.getElementById('timeline-fill');
    const timelineThumb = document.getElementById('timeline-thumb');

    if (currentTimeLabel) currentTimeLabel.textContent = formatTime(posSec);
    if (totalTimeLabel) totalTimeLabel.textContent = formatTime(durSec);

    if (durSec > 0) {
      const pct = (posSec / durSec) * 100;
      if (timelineFill) timelineFill.style.width = `${pct}%`;
      if (timelineThumb) timelineThumb.style.left = `${pct}%`;
      document.getElementById('timeline-slider')?.setAttribute('aria-valuenow', String(Math.round(pct)));

      // Update home view progress bar (simulate session progress)
      const sessionTimerFill = document.getElementById('session-timer-fill');
      if (sessionTimerFill) {
        sessionTimerFill.style.width = `${Math.min(pct * 1.5, 100)}%`;
      }
    } else {
      if (timelineFill) timelineFill.style.width = '0%';
      if (timelineThumb) timelineThumb.style.left = '0%';
      document.getElementById('timeline-slider')?.setAttribute('aria-valuenow', '0');
    }
    lyricsController.updatePosition(posMs, spotify.isStandalonePlayback);
    syncSidePlayerSnapshot();
  }

  function formatTime(secs) {
    const mins = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${mins}:${s.toString().padStart(2, '0')}`;
  }

  function renderCover(containerId, coverUrl, titleText, contextClass = 'player-album-art') {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    // Explicitly check context class to prevent sizing overrides
    let safeCoverUrl = null;
    try {
      const parsed = new URL(coverUrl);
      if (parsed.protocol === 'https:') safeCoverUrl = parsed.toString();
    } catch {}

    if (safeCoverUrl) {
      const img = document.createElement('img');
      img.src = safeCoverUrl;
      img.alt = titleText;
      img.className = contextClass;
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';
      container.appendChild(img);
    } else {
      const firstChar = titleText ? titleText.charAt(0).toUpperCase() : 'M';
      const placeholder = document.createElement('div');
      placeholder.className = `${contextClass} placeholder-gradient-cover`;
      const label = document.createElement('span');
      label.textContent = firstChar;
      placeholder.appendChild(label);
      container.appendChild(placeholder);
    }
  }

  // Daily Brew Now Playing/Suggestion Card updater
  let likeCheckGeneration = 0;
  function updateDailyBrewCard(track) {
    const titleEl = document.getElementById('daily-brew-title');
    const descEl = document.querySelector('.daily-brew-desc');
    const tagEl = document.querySelector('.daily-brew-tag');
    const likeBtn = document.getElementById('daily-brew-like-btn');
    const openBtn = document.getElementById('daily-brew-open-btn');

    if (track && titleEl && descEl && tagEl && likeBtn && openBtn) {
      tagEl.textContent = 'NOW PLAYING';
      titleEl.textContent = track.title;
      descEl.textContent = `By ${track.artist}. Album: ${track.album || 'Single'}`;
      renderCover('daily-brew-cover-container', track.cover, track.title, 'daily-brew-img');
      openBtn.style.display = track.spotifyUrl ? 'inline-flex' : 'none';
      if (track.spotifyUrl) openBtn.dataset.spotifyUrl = track.spotifyUrl;
      else delete openBtn.dataset.spotifyUrl;

      // Update Spotify contains liked tracks checks
      if (spotify.isAuthenticated && track.id && !track.id.toString().startsWith('local')) {
        const requestGeneration = ++likeCheckGeneration;
        const libraryItem = track.spotifyUri || track.id;
        likeBtn.setAttribute('data-library-item', libraryItem);
        spotify.checkLiked(libraryItem).then(liked => {
          if (requestGeneration === likeCheckGeneration && likeBtn.getAttribute('data-library-item') === String(libraryItem)) {
            likeBtn.textContent = liked ? 'UNLIKE' : 'LIKE';
          }
        }).catch(error => console.warn('Could not check saved-track state:', error));
      } else {
        likeBtn.textContent = 'LIKE';
        likeBtn.removeAttribute('data-library-item');
      }
    }
  }

  // Spotify Liking event listener
  document.getElementById('daily-brew-like-btn').addEventListener('click', async () => {
    const likeBtn = document.getElementById('daily-brew-like-btn');
    const libraryItem = likeBtn.getAttribute('data-library-item');
    if (!spotify.isAuthenticated) {
      alert('Please connect Spotify in Settings first to like tracks!');
      return;
    }
    if (!libraryItem) return;

    try {
      const isLiked = likeBtn.textContent === 'UNLIKE';
      if (isLiked) {
        await spotify.unlikeTrack(libraryItem);
        likeBtn.textContent = 'LIKE';
      } else {
        await spotify.likeTrack(libraryItem);
        likeBtn.textContent = 'UNLIKE';
      }
      renderer.invalidateLikedCache();
      if (renderer.currentTrackContext?.type === 'liked') {
        await renderer.renderLikedSongs();
      }
    } catch (e) {
      console.error(e);
    }
  });
  document.getElementById('daily-brew-open-btn').addEventListener('click', () => {
    const spotifyUrl = document.getElementById('daily-brew-open-btn').dataset.spotifyUrl;
    if (spotifyUrl) spotify.openExternal(spotifyUrl).catch(error => console.error(error));
  });

  // Upcoming Queue panel updater
  const queueBtn = document.getElementById('player-queue-btn');
  const queueOverlay = document.getElementById('queue-overlay');
  const queueListContainer = document.getElementById('queue-list-container');
  const queueCloseBtn = document.getElementById('queue-close-btn');
  let queueRenderGeneration = 0;

  function refreshOpenQueue() {
    if (queueOverlay.style.display === 'block') updateQueueOverlay();
  }

  window.addEventListener('cozy-queue-changed', refreshOpenQueue);

  function setQueueExpanded(expanded, returnFocus = false) {
    queueOverlay.style.display = expanded ? 'block' : 'none';
    queueBtn.setAttribute('aria-expanded', String(expanded));
    if (expanded) {
      updateQueueOverlay();
      queueOverlay.focus();
    } else if (returnFocus) {
      queueBtn.focus();
    }
  }

  queueBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const showing = queueOverlay.style.display === 'block';
    setQueueExpanded(!showing, showing);
  });
  queueCloseBtn.addEventListener('click', () => setQueueExpanded(false, true));

  // Close queue when clicking outside
  document.addEventListener('click', (e) => {
    if (queueOverlay.style.display === 'block' && !queueOverlay.contains(e.target) && e.target !== queueBtn) {
      setQueueExpanded(false);
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && queueOverlay.style.display === 'block') {
      event.preventDefault();
      setQueueExpanded(false, true);
    }
  });

  async function updateQueueOverlay() {
    const renderGeneration = ++queueRenderGeneration;
    queueListContainer.innerHTML = '';
    queueListContainer.setAttribute('aria-busy', 'true');
    for (let index = 0; index < 5; index += 1) {
      const skeleton = document.createElement('div');
      skeleton.className = 'skeleton skeleton-track-row';
      skeleton.setAttribute('aria-hidden', 'true');
      queueListContainer.appendChild(skeleton);
    }
    if (!spotify.isAuthenticated) {
      queueListContainer.textContent = 'Connect Spotify to view your queue.';
      queueListContainer.removeAttribute('aria-busy');
      return;
    }
    if (spotify.isExternalPlayback) {
      queueListContainer.textContent = 'Queue controls stay in the Spotify app or browser in this playback mode.';
      queueListContainer.removeAttribute('aria-busy');
      return;
    }

    try {
      const queueState = await spotify.getQueue();
      if (renderGeneration !== queueRenderGeneration || !spotify.isAuthenticated) return;
      const upcoming = Array.isArray(queueState?.queue) ? queueState.queue.slice(0, 20) : [];
      queueListContainer.innerHTML = '';
      queueListContainer.removeAttribute('aria-busy');
      if (upcoming.length === 0) {
        queueListContainer.textContent = 'Queue is empty';
        return;
      }

      upcoming.forEach(track => {
        const row = document.createElement('div');
        row.className = 'queue-track-row';
        const isEpisode = track.type === 'episode';
        if (!isEpisode) {
          row.tabIndex = 0;
          row.setAttribute('role', 'button');
        }

        const coverUrl = track.album?.images?.[0]?.url || track.images?.[0]?.url || track.show?.images?.[0]?.url;
        let safeCoverUrl = null;
        try {
          const parsedCover = new URL(coverUrl);
          if (parsedCover.protocol === 'https:') safeCoverUrl = parsedCover.toString();
        } catch {}
        if (safeCoverUrl) {
          const image = document.createElement('img');
          image.src = safeCoverUrl;
          image.alt = '';
          image.className = 'queue-track-art';
          row.appendChild(image);
        }

        const details = document.createElement('div');
        details.className = 'queue-track-details';
        const title = document.createElement('div');
        title.className = 'queue-track-title';
        title.textContent = track.name || 'Unknown Track';
        const artist = document.createElement('div');
        artist.className = 'queue-track-artist';
        artist.textContent = Array.isArray(track.artists)
          ? track.artists.map(item => item.name).join(', ')
          : track.show?.publisher || track.show?.name || 'Podcast episode';
        details.append(title, artist);
        row.appendChild(details);

        if (isEpisode) {
          const openButton = document.createElement('button');
          openButton.className = 'open-spotify-row-btn';
          openButton.textContent = 'OPEN IN SPOTIFY';
          openButton.addEventListener('click', () => {
            const spotifyUrl = track.external_urls?.spotify;
            if (spotifyUrl) spotify.openExternal(spotifyUrl).catch(error => console.error(error));
          });
          row.appendChild(openButton);
        } else {
            const playQueuedTrack = async () => {
              try {
              const result = await spotify.playTrack(track.uri);
              if (result?.external) return;
              handlePlaybackCommand(true);
            } catch (error) { console.error(error); }
          };
          row.addEventListener('click', playQueuedTrack);
          row.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              playQueuedTrack();
            }
          });
        }
        queueListContainer.appendChild(row);
      });
    } catch (error) {
      if (renderGeneration !== queueRenderGeneration) return;
      console.error('Could not load Spotify queue:', error);
      queueListContainer.textContent = 'Could not load the queue. Start playback and try again.';
      queueListContainer.removeAttribute('aria-busy');
    }
  }

  function updatePlayerBarUI(track, isPlaying) {
    if (!track) return;
    currentDisplayedTrack = track;
    document.getElementById('player-bar-title').textContent = track.title;
    document.getElementById('player-bar-artist').textContent = track.artist;
    renderCover('player-bar-art-container', track.cover, track.title, 'player-album-art');
    ui.updatePlayPauseButtonUI(isPlaying);
    syncSidePlayerSnapshot(true);
  }

  function updatePlayerView(track) {
    const viewTitle = document.getElementById('player-view-title');
    const viewArtist = document.getElementById('player-view-artist');

    if (track && viewTitle && viewArtist) {
      currentDisplayedTrack = track;
      renderCover('player-view-art-container', track.cover, track.title, 'player-large-art');
      viewTitle.textContent = track.title;
      viewArtist.textContent = `${track.artist} • ${track.album}`;
      lyricsController.setTrack(track);
    }
  }

  function resetPlayerDisplay() {
    currentDisplayedTrack = null;
    document.getElementById('player-bar-title').textContent = 'Track Title';
    document.getElementById('player-bar-artist').textContent = 'Artist';
    document.getElementById('player-view-title').textContent = 'Track Title';
    document.getElementById('player-view-artist').textContent = 'Artist Name • Album';
    document.getElementById('daily-brew-title').textContent = 'Awaiting Track';
    document.getElementById('daily-brew-desc').textContent = 'Connect Spotify in Settings and select a song to begin.';
    const likeButton = document.getElementById('daily-brew-like-btn');
    likeButton.textContent = 'LIKE';
    likeButton.removeAttribute('data-library-item');
    const openButton = document.getElementById('daily-brew-open-btn');
    openButton.style.display = 'none';
    delete openButton.dataset.spotifyUrl;
    renderCover('player-bar-art-container', null, 'Track', 'player-album-art');
    renderCover('player-view-art-container', null, 'Track', 'player-large-art');
    renderCover('daily-brew-cover-container', null, 'Track', 'daily-brew-img');
    lyricsController.setTrack(null);
    syncSidePlayerSnapshot(true);
  }

  // Click on player track info redirect to full Player view
  document.getElementById('player-track-info-trigger').addEventListener('click', () => {
    router.navigate('player');
  });
  document.getElementById('player-track-info-trigger').addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      router.navigate('player');
    }
  });

  // Home Play triggers
  document.getElementById('daily-brew-play-btn').addEventListener('click', async () => {
    if (!spotify.isAuthenticated) {
      router.navigate('settings');
      return;
    }
    try {
      let result;
      if (currentDisplayedTrack?.spotifyType === 'episode' && spotify.isExternalPlayback && currentDisplayedTrack.spotifyUrl) {
        await spotify.openExternal(currentDisplayedTrack.spotifyUrl);
        return;
      }
      const activeState = await spotify.getMyPlayerState().catch(() => null);
      const isCurrentItem = Boolean(
        activeState?.item?.uri &&
        currentDisplayedTrack?.spotifyUri &&
        activeState.item.uri === currentDisplayedTrack.spotifyUri
      );
      if (isCurrentItem || currentDisplayedTrack?.spotifyType === 'episode') {
        result = await spotify.resume();
      } else if (
        /^spotify:(playlist|album):/.test(currentDisplayedTrack?.playbackContextUri || '') &&
        currentDisplayedTrack?.spotifyUri
      ) {
        result = await spotify.playContext(currentDisplayedTrack.playbackContextUri, {
          uri: currentDisplayedTrack.spotifyUri
        });
      } else if (currentDisplayedTrack?.spotifyUri) {
        result = await spotify.playTrack(currentDisplayedTrack.spotifyUri);
      } else {
        result = await spotify.resume();
      }
      if (result?.external) return;
      handlePlaybackCommand(true);
    } catch (error) {
      console.error('Could not start playback:', error);
    }
  });

  document.getElementById('liked-play-all-btn').addEventListener('click', async () => {
    if (spotify.isAuthenticated) {
      const activeQueue = renderer.currentRenderedQueue;
      if (activeQueue && activeQueue.length > 0) {
        try {
          const contextUri = renderer.currentTrackContext?.contextUri || renderer.currentContextUri;
          if (/^spotify:(playlist|album):/.test(contextUri || '')) {
            const result = await spotify.playContext(contextUri);
            if (result?.external) {
              updatePlayerBarUI(activeQueue[0], false);
              updatePlayerView(activeQueue[0]);
              updateDailyBrewCard(activeQueue[0]);
              return;
            }
          } else {
            const uris = activeQueue.map(track => track.spotifyUri).filter(Boolean);
            if (uris.length > 100) {
              alert('Spotify limits Liked Songs playback requests to 100 tracks. Cozy-Fi will start the first 100 shown.');
            }
            const result = await spotify.playTracks(uris.slice(0, 100));
            if (result?.external) {
              updatePlayerBarUI(activeQueue[0], false);
              updatePlayerView(activeQueue[0]);
              updateDailyBrewCard(activeQueue[0]);
              return;
            }
          }
          updatePlayerBarUI(activeQueue[0], true);
          updatePlayerView(activeQueue[0]);
          updateDailyBrewCard(activeQueue[0]);
          handlePlaybackCommand(true);
        } catch (error) {
          console.error('Could not play this list:', error);
        }
      } else {
        const contextUri = renderer.currentTrackContext?.contextUri || renderer.currentContextUri;
        if (/^spotify:(playlist|album):/.test(contextUri || '')) {
          try {
            const result = await spotify.playContext(contextUri);
            if (result?.external) return;
            handlePlaybackCommand(true);
          } catch (error) {
            console.error('Could not play this Spotify context:', error);
          }
          return;
        }
        if (renderer.currentTrackContext?.type !== 'liked') {
          alert('This selection has no playable Spotify tracks.');
          return;
        }
        try {
          const liked = await spotify.getLikedTracks();
          if (liked.length > 0) {
            const firstTrack = liked[0];
            const displayTrack = {
              id: firstTrack.id,
              title: firstTrack.name || 'Unknown Track',
              artist: Array.isArray(firstTrack.artists) ? firstTrack.artists.map(artist => artist.name).join(', ') : 'Unknown Artist',
              album: firstTrack.album?.name || 'Single',
              cover: firstTrack.album?.images?.[0]?.url || null,
              durationMs: firstTrack.duration_ms || 0,
              spotifyUri: firstTrack.uri,
              spotifyUrl: firstTrack.external_urls?.spotify || null,
              spotifyType: firstTrack.type || 'track'
            };
            const likedUris = liked.map(track => track.uri).filter(Boolean);
            if (likedUris.length > 100) {
              alert('Spotify limits Liked Songs playback requests to 100 tracks. Cozy-Fi will start the first 100 shown.');
            }
            const result = await spotify.playTracks(likedUris.slice(0, 100));
            updatePlayerBarUI(displayTrack, !result?.external);
            updatePlayerView(displayTrack);
            updateDailyBrewCard(displayTrack);
            if (result?.external) return;
            handlePlaybackCommand(true);
          }
        } catch (err) {
          console.error(err);
        }
      }
    } else {
      router.navigate('settings');
    }
  });

  // Add New Playlist Button click handler
  document.getElementById('create-playlist-btn').addEventListener('click', async () => {
    if (!spotify.isAuthenticated) {
      alert('Please link your Spotify account in Settings to create playlists!');
      return;
    }
    const name = prompt('Enter a name for your new playlist:');
    if (!name) return;

    try {
      const newPl = await spotify.createPlaylist(null, name);
      if (newPl) {
        alert(`Playlist "${name}" created successfully!`);
        renderer.renderLibraryPlaylists(renderer.activeType);
      }
    } catch (e) {
      console.error(e);
      alert('Failed to create playlist.');
    }
  });
  document.getElementById('create-playlist-btn').addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.currentTarget.click();
    }
  });

  function updatePlaybackCapabilityUI(capability = {}) {
    const mode = capability.mode || 'disconnected';
    const statusEl = document.getElementById('playback-mode-status');
    if (playbackModeSelect && ['auto', 'standalone', 'external'].includes(capability.preference)) {
      playbackModeSelect.value = capability.preference;
    }

    const labels = {
      standalone: capability.tier === 'premium' ? 'PREMIUM • STANDALONE' : 'STANDALONE',
      external: capability.tier === 'free' ? 'FREE • SPOTIFY APP' : 'SPOTIFY APP',
      authorizing: 'AUTHORIZE',
      starting: 'CHECKING',
      unavailable: 'UNAVAILABLE',
      disconnected: 'NOT CONNECTED'
    };
    if (playbackCapabilityBadge) playbackCapabilityBadge.textContent = labels[mode] || 'CHECKING';

    const messages = {
      standalone: 'Standalone playback was verified. Audio plays inside Cozy-Fi, and Spotify can stay closed.',
      external: capability.tier === 'free'
        ? 'Spotify Premium is required for in-app streaming. Track and playlist actions will open Spotify; current Developer API access may also be unavailable to Free accounts.'
        : 'Track and playlist actions open in the Spotify app or browser. Transport and queue controls stay in Spotify.',
      authorizing: 'Complete the one-time local-player authorization. Spotify can stay closed after it succeeds.',
      starting: 'Auto is checking whether this account can register Cozy-Fi as a standalone Spotify Connect player.',
      unavailable: `${capability.reason || 'Standalone playback is unavailable.'} You can retry or choose Spotify app / browser mode.`,
      disconnected: 'Connect Spotify below. Auto will verify standalone capability because Development Mode no longer exposes subscription tier.'
    };
    if (statusEl) statusEl.textContent = messages[mode] || messages.starting;
    const connectionStatusEl = document.getElementById('spotify-connection-status');
    if (connectionStatusEl && spotify.isAuthenticated && !playbackAuthorizationPending) {
      connectionStatusEl.textContent = connectionStatusForCapability(capability);
    }

    const external = mode === 'external';
    const localReady = mode === 'standalone';
    const queueButton = document.getElementById('player-queue-btn');
    if (queueButton) {
      queueButton.disabled = !localReady;
      queueButton.title = external ? 'Queue controls are available in Spotify' : 'Queue';
    }
    document.getElementById('daily-brew-play-btn').textContent = external ? 'SPOTIFY' : 'LISTEN';
    document.getElementById('liked-play-all-btn').textContent = external ? 'SPOTIFY' : 'PLAY';
  }

  playbackModeSelect?.addEventListener('change', async () => {
    playbackModeSelect.disabled = true;
    try {
      const capability = await spotify.setPlaybackPreference(playbackModeSelect.value);
      updatePlaybackCapabilityUI(capability);
      showStatusBanner(capability.mode === 'external'
        ? 'Spotify App mode selected. Music links will open in Spotify.'
        : 'Playback mode updated. Cozy-Fi is checking standalone playback.');
    } catch (error) {
      showErrorBanner(error?.message || 'Could not change playback mode.');
    } finally {
      playbackModeSelect.disabled = false;
    }
  });

  // Spotify Auth binding
  const spotifyConnectBtn = document.getElementById('spotify-connect-btn');
  const spotifyClientIdInput = document.getElementById('spotify-client-id');
  let spotifyUiGeneration = 0;
  spotify.ready.then(() => {
    if (spotify.clientId) spotifyClientIdInput.value = spotify.clientId;
  });

  spotify.onError(message => {
    const statusEl = document.getElementById('spotify-connection-status');
    if (statusEl) statusEl.textContent = message;
    showErrorBanner(message);
  });

  spotifyConnectBtn.addEventListener('click', async () => {
    spotifyConnectBtn.disabled = true;
    try {
      if (spotify.isAuthenticated) {
        await spotify.logout();
      } else {
        const cid = spotifyClientIdInput.value.trim();
        if (!cid) {
          alert('Enter your Spotify Developer Client ID first.');
          return;
        }
        spotify.saveConfig(cid);
        await spotify.login();
        document.getElementById('spotify-connection-status').textContent = 'Complete sign-in in the Spotify window.';
      }
    } catch (error) {
      console.error('Spotify connection action failed:', error);
      document.getElementById('spotify-connection-status').textContent = error.message || 'Spotify connection failed.';
    } finally {
      spotifyConnectBtn.disabled = false;
    }
  });

  spotify.onAuthStatusChange((authed) => {
    renderer.clearCache();
    updateSpotifyUI(authed);
    renderer.renderAll().catch(error => console.error('Could not refresh the library:', error));
    searchManager.refresh().catch(error => console.error('Could not refresh Search:', error));
    if (authed) {
      schedulePlaybackPoll(500);
      refreshOpenQueue();
    } else {
      playbackAuthorizationPending = false;
      isSpotifyPlaying = false;
      lastSpotifyTrackId = null;
      queueRenderGeneration += 1;
      resetPlayerDisplay();
      updateTimelineUI(0, 0);
      ui.updatePlayPauseButtonUI(false);
      if (queueOverlay.style.display === 'block') updateQueueOverlay();
      schedulePlaybackPoll(5000);
    }
  });

  function updateSettingsConnectedUI(isConnected) {
    const avatarBox = document.getElementById('spotify-avatar-box');
    const nameEl = document.getElementById('spotify-user-name');
    const statusEl = document.getElementById('spotify-connection-status');
    const credsForm = document.getElementById('spotify-credentials-form');

    if (isConnected) {
      spotifyConnectBtn.textContent = 'DISCONNECT';
      credsForm.style.display = 'none';
      avatarBox.innerHTML = '<span>OK</span>';
      nameEl.textContent = 'Spotify Connected';
      statusEl.textContent = playbackAuthorizationPending
        ? playbackAuthorizationMessage
        : connectionStatusForCapability(spotify.playbackCapability);
    } else {
      spotifyConnectBtn.textContent = 'CONNECT';
      credsForm.style.display = 'flex';
      avatarBox.innerHTML = '<span>LINK</span>';
      nameEl.textContent = 'Link Spotify API';
      statusEl.textContent = 'Not connected. Add your Spotify Developer Client ID to begin.';
    }
  }

  function connectionStatusForCapability(capability = {}) {
    if (capability.mode === 'standalone') return 'Connected. Audio plays directly inside Cozy-Fi; Spotify can stay closed.';
    if (capability.mode === 'external') return 'Connected in Spotify App mode. Selected music opens in Spotify.';
    if (capability.mode === 'authorizing') return playbackAuthorizationMessage;
    if (capability.mode === 'unavailable') return capability.reason || 'Connected, but standalone playback is unavailable.';
    return 'Spotify connected. Cozy-Fi is checking standalone playback capability.';
  }

  async function updateSpotifyUI(authed) {
    const updateGeneration = ++spotifyUiGeneration;
    const avatarBox = document.getElementById('spotify-avatar-box');
    const nameEl = document.getElementById('spotify-user-name');
    const statusEl = document.getElementById('spotify-connection-status');

    const sidebarName = document.querySelector('.user-name');
    const sidebarTag = document.getElementById('cozy-mode-tag');
    const sidebarAvatar = document.querySelector('.user-avatar');

    updateSettingsConnectedUI(authed);

    if (authed) {
      try {
        const profile = await spotify.getProfile();
        if (updateGeneration !== spotifyUiGeneration || !spotify.isAuthenticated) return;
        if (profile) {
          const displayName = profile.display_name || 'Spotify Listener';
          nameEl.textContent = displayName;
          statusEl.textContent = playbackAuthorizationPending
            ? playbackAuthorizationMessage
            : connectionStatusForCapability(spotify.playbackCapability);

          sidebarName.textContent = displayName;
          sidebarTag.textContent = 'Spotify Connected';

          if (profile.images && profile.images.length > 0) {
            setAvatarImage(avatarBox, profile.images[0].url);
            setAvatarImage(sidebarAvatar, profile.images[0].url);
          } else {
            const firstChar = displayName.charAt(0).toUpperCase();
            sidebarAvatar.textContent = firstChar;
            avatarBox.innerHTML = `<span>${firstChar}</span>`;
          }
        }
      } catch (err) {
        if (updateGeneration !== spotifyUiGeneration || !spotify.isAuthenticated) return;
        // Safe default targets if fetch fails offline
        nameEl.textContent = 'Spotify Connected';
        statusEl.textContent = playbackAuthorizationPending
          ? playbackAuthorizationMessage
          : connectionStatusForCapability(spotify.playbackCapability);
      }
    } else {
      sidebarName.textContent = 'Listener One';
      sidebarTag.textContent = 'Coffee Mode';
      sidebarAvatar.textContent = 'U';
    }
  }

  function setAvatarImage(container, source) {
    container.innerHTML = '';
    const image = document.createElement('img');
    image.src = source;
    image.alt = '';
    image.style.width = '100%';
    image.style.height = '100%';
    image.style.objectFit = 'cover';
    image.style.borderRadius = '4px';
    container.appendChild(image);
  }

  function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

});
