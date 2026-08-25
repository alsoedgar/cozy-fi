// Cozy-Fi Desktop App Entry Point (Electron main process)
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, screen } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const librespotManifest = require('./librespot-checksums.json');
const { normalizeContextOffset } = require('./js/playback-context');
const {
  normalizeLyricsLookup,
  sanitizeLyricsRecord,
  buildLyricsSearchQueries,
  scoreLyricsCandidate,
  selectBestLyricsCandidate,
  finalizeLyricsMatch,
  createImportedLyricsRecord
} = require('./js/lyrics');

const SPOTIFY_API_BASE = 'https://api.spotify.com/';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const DEVICE_NAME = 'Cozy-Fi Player';
const MAX_LIBRARY_ITEMS = 500;
const PLAYBACK_PREFERENCES = new Set(['auto', 'standalone', 'external']);
const IS_SMOKE_TEST = process.argv.includes('--smoke-test');
const SMOKE_ARTWORK_URL = IS_SMOKE_TEST ? (process.env.COZY_SMOKE_ARTWORK_URL || '') : '';
const TRUSTED_RENDERER_URL = pathToFileURL(path.join(__dirname, 'index.html')).toString();
const TRUSTED_SIDE_PLAYER_URL = pathToFileURL(path.join(__dirname, 'mini-player.html')).toString();
const SIDE_PLAYER_MIN_WIDTH = 260;
const SIDE_PLAYER_MIN_HEIGHT = 420;
const SIDE_PLAYER_MAX_WIDTH = 700;
const SIDE_PLAYER_MAX_HEIGHT = 1000;
const SIDE_PLAYER_ARTWORK_MAX_BYTES = 3 * 1024 * 1024;
const SIDE_PLAYER_ARTWORK_CACHE_LIMIT = 16;
const LRCLIB_GET_URL = 'https://lrclib.net/api/get';
const LRCLIB_SEARCH_URL = 'https://lrclib.net/api/search';
const LRCLIB_CLIENT_HOMEPAGE = 'https://github.com/alsoedgar/cozy-fi';
const LRCLIB_MIN_REQUEST_INTERVAL_MS = 350;
const LRCLIB_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const LRCLIB_SEARCH_RESPONSE_MAX_BYTES = 6 * 1024 * 1024;
const LOCAL_LYRICS_MAX_BYTES = 256 * 1024;
const LOCAL_LYRICS_RECORD_MAX_BYTES = 1024 * 1024;
const LYRICS_CACHE_LIMIT = 100;

let mainWindow = null;
let sidePlayerWindow = null;
let sidePlayerReadyPromise = null;
let authWindow = null;
let playbackAuthWindow = null;
let playbackAuthProcess = null;
let authCallbackServer = null;
let authFlow = null;
let librespotProcess = null;
let librespotRestartTimer = null;
let librespotRestartAttempts = 0;
let activeLibrespotDeviceName = null;
let deviceSyncInterval = null;
let deviceHealthInterval = null;
let deviceSyncGeneration = 0;
let refreshPromise = null;
let authSessionGeneration = 0;

let accessToken = '';
let refreshToken = '';
let accessTokenExpiresAt = 0;
let clientId = '';
let deviceId = null;
let playbackPreference = 'auto';
let detectedSpotifyProduct = null;
let playbackCapabilityState = 'disconnected';
let playbackCapabilityReason = '';
let sidePlayerPinned = true;
let sidePlayerBounds = null;
let sidePlayerBoundsSaveTimer = null;
let sidePlayerTheme = { kind: 'preset', id: 'morning-lo-fi', fontSize: 'standard' };
let sidePlayerSnapshot = null;
let sidePlayerModeActive = false;
let sidePlayerResizeSession = null;
const sidePlayerArtworkCache = new Map();
const lyricsCache = new Map();
let lyricsRequestChain = Promise.resolve();
let lyricsLastRequestAt = 0;
let lyricsBlockedUntil = 0;

const configPath = path.join(app.getPath('userData'), 'cozy-fi-config.json');
const playbackCachePath = path.join(app.getPath('userData'), 'librespot');
const playbackCredentialsPath = path.join(playbackCachePath, 'credentials.json');
const localLyricsDirectory = path.join(app.getPath('userData'), 'lyrics');

app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function hasSecureCredentialStorage() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // Electron's Linux `basic_text` backend uses a hard-coded password and is
    // not meaningful protection. Keep sessions memory-only on those systems.
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[Config] Could not inspect OS credential storage:', error.message);
    return false;
  }
}

function encodeStoredSecret(value) {
  if (!value) return null;
  try {
    if (hasSecureCredentialStorage()) {
      return { protected: true, value: safeStorage.encryptString(value).toString('base64') };
    }
  } catch (error) {
    console.warn('[Config] OS credential encryption is unavailable:', error.message);
  }
  console.warn('[Config] Spotify session will remain memory-only because secure storage is unavailable.');
  return null;
}

function decodeStoredSecret(storedValue) {
  if (!storedValue) return '';
  if (typeof storedValue === 'string') return storedValue;
  if (typeof storedValue.value !== 'string') return '';
  if (!storedValue.protected) return storedValue.value;
  if (!hasSecureCredentialStorage()) {
    console.warn('[Config] The saved Spotify session cannot be unlocked securely on this system.');
    return '';
  }
  try {
    return safeStorage.decryptString(Buffer.from(storedValue.value, 'base64'));
  } catch (error) {
    console.warn('[Config] Could not decrypt the saved Spotify session:', error.message);
    return '';
  }
}

function loadConfig() {
  if (IS_SMOKE_TEST) return;
  try {
    if (!fs.existsSync(configPath)) return;
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    clientId = typeof data.clientId === 'string' ? data.clientId.trim() : '';
    refreshToken = decodeStoredSecret(data.refreshToken);
    playbackPreference = PLAYBACK_PREFERENCES.has(data.playbackPreference)
      ? data.playbackPreference
      : 'auto';
    sidePlayerPinned = data.sidePlayerPinned !== false;
    sidePlayerBounds = normalizeSidePlayerBounds(data.sidePlayerBounds);
    // Drop the original app's plain Client Secret and short-lived access token.
    if (data.clientSecret || data.accessToken || data.refreshToken?.protected === false) saveConfig();
  } catch (error) {
    console.error('[Config] Failed to load configuration:', error);
  }
}

function saveConfig() {
  if (IS_SMOKE_TEST) return;
  try {
    fs.writeFileSync(configPath, JSON.stringify({
      version: 4,
      clientId,
      playbackPreference,
      sidePlayerPinned,
      sidePlayerBounds,
      refreshToken: encodeStoredSecret(refreshToken)
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.error('[Config] Failed to save configuration:', error);
  }
}

function normalizeClientId(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9]{16,64}$/.test(normalized)) {
    throw new Error('Enter a valid Spotify Client ID.');
  }
  return normalized;
}

function normalizeSpotifyId(value, label = 'Spotify ID') {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9]{1,128}$/.test(normalized)) throw new Error(`Invalid ${label}.`);
  return normalized;
}

function normalizeSpotifyUri(value, allowedTypes = ['track', 'episode']) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const match = /^spotify:([a-z]+):([A-Za-z0-9]+)$/.exec(normalized);
  if (!match || !allowedTypes.includes(match[1])) throw new Error('Invalid Spotify URI.');
  return normalized;
}

function normalizeQuery(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error('Search query cannot be empty.');
  return normalized.slice(0, 200);
}

function normalizePlaybackPreference(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!PLAYBACK_PREFERENCES.has(normalized)) throw new Error('Invalid playback mode.');
  return normalized;
}

function normalizeSidePlayerBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(SIDE_PLAYER_MIN_WIDTH, Math.min(SIDE_PLAYER_MAX_WIDTH, Math.round(width))),
    height: Math.max(SIDE_PLAYER_MIN_HEIGHT, Math.min(SIDE_PLAYER_MAX_HEIGHT, Math.round(height)))
  };
}

function normalizeSidePlayerTheme(value) {
  const fontSize = value?.fontSize === 'enlarged' ? 'enlarged' : 'standard';
  if (['custom', 'cover'].includes(value?.kind) && value.colors && typeof value.colors === 'object') {
    const keys = [
      'bgPrimary', 'bgSecondary', 'bgCard', 'textPrimary',
      'textSecondary', 'accentColor', 'borderColor'
    ];
    const colors = {};
    for (const key of keys) {
      const color = typeof value.colors[key] === 'string' ? value.colors[key].trim().toLowerCase() : '';
      if (!/^#[0-9a-f]{6}$/.test(color)) throw new Error('Invalid side-player theme color.');
      colors[key] = color;
    }
    if (value.kind === 'cover') {
      const style = ['soft-gradient', 'vivid-gradient', 'solid'].includes(value.cover?.style)
        ? value.cover.style
        : 'soft-gradient';
      const cover = { style };
      for (const key of ['start', 'end', 'glow']) {
        const color = typeof value.cover?.[key] === 'string' ? value.cover[key].trim().toLowerCase() : '';
        if (!/^#[0-9a-f]{6}$/.test(color)) throw new Error('Invalid cover-match backdrop color.');
        cover[key] = color;
      }
      const options = {
        style,
        mood: ['auto', 'light', 'dark'].includes(value.options?.mood) ? value.options.mood : 'auto',
        intensity: Math.max(20, Math.min(100, Math.round(Number(value.options?.intensity) || 68)))
      };
      return { kind: 'cover', colors, cover, options, fontSize };
    }
    return { kind: 'custom', colors, fontSize };
  }
  return {
    kind: 'preset',
    id: value?.id === 'soft-sunset' ? 'soft-sunset' : 'morning-lo-fi',
    fontSize
  };
}

function normalizeSidePlayerSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const cleanText = (text, fallback, maxLength) => (
    typeof text === 'string' && text.trim() ? text.trim().slice(0, maxLength) : fallback
  );
  let track = null;
  if (value.track && typeof value.track === 'object') {
    const rawTrack = value.track;
    let cover = null;
    try {
      const url = new URL(rawTrack.cover);
      if (url.protocol === 'https:') cover = url.toString();
    } catch {}
    const spotifyUri = typeof rawTrack.spotifyUri === 'string' && /^spotify:(track|episode):[A-Za-z0-9]+$/.test(rawTrack.spotifyUri)
      ? rawTrack.spotifyUri
      : null;
    let spotifyUrl = null;
    try {
      spotifyUrl = normalizeSpotifyExternalUrl(rawTrack.spotifyUrl);
    } catch {}
    track = {
      title: cleanText(rawTrack.title, 'Unknown Track', 240),
      artist: cleanText(rawTrack.artist, 'Unknown Artist', 240),
      album: cleanText(rawTrack.album, 'Single', 240),
      cover,
      spotifyUri,
      spotifyUrl,
      spotifyType: rawTrack.spotifyType === 'episode' ? 'episode' : 'track'
    };
  }
  return {
    track,
    isPlaying: Boolean(value.isPlaying),
    positionMs: Math.max(0, Math.floor(Number(value.positionMs) || 0)),
    durationMs: Math.max(0, Math.floor(Number(value.durationMs) || 0)),
    loading: Boolean(value.loading)
  };
}

function isSameSidePlayerTrack(first, second) {
  if (!first || !second) return false;
  if (first.spotifyUri || second.spotifyUri) {
    return Boolean(first.spotifyUri && second.spotifyUri && first.spotifyUri === second.spotifyUri);
  }
  const normalize = value => typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
    : '';
  const firstTitle = normalize(first.title);
  return Boolean(
    firstTitle &&
    firstTitle === normalize(second.title) &&
    normalize(first.artist) === normalize(second.artist)
  );
}

function normalizeSpotifyArtworkUrl(value) {
  const artworkUrl = new URL(typeof value === 'string' ? value : '');
  const host = artworkUrl.hostname.toLowerCase();
  const trustedHost = host === 'i.scdn.co' || host.endsWith('.scdn.co') || host.endsWith('.spotifycdn.com');
  if (artworkUrl.protocol !== 'https:' || !trustedHost) {
    throw new Error('The requested artwork is not hosted by Spotify.');
  }
  return artworkUrl;
}

async function fetchSpotifyArtwork(rawUrl) {
  let artworkUrl = normalizeSpotifyArtworkUrl(rawUrl);
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const response = await fetch(artworkUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirectCount === 3) throw new Error('Spotify artwork redirected too many times.');
      artworkUrl = normalizeSpotifyArtworkUrl(new URL(location, artworkUrl).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Spotify artwork request failed (${response.status}).`);
    normalizeSpotifyArtworkUrl(response.url || artworkUrl.toString());
    const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']).has(contentType)) {
      throw new Error('Spotify returned an unsupported artwork format.');
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > SIDE_PLAYER_ARTWORK_MAX_BYTES) {
      throw new Error('Spotify artwork is too large.');
    }
    const artwork = Buffer.from(await response.arrayBuffer());
    if (!artwork.length || artwork.length > SIDE_PLAYER_ARTWORK_MAX_BYTES) {
      throw new Error('Spotify artwork is empty or too large.');
    }
    return `data:${contentType};base64,${artwork.toString('base64')}`;
  }
  throw new Error('Could not resolve Spotify artwork.');
}

async function resolveSidePlayerArtwork(rawUrl) {
  const artworkUrl = normalizeSpotifyArtworkUrl(rawUrl).toString();
  const cached = sidePlayerArtworkCache.get(artworkUrl);
  if (cached) {
    sidePlayerArtworkCache.delete(artworkUrl);
    sidePlayerArtworkCache.set(artworkUrl, cached);
    return cached;
  }
  const pending = fetchSpotifyArtwork(artworkUrl);
  sidePlayerArtworkCache.set(artworkUrl, pending);
  while (sidePlayerArtworkCache.size > SIDE_PLAYER_ARTWORK_CACHE_LIMIT) {
    sidePlayerArtworkCache.delete(sidePlayerArtworkCache.keys().next().value);
  }
  try {
    return await pending;
  } catch (error) {
    if (sidePlayerArtworkCache.get(artworkUrl) === pending) sidePlayerArtworkCache.delete(artworkUrl);
    throw error;
  }
}

function spotifyUriToExternalUrl(rawUri, allowedTypes = ['track', 'episode', 'playlist', 'album', 'artist', 'show']) {
  const spotifyUri = normalizeSpotifyUri(rawUri, allowedTypes);
  const [, type, id] = spotifyUri.split(':');
  return `https://open.spotify.com/${type}/${id}`;
}

async function openSpotifyUriExternally(rawUri, allowedTypes) {
  const spotifyUri = normalizeSpotifyUri(rawUri, allowedTypes);
  const url = spotifyUriToExternalUrl(spotifyUri, allowedTypes);
  try {
    // Prefer the installed Spotify client's registered URI handler. If it is
    // unavailable, fall back to the equivalent open.spotify.com page.
    await shell.openExternal(spotifyUri);
    return { external: true, url, target: 'spotify-app' };
  } catch (error) {
    console.warn('[Playback] Spotify desktop URI handler was unavailable:', error.message);
    await shell.openExternal(url);
    return { external: true, url, target: 'browser' };
  }
}

function getPlaybackCapability() {
  const connected = Boolean(accessToken || refreshToken);
  const forcedExternal = playbackPreference === 'external' || detectedSpotifyProduct === 'free';
  const mode = !connected
    ? 'disconnected'
    : forcedExternal || playbackCapabilityState === 'external'
      ? 'external'
      : deviceId
        ? 'standalone'
        : playbackCapabilityState === 'authorizing'
          ? 'authorizing'
          : playbackCapabilityState === 'starting'
            ? 'starting'
            : 'unavailable';
  const tier = detectedSpotifyProduct || (deviceId ? 'premium' : null);
  const detection = detectedSpotifyProduct
    ? 'profile'
    : deviceId
      ? 'capability'
      : 'unknown';

  return {
    preference: playbackPreference,
    mode,
    canPlayLocally: mode === 'standalone',
    opensSpotifyExternally: mode === 'external',
    tier,
    detection,
    reason: playbackCapabilityReason
  };
}

function publishPlaybackCapability() {
  sendToRenderer('spotify-playback-capability', getPlaybackCapability());
}

function setPlaybackCapability(state, reason = '') {
  playbackCapabilityState = state;
  playbackCapabilityReason = reason;
  publishPlaybackCapability();
}

function usesExternalPlayback() {
  return getPlaybackCapability().mode === 'external';
}

function normalizeSpotifyExternalUrl(value) {
  const url = new URL(typeof value === 'string' ? value : '');
  if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') {
    throw new Error('Invalid Spotify link.');
  }
  return url.toString();
}

function requirePlaybackDevice() {
  if (usesExternalPlayback()) {
    throw new Error('Playback is set to Spotify App mode. Use Spotify for transport controls.');
  }
  if (!deviceId) {
    if (!hasPlaybackCredentials()) {
      throw new Error('Finish the one-time Cozy-Fi Player authorization, then try again.');
    }
    throw new Error('Cozy-Fi Player is still starting. Wait a few seconds and try again.');
  }
  return deviceId;
}

function hasPlaybackCredentials() {
  try {
    if (!fs.existsSync(playbackCredentialsPath)) return false;
    const credentials = JSON.parse(fs.readFileSync(playbackCredentialsPath, 'utf8'));
    return Boolean(
      typeof credentials?.username === 'string' && credentials.username &&
      typeof credentials?.auth_data === 'string' && credentials.auth_data
    );
  } catch (error) {
    console.warn('[Playback] Ignoring an unreadable local-player credential cache:', error.message);
    return false;
  }
}

function preparePlaybackCache() {
  fs.mkdirSync(playbackCachePath, { recursive: true, mode: 0o700 });
}

function clearPlaybackCredentials() {
  try {
    fs.rmSync(playbackCredentialsPath, { force: true });
  } catch (error) {
    console.warn('[Playback] Could not clear the local-player credentials:', error.message);
  }
}

function clearPlaybackCache() {
  try {
    fs.rmSync(playbackCachePath, { recursive: true, force: true });
  } catch (error) {
    console.warn('[Playback] Could not clear the local-player cache:', error.message);
  }
}

function sendToRenderer(channel, payload) {
  const windows = [mainWindow, sidePlayerWindow].filter(Boolean);
  for (const window of new Set(windows)) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function getSidePlayerState() {
  return {
    visible: Boolean(sidePlayerWindow && !sidePlayerWindow.isDestroyed() && sidePlayerWindow.isVisible()),
    minimized: Boolean(sidePlayerWindow && !sidePlayerWindow.isDestroyed() && sidePlayerWindow.isMinimized()),
    compactMode: sidePlayerModeActive,
    pinned: sidePlayerPinned
  };
}

function publishSidePlayerState() {
  const state = getSidePlayerState();
  sendToRenderer('side-player-state', state);
  return state;
}

function fitSidePlayerBoundsToDisplay(rawBounds) {
  const fallbackWidth = 310;
  const fallbackHeight = 560;
  let candidate = normalizeSidePlayerBounds(rawBounds);
  if (!candidate) {
    const referenceBounds = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.getBounds()
      : { x: screen.getCursorScreenPoint().x, y: screen.getCursorScreenPoint().y, width: 1, height: 1 };
    const workArea = screen.getDisplayMatching(referenceBounds).workArea;
    candidate = {
      width: Math.min(fallbackWidth, workArea.width),
      height: Math.min(fallbackHeight, workArea.height),
      x: workArea.x + workArea.width - Math.min(fallbackWidth, workArea.width) - 20,
      y: workArea.y + 20
    };
  }
  const workArea = screen.getDisplayMatching(candidate).workArea;
  const width = Math.min(Math.max(SIDE_PLAYER_MIN_WIDTH, candidate.width), workArea.width);
  const height = Math.min(Math.max(SIDE_PLAYER_MIN_HEIGHT, candidate.height), workArea.height);
  return {
    width,
    height,
    x: Math.min(Math.max(candidate.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(candidate.y, workArea.y), workArea.y + workArea.height - height)
  };
}

function rememberSidePlayerBounds() {
  if (!sidePlayerWindow || sidePlayerWindow.isDestroyed() || sidePlayerWindow.isMinimized()) return;
  sidePlayerBounds = normalizeSidePlayerBounds(sidePlayerWindow.getBounds());
  clearTimeout(sidePlayerBoundsSaveTimer);
  sidePlayerBoundsSaveTimer = setTimeout(saveConfig, 350);
  sidePlayerBoundsSaveTimer.unref?.();
}

function resizeSidePlayerTo(rawWidth, rawHeight) {
  if (!sidePlayerWindow || sidePlayerWindow.isDestroyed()) return null;
  const current = sidePlayerWindow.getBounds();
  const workArea = screen.getDisplayMatching(current).workArea;
  const availableWidth = Math.max(SIDE_PLAYER_MIN_WIDTH, workArea.x + workArea.width - current.x);
  const availableHeight = Math.max(SIDE_PLAYER_MIN_HEIGHT, workArea.y + workArea.height - current.y);
  const width = Math.max(
    SIDE_PLAYER_MIN_WIDTH,
    Math.min(SIDE_PLAYER_MAX_WIDTH, availableWidth, Math.round(Number(rawWidth) || current.width))
  );
  const height = Math.max(
    SIDE_PLAYER_MIN_HEIGHT,
    Math.min(SIDE_PLAYER_MAX_HEIGHT, availableHeight, Math.round(Number(rawHeight) || current.height))
  );
  sidePlayerWindow.setBounds({ ...current, width, height });
  return { width, height };
}

function normalizeResizePoint(value) {
  const x = Number(value?.screenX);
  const y = Number(value?.screenY);
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100000 || Math.abs(y) > 100000) {
    throw new Error('Invalid resize position.');
  }
  return { x, y };
}

function ensureSidePlayerWindow() {
  if (sidePlayerWindow && !sidePlayerWindow.isDestroyed()) {
    return sidePlayerReadyPromise || Promise.resolve(sidePlayerWindow);
  }

  const createdWindow = new BrowserWindow({
    ...fitSidePlayerBoundsToDisplay(sidePlayerBounds),
    minWidth: SIDE_PLAYER_MIN_WIDTH,
    minHeight: SIDE_PLAYER_MIN_HEIGHT,
    maxWidth: SIDE_PLAYER_MAX_WIDTH,
    maxHeight: SIDE_PLAYER_MAX_HEIGHT,
    show: false,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: sidePlayerPinned,
    roundedCorners: true,
    autoHideMenuBar: true,
    title: 'Cozy-Fi Side Player',
    backgroundColor: '#f7f0e3',
    icon: path.join(__dirname, 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  sidePlayerWindow = createdWindow;
  installNavigationGuards(createdWindow, TRUSTED_SIDE_PLAYER_URL);
  createdWindow.on('show', publishSidePlayerState);
  createdWindow.on('hide', publishSidePlayerState);
  createdWindow.on('minimize', publishSidePlayerState);
  createdWindow.on('restore', publishSidePlayerState);
  createdWindow.on('move', rememberSidePlayerBounds);
  createdWindow.on('resize', rememberSidePlayerBounds);
  createdWindow.on('close', rememberSidePlayerBounds);
  createdWindow.on('closed', () => {
    const closedInCompactMode = sidePlayerModeActive;
    if (sidePlayerWindow === createdWindow) sidePlayerWindow = null;
    sidePlayerReadyPromise = null;
    sidePlayerResizeSession = null;
    sidePlayerModeActive = false;
    publishSidePlayerState();
    if (
      closedInCompactMode &&
      process.platform !== 'darwin' &&
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      mainWindow.close();
    }
  });
  createdWindow.webContents.on('did-finish-load', () => {
    if (createdWindow.isDestroyed()) return;
    createdWindow.webContents.send('side-player-theme', sidePlayerTheme);
    createdWindow.webContents.send('side-player-snapshot', sidePlayerSnapshot);
    createdWindow.webContents.send('spotify-playback-capability', getPlaybackCapability());
    createdWindow.webContents.send('side-player-state', getSidePlayerState());
  });

  const firstPaintPromise = new Promise(resolve => {
    const fallbackTimer = setTimeout(resolve, 1000);
    createdWindow.once('ready-to-show', () => {
      clearTimeout(fallbackTimer);
      resolve();
    });
  });
  sidePlayerReadyPromise = Promise.all([
    createdWindow.loadFile('mini-player.html'),
    firstPaintPromise
  ])
    .then(() => createdWindow)
    .catch(error => {
      if (!createdWindow.isDestroyed()) createdWindow.destroy();
      throw error;
    });
  return sidePlayerReadyPromise;
}

async function showSidePlayer() {
  sidePlayerModeActive = true;
  try {
    const window = await ensureSidePlayerWindow();
    if (window.isMinimized()) window.restore();
    window.show();
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide();
    window.focus();
    return publishSidePlayerState();
  } catch (error) {
    sidePlayerModeActive = false;
    throw error;
  }
}

function hideSidePlayer() {
  if (sidePlayerWindow && !sidePlayerWindow.isDestroyed()) {
    rememberSidePlayerBounds();
    sidePlayerWindow.minimize();
  }
  return publishSidePlayerState();
}

async function toggleSidePlayer() {
  if (sidePlayerModeActive) return openFullPlayer();
  return showSidePlayer();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openFullPlayer() {
  sidePlayerModeActive = false;
  sidePlayerResizeSession = null;
  if (sidePlayerWindow && !sidePlayerWindow.isDestroyed()) {
    rememberSidePlayerBounds();
    sidePlayerWindow.hide();
  }
  showMainWindow();
  publishSidePlayerState();
  return true;
}

function focusPreferredWindow() {
  if (sidePlayerModeActive) return showSidePlayer();
  showMainWindow();
  return true;
}

async function requestSpotifyToken(parameters, expectedGeneration) {
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(parameters)
  });
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`Spotify token request failed (${response.status}): ${detail}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  if (!data.access_token) throw new Error('Spotify did not return an access token.');
  if (expectedGeneration !== authSessionGeneration) {
    throw new Error('Spotify authentication was canceled.');
  }
  accessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000;
  if (data.refresh_token) refreshToken = data.refresh_token;
  saveConfig();
  return accessToken;
}

function exchangeCodeForToken(code, codeVerifier, expectedGeneration) {
  return requestSpotifyToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: codeVerifier
  }, expectedGeneration);
}

async function refreshAccessToken(force = false) {
  if (!refreshToken || !clientId) return false;
  if (!force && accessToken && Date.now() < accessTokenExpiresAt - 60_000) return true;
  if (refreshPromise) return refreshPromise;
  const refreshGeneration = authSessionGeneration;
  const currentRefreshPromise = (async () => {
    try {
      await requestSpotifyToken({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId
      }, refreshGeneration);
      return true;
    } catch (error) {
      console.error('[Auth] Spotify token refresh failed:', error.message);
      if (
        (error.status === 400 || error.status === 401) &&
        refreshGeneration === authSessionGeneration
      ) {
        logoutSession();
        sendToRenderer('spotify-connection-error', 'Your saved Spotify session expired. Connect Spotify again.');
      }
      return false;
    } finally {
      if (refreshPromise === currentRefreshPromise) refreshPromise = null;
    }
  })();
  refreshPromise = currentRefreshPromise;
  return currentRefreshPromise;
}

async function ensureAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt - 60_000) return true;
  return refreshAccessToken(true);
}

async function parseSpotifyResponse(response, method) {
  if (response.status === 204) return method === 'GET' ? null : true;
  const text = await response.text();
  if (!text) return true;
  if (!(response.headers.get('content-type') || '').includes('application/json')) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fetchWebApi(endpoint, method = 'GET', body = null) {
  const requestGeneration = authSessionGeneration;
  if (!(await ensureAccessToken()) || requestGeneration !== authSessionGeneration) {
    throw new Error('The Spotify session changed before the request started.');
  }
  const url = endpoint.startsWith('https://')
    ? endpoint
    : new URL(endpoint.replace(/^\/+/, ''), SPOTIFY_API_BASE).toString();
  if (!url.startsWith(SPOTIFY_API_BASE)) throw new Error('Blocked non-Spotify API request.');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (requestGeneration !== authSessionGeneration) throw new Error('The Spotify session changed during the request.');
    const tokenForAttempt = accessToken;
    const headers = { Authorization: `Bearer ${tokenForAttempt}` };
    const options = { method, headers };
    if (body !== null && body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      if (requestGeneration !== authSessionGeneration) throw new Error('The Spotify session changed during the request.');
      const transportRetryIsSafe = ['GET', 'HEAD', 'PUT', 'DELETE'].includes(method);
      if (attempt < 2 && transportRetryIsSafe) continue;
      throw new Error(`Could not reach Spotify: ${error.message}`);
    }
    if (requestGeneration !== authSessionGeneration) throw new Error('The Spotify session changed during the request.');
    if (response.status === 401 && attempt === 0 && refreshToken) {
      if (await refreshAccessToken(true)) {
        if (requestGeneration !== authSessionGeneration) throw new Error('The Spotify session changed during the request.');
        continue;
      }
    }
    if (response.status === 429 && attempt < 2) {
      const retryAfter = Math.max(1, Number.parseInt(response.headers.get('retry-after'), 10) || 2);
      sendToRenderer('spotify-rate-limit', { retryAfter });
      if (retryAfter > 30) throw new Error(`Spotify rate limit active. Try again in ${retryAfter} seconds.`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      if (requestGeneration !== authSessionGeneration) throw new Error('The Spotify session changed during the request.');
      continue;
    }
    if (!response.ok) {
      const detail = await parseSpotifyResponse(response, method);
      const message = typeof detail === 'string' ? detail : detail?.error?.message || JSON.stringify(detail);
      const error = new Error(`Spotify API ${response.status}: ${message}`);
      error.status = response.status;
      if (
        (response.status === 403 || response.status === 404) &&
        new URL(url).searchParams.has('device_id')
      ) {
        invalidatePlaybackDevice();
      }
      throw error;
    }
    const result = await parseSpotifyResponse(response, method);
    if (requestGeneration !== authSessionGeneration) throw new Error('The Spotify session changed during the request.');
    return result;
  }
  throw new Error('Spotify request failed after retrying.');
}

async function fetchAllPages(endpoint, getItems, maximum = MAX_LIBRARY_ITEMS) {
  const results = [];
  let next = endpoint;
  while (next && results.length < maximum) {
    const page = await fetchWebApi(next);
    const items = getItems(page);
    if (Array.isArray(items)) results.push(...items);
    next = typeof page?.next === 'string' && page.next.startsWith(SPOTIFY_API_BASE) ? page.next : null;
  }
  return results.slice(0, maximum);
}

function parseRetryAfterSeconds(value) {
  const numeric = Number.parseInt(value, 10);
  if (Number.isFinite(numeric) && numeric > 0) return Math.min(3600, numeric);
  const retryDate = Date.parse(value || '');
  if (Number.isFinite(retryDate)) return Math.min(3600, Math.max(1, Math.ceil((retryDate - Date.now()) / 1000)));
  return 30;
}

async function readLimitedResponseText(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('LRCLIB returned an unexpectedly large response.');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
      throw new Error('LRCLIB returned an unexpectedly large response.');
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('LRCLIB returned an unexpectedly large response.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, receivedBytes).toString('utf8');
}

async function fetchLrclibJson(url, maximumBytes = LRCLIB_RESPONSE_MAX_BYTES) {
  if (!(url instanceof URL) || url.origin !== 'https://lrclib.net') {
    throw new Error('Blocked an unexpected lyrics service URL.');
  }
  if (Date.now() < lyricsBlockedUntil) {
    return {
      status: 'rate_limited',
      retryAfter: Math.max(1, Math.ceil((lyricsBlockedUntil - Date.now()) / 1000))
    };
  }
  const requestDelay = Math.max(0, LRCLIB_MIN_REQUEST_INTERVAL_MS - (Date.now() - lyricsLastRequestAt));
  if (requestDelay > 0) await new Promise(resolve => setTimeout(resolve, requestDelay));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  timeout.unref?.();
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': `Cozy-Fi/${app.getVersion()} (${LRCLIB_CLIENT_HOMEPAGE})`
      },
      redirect: 'error',
      signal: controller.signal
    });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return { status: 'not_found' };
    }
    if (response.status === 429) {
      const retryAfter = parseRetryAfterSeconds(response.headers.get('retry-after'));
      lyricsBlockedUntil = Date.now() + (retryAfter * 1000);
      await response.body?.cancel().catch(() => undefined);
      return { status: 'rate_limited', retryAfter };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`LRCLIB returned HTTP ${response.status}.`);
    }
    const text = await readLimitedResponseText(response, maximumBytes);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('LRCLIB returned an unreadable response.');
    }
    return { status: 'found', data };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('The LRCLIB lyrics request timed out.');
    if (/^(?:The )?LRCLIB\b/.test(error?.message || '')) throw error;
    throw new Error(`Could not reach LRCLIB: ${error?.message || 'network error'}`);
  } finally {
    clearTimeout(timeout);
    lyricsLastRequestAt = Date.now();
  }
}

function rememberLyrics(cacheKey, value, lifetimeMs) {
  if (lyricsCache.has(cacheKey)) lyricsCache.delete(cacheKey);
  while (lyricsCache.size >= LYRICS_CACHE_LIMIT) lyricsCache.delete(lyricsCache.keys().next().value);
  lyricsCache.set(cacheKey, { value, expiresAt: Date.now() + lifetimeMs });
  return value;
}

function localLyricsPath(cacheKey) {
  const digest = crypto.createHash('sha256').update(cacheKey).digest('hex');
  return path.join(localLyricsDirectory, `${digest}.json`);
}

async function readLocalLyrics(lookup) {
  try {
    const recordPath = localLyricsPath(lookup.cacheKey);
    const fileInfo = await fs.promises.stat(recordPath);
    if (!fileInfo.isFile() || fileInfo.size > LOCAL_LYRICS_RECORD_MAX_BYTES) return null;
    const raw = await fs.promises.readFile(recordPath, 'utf8');
    const stored = JSON.parse(raw);
    if (stored?.version !== 1 || stored?.cacheKey !== lookup.cacheKey) return null;
    const record = sanitizeLyricsRecord(stored.record);
    if (!record.instrumental && !record.plainLyrics && !record.syncedLyrics) return null;
    return {
      found: true,
      ...record,
      source: 'local',
      matchType: 'local',
      matchScore: 1
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[Lyrics] Could not read a local lyrics override:', error.message);
    return null;
  }
}

async function writeLocalLyrics(lookup, record) {
  await fs.promises.mkdir(localLyricsDirectory, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({
    version: 1,
    cacheKey: lookup.cacheKey,
    record: sanitizeLyricsRecord(record)
  });
  await fs.promises.writeFile(localLyricsPath(lookup.cacheKey), payload, { encoding: 'utf8', mode: 0o600 });
}

async function removeLocalLyrics(lookup) {
  await fs.promises.rm(localLyricsPath(lookup.cacheKey), { force: true });
  lyricsCache.delete(lookup.cacheKey);
}

function publishLocalLyricsUpdate(sender, lookup, action) {
  const payload = { cacheKey: lookup.cacheKey, action };
  const windows = [mainWindow, sidePlayerWindow].filter(Boolean);
  for (const window of new Set(windows)) {
    if (!window.isDestroyed() && window.webContents !== sender) {
      window.webContents.send('lyrics-local-updated', payload);
    }
  }
}

async function importLocalLyrics(event, rawTrack) {
  const lookup = normalizeLyricsLookup(rawTrack);
  if (IS_SMOKE_TEST) {
    return createImportedLyricsRecord(rawTrack, '[00:01.00] Local smoke lyric\n[00:04.00] Still stored on this device', 'smoke.lrc');
  }

  const parentWindow = BrowserWindow.fromWebContents(event.sender);
  const existing = await readLocalLyrics(lookup);
  if (existing) {
    const choice = await dialog.showMessageBox(parentWindow, {
      type: 'question',
      title: 'Local lyrics',
      message: `Local lyrics are already saved for “${lookup.trackName}”.`,
      detail: 'Replace the saved file, or remove it and return to LRCLIB matching.',
      buttons: ['Replace file', 'Use LRCLIB instead', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (choice.response === 2) return { canceled: true };
    if (choice.response === 1) {
      await removeLocalLyrics(lookup);
      publishLocalLyricsUpdate(event.sender, lookup, 'removed');
      return { removed: true, cacheKey: lookup.cacheKey };
    }
  }

  const selection = await dialog.showOpenDialog(parentWindow, {
    title: `Choose lyrics for ${lookup.trackName}`,
    properties: ['openFile'],
    filters: [
      { name: 'Lyrics files', extensions: ['lrc', 'txt'] },
      { name: 'LRC synced lyrics', extensions: ['lrc'] },
      { name: 'Plain text lyrics', extensions: ['txt'] }
    ]
  });
  if (selection.canceled || !selection.filePaths?.[0]) return { canceled: true };

  const selectedPath = path.resolve(selection.filePaths[0]);
  if (!/\.(?:lrc|txt)$/i.test(selectedPath)) throw new Error('Choose a .lrc or .txt lyrics file.');
  const fileInfo = await fs.promises.stat(selectedPath);
  if (!fileInfo.isFile()) throw new Error('The selected lyrics path is not a regular file.');
  if (fileInfo.size > LOCAL_LYRICS_MAX_BYTES) throw new Error('Lyrics files must be 256 KB or smaller.');
  const text = await fs.promises.readFile(selectedPath, 'utf8');
  const record = createImportedLyricsRecord(rawTrack, text, path.basename(selectedPath));
  await writeLocalLyrics(lookup, record);
  lyricsCache.delete(lookup.cacheKey);
  publishLocalLyricsUpdate(event.sender, lookup, 'imported');
  return record;
}

async function getLyricsForTrack(rawTrack, force = false) {
  const lookup = normalizeLyricsLookup(rawTrack);
  if (IS_SMOKE_TEST) {
    return {
      found: true,
      ...sanitizeLyricsRecord({
        id: 1,
        trackName: lookup.trackName,
        artistName: lookup.artistName,
        albumName: lookup.albumName,
        duration: lookup.durationSeconds || 180,
        plainLyrics: 'Steam curls over the morning light\nA quiet song is brewing',
        syncedLyrics: '[00:01.00] Steam curls over the morning light\n[00:04.50] A quiet song is brewing',
        source: 'lrclib',
        matchType: 'exact',
        matchScore: 1
      })
    };
  }
  const localRecord = await readLocalLyrics(lookup);
  if (localRecord) return localRecord;
  const cached = lyricsCache.get(lookup.cacheKey);
  if (cached && cached.expiresAt > Date.now() && !force) {
    lyricsCache.delete(lookup.cacheKey);
    lyricsCache.set(lookup.cacheKey, cached);
    return cached.value;
  }
  if (cached) lyricsCache.delete(lookup.cacheKey);

  const exactUrl = new URL(LRCLIB_GET_URL);
  exactUrl.searchParams.set('track_name', lookup.trackName);
  exactUrl.searchParams.set('artist_name', lookup.artistName);
  if (lookup.albumName) exactUrl.searchParams.set('album_name', lookup.albumName);
  if (lookup.durationSeconds) exactUrl.searchParams.set('duration', String(lookup.durationSeconds));
  const exactResponse = await fetchLrclibJson(exactUrl);
  if (exactResponse.status === 'rate_limited') {
    return { found: false, status: 'rate_limited', retryAfter: exactResponse.retryAfter };
  }

  let best = exactResponse.status === 'found' ? scoreLyricsCandidate(lookup, exactResponse.data) : null;
  let bestMatchType = 'exact';
  if (best?.score >= 0.94) {
    return rememberLyrics(lookup.cacheKey, finalizeLyricsMatch(lookup, best, 'exact'), 60 * 60 * 1000);
  }

  let lastSearchError = null;
  let completedSearches = 0;
  for (const query of buildLyricsSearchQueries(lookup)) {
    const searchUrl = new URL(LRCLIB_SEARCH_URL);
    if (query.q) searchUrl.searchParams.set('q', query.q);
    else {
      searchUrl.searchParams.set('track_name', query.trackName);
      searchUrl.searchParams.set('artist_name', query.artistName);
    }
    let searchResponse;
    try {
      searchResponse = await fetchLrclibJson(searchUrl, LRCLIB_SEARCH_RESPONSE_MAX_BYTES);
    } catch (error) {
      lastSearchError = error;
      continue;
    }
    if (searchResponse.status === 'rate_limited') {
      if (!best) return { found: false, status: 'rate_limited', retryAfter: searchResponse.retryAfter };
      break;
    }
    completedSearches += 1;
    const searchBest = selectBestLyricsCandidate(lookup, searchResponse.data);
    if (searchBest && (!best || searchBest.score > best.score)) {
      best = searchBest;
      bestMatchType = 'expanded';
    }
    if (best?.score >= 0.94) break;
  }

  if (best) {
    return rememberLyrics(
      lookup.cacheKey,
      finalizeLyricsMatch(lookup, best, bestMatchType),
      60 * 60 * 1000
    );
  }
  if (lastSearchError && completedSearches === 0) throw lastSearchError;
  return rememberLyrics(lookup.cacheKey, { found: false, status: 'not_found' }, 5 * 60 * 1000);
}

function queueLyricsLookup(operation) {
  const result = lyricsRequestChain.then(operation, operation);
  lyricsRequestChain = result.catch(() => undefined);
  return result;
}

function closeAuthResources() {
  if (authFlow && !authFlow.completed && !authFlow.canceled) {
    authFlow.canceled = true;
    authSessionGeneration += 1;
  }
  if (authCallbackServer) {
    if (authCallbackServer.listening) authCallbackServer.close();
    authCallbackServer = null;
  }
  if (authWindow && !authWindow.isDestroyed()) authWindow.destroy();
  authWindow = null;
  authFlow = null;
}

function isAllowedPlaybackAuthNavigation(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' && url.hostname === 'accounts.spotify.com') ||
      (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '5588' && url.pathname === '/login')
    );
  } catch {
    return false;
  }
}

function closePlaybackAuthWindow(completed = true) {
  const windowToClose = playbackAuthWindow;
  if (!windowToClose) return;
  if (completed) windowToClose.cozyAuthorizationComplete = true;
  playbackAuthWindow = null;
  playbackAuthProcess = null;
  if (!windowToClose.isDestroyed()) windowToClose.destroy();
}

async function openPlaybackAuthWindow(rawUrl, expectedProcess) {
  if (librespotProcess !== expectedProcess) return;
  let authUrl;
  try {
    authUrl = new URL(rawUrl);
  } catch {
    throw new Error('The local player returned an invalid authorization URL.');
  }
  if (authUrl.protocol !== 'https:' || authUrl.hostname !== 'accounts.spotify.com' || authUrl.pathname !== '/authorize') {
    throw new Error('The local player returned an untrusted authorization URL.');
  }

  closePlaybackAuthWindow(true);
  const windowToOpen = new BrowserWindow({
    width: 600,
    height: 800,
    show: true,
    parent: mainWindow || undefined,
    modal: Boolean(mainWindow),
    icon: path.join(__dirname, 'logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: 'spotify-auth'
    }
  });
  playbackAuthWindow = windowToOpen;
  playbackAuthProcess = expectedProcess;
  windowToOpen.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedPlaybackAuthNavigation(url)) event.preventDefault();
  });
  windowToOpen.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowToOpen.webContents.on('did-finish-load', () => {
    const currentUrl = windowToOpen.webContents.getURL();
    if (currentUrl.startsWith('http://127.0.0.1:5588/login')) {
      windowToOpen.cozyAuthorizationComplete = true;
      setTimeout(() => {
        if (playbackAuthWindow === windowToOpen) closePlaybackAuthWindow(true);
      }, 750).unref();
    }
  });
  windowToOpen.on('closed', () => {
    const userCanceled = (
      !windowToOpen.cozyAuthorizationComplete &&
      playbackAuthWindow === windowToOpen &&
      playbackAuthProcess === expectedProcess &&
      librespotProcess === expectedProcess
    );
    if (playbackAuthWindow === windowToOpen) playbackAuthWindow = null;
    if (playbackAuthProcess === expectedProcess) playbackAuthProcess = null;
    if (userCanceled) {
      expectedProcess.cozyAuthorizationCanceled = true;
      sendToRenderer('spotify-playback-error', 'Cozy-Fi Player authorization was canceled. Disconnect and reconnect Spotify to try again.');
      terminateLibrespotProcess(expectedProcess);
    }
  });
  await windowToOpen.loadURL(authUrl.toString());
}

function renderAuthResult(response, statusCode, title, message) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
  });
  response.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:3rem;background:#f7f0e3;color:#3c2f2f"><h1>${title}</h1><p>${message}</p></body>`);
}

async function startSpotifyLogin(rawClientId) {
  if (authFlow) throw new Error('A Spotify sign-in is already in progress.');
  const nextClientId = normalizeClientId(rawClientId);
  if (clientId && nextClientId !== clientId) {
    accessToken = '';
    refreshToken = '';
    accessTokenExpiresAt = 0;
    detectedSpotifyProduct = null;
  }
  clientId = nextClientId;
  saveConfig();
  const flowGeneration = ++authSessionGeneration;

  const codeVerifier = crypto.randomBytes(64).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(24).toString('base64url');
  authFlow = { codeVerifier, state, completed: false, canceled: false, generation: flowGeneration };
  const scopes = [
    'streaming', 'user-read-private', 'user-modify-playback-state',
    'user-read-playback-state', 'user-read-currently-playing',
    'user-read-recently-played', 'user-library-read', 'user-library-modify',
    'playlist-read-private', 'playlist-read-collaborative',
    'playlist-modify-private', 'playlist-modify-public',
    'user-follow-read', 'user-top-read'
  ];
  const authUrl = new URL(SPOTIFY_AUTHORIZE_URL);
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: scopes.join(' '),
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    state,
    show_dialog: 'true'
  }).toString();

  await new Promise((resolve, reject) => {
    authCallbackServer = http.createServer(async (request, response) => {
      const callbackUrl = new URL(request.url, REDIRECT_URI);
      if (callbackUrl.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }
      if (!authFlow || callbackUrl.searchParams.get('state') !== authFlow.state) {
        renderAuthResult(response, 400, 'Connection blocked', 'The Spotify sign-in state did not match. Return to Cozy-Fi and try again.');
        sendToRenderer('spotify-connection-error', 'Spotify sign-in state validation failed.');
        setTimeout(closeAuthResources, 250);
        return;
      }
      const spotifyError = callbackUrl.searchParams.get('error');
      const code = callbackUrl.searchParams.get('code');
      if (spotifyError || !code) {
        renderAuthResult(response, 400, 'Connection canceled', 'Spotify did not authorize this connection. You can close this window.');
        sendToRenderer('spotify-connection-error', spotifyError || 'Spotify did not return an authorization code.');
        setTimeout(closeAuthResources, 250);
        return;
      }
      try {
        const completingFlow = authFlow;
        await exchangeCodeForToken(code, completingFlow.codeVerifier, completingFlow.generation);
        if (authFlow !== completingFlow || completingFlow.canceled || completingFlow.generation !== authSessionGeneration) {
          throw new Error('Spotify sign-in was canceled.');
        }
        completingFlow.completed = true;
        renderAuthResult(response, 200, 'Spotify connected', 'Your account is connected. You can return to Cozy-Fi.');
        sendToRenderer('spotify-connection-success', { isConnected: true });
        librespotRestartAttempts = 0;
        await configurePlaybackForAccount();
      } catch (error) {
        console.error('[Auth] Code exchange failed:', error);
        renderAuthResult(response, 500, 'Connection failed', 'Cozy-Fi could not finish connecting. Return to the app and try again.');
        sendToRenderer('spotify-connection-error', error.message);
      } finally {
        setTimeout(closeAuthResources, 500);
      }
    });
    authCallbackServer.once('error', error => {
      closeAuthResources();
      reject(new Error(`Could not open ${REDIRECT_URI}. Close any app using port 8888 and try again. (${error.message})`));
    });
    authCallbackServer.listen(8888, '127.0.0.1', resolve);
  });

  authWindow = new BrowserWindow({
    width: 600,
    height: 800,
    show: true,
    parent: mainWindow || undefined,
    modal: Boolean(mainWindow),
    icon: path.join(__dirname, 'logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: 'spotify-auth'
    }
  });
  authWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  authWindow.on('closed', () => {
    const closingFlow = authFlow;
    const completed = closingFlow?.completed;
    if (!completed && closingFlow && !closingFlow.canceled) {
      closingFlow.canceled = true;
      authSessionGeneration += 1;
      sendToRenderer('spotify-connection-error', 'Spotify sign-in was canceled.');
    }
    if (authCallbackServer?.listening) authCallbackServer.close();
    authCallbackServer = null;
    authWindow = null;
    authFlow = null;
  });
  try {
    await authWindow.loadURL(authUrl.toString());
    return { started: true };
  } catch (error) {
    closeAuthResources();
    throw new Error(`Could not open Spotify sign-in: ${error.message}`);
  }
}

function resolveLibrespotPath() {
  const targetKey = `${process.platform}-${process.arch}`;
  const binaryName = process.platform === 'win32' ? 'librespot.exe' : 'librespot';
  const candidates = [
    path.join(process.resourcesPath, 'app.asar.unpacked', binaryName),
    path.join(__dirname, binaryName),
    path.join(__dirname, 'bin', targetKey, binaryName)
  ];
  const binaryPath = candidates.find(candidate => fs.existsSync(candidate));
  if (!binaryPath) {
    throw new Error(`The Cozy-Fi playback engine for ${targetKey} is missing. Rebuild this platform's package or choose Spotify App mode.`);
  }
  if (process.platform !== 'win32') {
    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
    } catch {
      throw new Error(`The Cozy-Fi playback engine for ${targetKey} is not executable.`);
    }
  }
  const expectedChecksum = librespotManifest?.targets?.[targetKey];
  if (!/^[A-F0-9]{64}$/.test(expectedChecksum || '')) {
    throw new Error(`No audited playback-engine checksum is registered for ${targetKey}. Run npm run build:librespot on that platform.`);
  }
  const actualChecksum = crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex').toUpperCase();
  if (actualChecksum !== expectedChecksum) {
    throw new Error('The bundled librespot playback executable failed its integrity check.');
  }
  return binaryPath;
}

async function configurePlaybackForAccount() {
  if (!accessToken) {
    setPlaybackCapability('disconnected');
    return false;
  }

  if (playbackPreference === 'external') {
    deviceId = null;
    stopDeviceSync();
    killLibrespot();
    setPlaybackCapability('external', 'Spotify App mode was selected in Settings.');
    return true;
  }

  // Spotify removed `product` from GET /me for Development Mode in 2026.
  // Older/Extended Quota responses may still include it, so use it when
  // present and otherwise verify Premium capability by registering the local
  // Connect device.
  try {
    const profile = await fetchWebApi('v1/me');
    const product = typeof profile?.product === 'string' ? profile.product.toLowerCase() : '';
    detectedSpotifyProduct = product === 'open' ? 'free' : (['free', 'premium'].includes(product) ? product : null);
  } catch (error) {
    detectedSpotifyProduct = null;
    console.warn('[Playback] Account tier was not available; continuing with capability detection:', error.message);
  }

  if (detectedSpotifyProduct === 'free') {
    deviceId = null;
    stopDeviceSync();
    killLibrespot();
    setPlaybackCapability('external', 'Spotify reported a Free account; in-app streaming requires Premium.');
    return true;
  }

  setPlaybackCapability('starting', 'Checking whether standalone playback is available.');
  return spawnLibrespot();
}

function spawnLibrespot() {
  if (librespotRestartTimer) {
    clearTimeout(librespotRestartTimer);
    librespotRestartTimer = null;
  }
  deviceId = null;
  if (!accessToken) {
    setPlaybackCapability('disconnected');
    return false;
  }
  if (playbackPreference === 'external' || detectedSpotifyProduct === 'free') {
    setPlaybackCapability('external', 'Playback will open in Spotify.');
    return false;
  }
  setPlaybackCapability('starting', 'Starting the Cozy-Fi local player.');

  // Never launch two same-named Connect devices at once. If a previous child is
  // still exiting, finish that shutdown and start the replacement afterwards.
  if (librespotProcess) {
    const previousProcess = librespotProcess;
    librespotProcess = null;
    activeLibrespotDeviceName = null;
    stopDeviceSync();
    sendToRenderer('spotify-device-not-ready');
    previousProcess.once('close', () => {
      if (accessToken && !usesExternalPlayback() && !librespotProcess) spawnLibrespot();
    });
    terminateLibrespotProcess(previousProcess);
    return true;
  }

  let binaryPath;
  try {
    binaryPath = resolveLibrespotPath();
    preparePlaybackCache();
  } catch (error) {
    console.error('[Playback] Refusing to launch:', error.message);
    sendToRenderer('spotify-playback-error', error.message);
    setPlaybackCapability('unavailable', error.message);
    return false;
  }
  // A per-child name prevents selecting another or stale Connect device that
  // happens to use the public Cozy-Fi label.
  const childDeviceName = `${DEVICE_NAME} ${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  activeLibrespotDeviceName = childDeviceName;
  const usedCachedCredentials = hasPlaybackCredentials();
  if (!usedCachedCredentials) clearPlaybackCredentials();
  const args = [
    '--name', childDeviceName,
    '--bitrate', '320',
    '--disable-audio-cache',
    '--system-cache', playbackCachePath,
    '--disable-discovery'
  ];
  if (!usedCachedCredentials) args.push('--enable-oauth');
  console.log(`[Playback] Starting ${DEVICE_NAME}${usedCachedCredentials ? ' with saved local credentials' : ' in one-time authorization mode'}.`);
  if (!usedCachedCredentials) {
    setPlaybackCapability('authorizing', 'Complete the one-time local-player authorization.');
    sendToRenderer('spotify-playback-auth-required', {
      message: 'Complete the one-time local-player authorization in the Cozy-Fi window. Spotify does not need to be open afterward.'
    });
  }
  const child = spawn(binaryPath, args, {
    // app.asar is a virtual archive, not a real directory a child can use as cwd.
    // The unpacked librespot directory is real in both development and builds.
    cwd: path.dirname(binaryPath),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  librespotProcess = child;
  startDeviceSync(child, childDeviceName, !usedCachedCredentials);
  let invalidCredentialsDetected = false;
  let premiumAccountErrorDetected = false;
  let stdoutBuffer = '';
  child.stdout.on('data', data => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const rawLine of lines) {
      const message = rawLine.trim();
      if (!message) continue;
      const authorizationMatch = /^Browse to:\s+(https:\/\/\S+)$/.exec(message);
      if (authorizationMatch) {
        console.log('[Playback] One-time local-player authorization URL received.');
        openPlaybackAuthWindow(authorizationMatch[1], child).catch(error => {
          console.error('[Playback] Could not open local-player authorization:', error.message);
          sendToRenderer('spotify-playback-error', `Could not open the Cozy-Fi Player authorization: ${error.message}`);
          child.cozyAuthorizationCanceled = true;
          terminateLibrespotProcess(child);
        });
      } else {
        console.log(`[Playback] ${message}`);
      }
    }
  });
  child.stderr.on('data', data => {
    const message = data.toString().trim();
    if (message.includes('INVALID_CREDENTIALS')) invalidCredentialsDetected = true;
    if (/premium[_ -]?(account|subscription|required)|account[_ -]?error|product[_ -]?restriction|not (a )?premium/i.test(message)) {
      premiumAccountErrorDetected = true;
    }
    if (message) console.warn(`[Playback] ${message}`);
  });
  child.on('error', error => {
    console.error('[Playback] Could not start librespot:', error);
    sendToRenderer('spotify-playback-error', `Could not start the Cozy-Fi playback engine: ${error.message}`);
    if (librespotProcess === child) {
      librespotProcess = null;
      activeLibrespotDeviceName = null;
      deviceId = null;
      stopDeviceSync();
      sendToRenderer('spotify-device-not-ready');
      setPlaybackCapability('unavailable', error.message);
      scheduleLibrespotRestart();
    }
  });
  child.on('close', code => {
    const wasActive = librespotProcess === child;
    if (playbackAuthProcess === child) closePlaybackAuthWindow(true);
    if (wasActive) {
      librespotProcess = null;
      activeLibrespotDeviceName = null;
      deviceId = null;
      stopDeviceSync();
      sendToRenderer('spotify-device-not-ready');
    }
    if (wasActive && child.cozyAuthorizationCanceled) return;
    if (wasActive && premiumAccountErrorDetected && accessToken) {
      detectedSpotifyProduct = 'free';
      clearPlaybackCredentials();
      setPlaybackCapability('external', 'Standalone playback was rejected because Spotify Premium is required.');
      sendToRenderer('spotify-playback-error', 'Spotify Premium was not available for standalone playback. Cozy-Fi switched to Spotify App mode.');
      return;
    }
    if (wasActive && invalidCredentialsDetected && usedCachedCredentials && accessToken) {
      console.warn('[Playback] Saved local-player credentials expired. Starting a fresh authorization.');
      clearPlaybackCredentials();
      sendToRenderer('spotify-playback-error', 'Cozy-Fi local playback authorization expired. A one-time Spotify authorization will open again.');
      setTimeout(() => {
        if (accessToken && !usesExternalPlayback() && !librespotProcess) spawnLibrespot();
      }, 500).unref();
      return;
    }
    if (wasActive && invalidCredentialsDetected && !usedCachedCredentials && accessToken) {
      sendToRenderer('spotify-playback-error', 'Spotify rejected the Cozy-Fi local-player authorization. Disconnect, reconnect, and make sure both authorizations use the same Premium account.');
      return;
    }
    if (wasActive && code && accessToken) {
      setPlaybackCapability('unavailable', `The local playback engine stopped (exit ${code}).`);
      sendToRenderer('spotify-playback-error', `The Cozy-Fi playback engine stopped (exit ${code}). It will retry automatically.`);
      scheduleLibrespotRestart();
    } else if (wasActive && accessToken) {
      setPlaybackCapability('unavailable', 'The local playback engine stopped unexpectedly.');
      scheduleLibrespotRestart();
    }
  });
  return true;
}

function terminateLibrespotProcess(processToStop) {
  try {
    processToStop.kill('SIGINT');
    setTimeout(() => {
      if (processToStop.exitCode === null && processToStop.signalCode === null) {
        processToStop.kill('SIGKILL');
      }
    }, 2000).unref();
  } catch (error) {
    console.warn('[Playback] Could not stop librespot cleanly:', error.message);
  }
}

function scheduleLibrespotRestart() {
  if (!accessToken || usesExternalPlayback() || librespotProcess || librespotRestartTimer) return;
  if (librespotRestartAttempts >= 3) {
    setPlaybackCapability('unavailable', 'The local player could not stay running.');
    sendToRenderer('spotify-playback-error', 'The Cozy-Fi playback engine could not stay running. Reconnect Spotify to try again.');
    return;
  }
  const delay = Math.min(8000, 1000 * (2 ** librespotRestartAttempts));
  librespotRestartAttempts += 1;
  librespotRestartTimer = setTimeout(() => {
    librespotRestartTimer = null;
    if (accessToken && !usesExternalPlayback() && !librespotProcess) spawnLibrespot();
  }, delay);
  librespotRestartTimer.unref();
}

function killLibrespot() {
  if (librespotRestartTimer) clearTimeout(librespotRestartTimer);
  librespotRestartTimer = null;
  librespotRestartAttempts = 0;
  if (!librespotProcess) return;
  const processToStop = librespotProcess;
  librespotProcess = null;
  activeLibrespotDeviceName = null;
  terminateLibrespotProcess(processToStop);
}

function stopDeviceSync() {
  deviceSyncGeneration += 1;
  if (deviceSyncInterval) clearInterval(deviceSyncInterval);
  if (deviceHealthInterval) clearInterval(deviceHealthInterval);
  deviceSyncInterval = null;
  deviceHealthInterval = null;
}

function invalidatePlaybackDevice() {
  if (!deviceId) return;
  deviceId = null;
  setPlaybackCapability('starting', 'Reconnecting the Cozy-Fi local player.');
  sendToRenderer('spotify-device-not-ready');
  if (librespotProcess && activeLibrespotDeviceName) {
    startDeviceSync(librespotProcess, activeLibrespotDeviceName);
  }
}

function startDeviceHealthCheck(expectedProcess, expectedDeviceName, expectedDeviceId) {
  const healthGeneration = deviceSyncGeneration;
  let healthCheckInFlight = false;
  deviceHealthInterval = setInterval(async () => {
    if (
      healthCheckInFlight ||
      healthGeneration !== deviceSyncGeneration ||
      librespotProcess !== expectedProcess ||
      deviceId !== expectedDeviceId
    ) return;
    healthCheckInFlight = true;
    try {
      const data = await fetchWebApi('v1/me/player/devices');
      if (
        healthGeneration !== deviceSyncGeneration ||
        librespotProcess !== expectedProcess ||
        deviceId !== expectedDeviceId
      ) return;
      const currentDevice = (Array.isArray(data?.devices) ? data.devices : [])
        .find(device => device?.id === expectedDeviceId && device?.name === expectedDeviceName);
      if (!currentDevice || currentDevice.is_restricted) invalidatePlaybackDevice();
    } catch (error) {
      console.warn('[Playback] Device health check failed:', error.message);
    } finally {
      healthCheckInFlight = false;
    }
  }, 30_000);
  deviceHealthInterval.unref?.();
}

function startDeviceSync(expectedProcess, expectedDeviceName, waitingForAuthorization = false) {
  stopDeviceSync();
  const syncGeneration = deviceSyncGeneration;
  let syncInFlight = false;
  let discoveryAttempts = 0;
  const isCurrentSync = () => (
    syncGeneration === deviceSyncGeneration &&
    librespotProcess === expectedProcess &&
    Boolean(accessToken)
  );
  const syncCozyDevice = async () => {
    if (!isCurrentSync() || deviceId || syncInFlight) return;
    const maximumDiscoveryAttempts = waitingForAuthorization ? 120 : 15;
    if (discoveryAttempts >= maximumDiscoveryAttempts) {
      librespotProcess = null;
      activeLibrespotDeviceName = null;
      stopDeviceSync();
      sendToRenderer('spotify-device-not-ready');
      setPlaybackCapability(
        'unavailable',
        waitingForAuthorization
          ? 'The one-time local-player authorization was not completed.'
          : 'The local Spotify Connect device could not be registered.'
      );
      sendToRenderer(
        'spotify-playback-error',
        waitingForAuthorization
          ? 'The one-time Cozy-Fi Player authorization was not completed. Disconnect and reconnect Spotify to try again.'
          : 'Cozy-Fi could not register its Spotify Connect device. It will retry automatically.'
      );
      terminateLibrespotProcess(expectedProcess);
      scheduleLibrespotRestart();
      return;
    }
    discoveryAttempts += 1;
    syncInFlight = true;
    try {
      const data = await fetchWebApi('v1/me/player/devices');
      if (!isCurrentSync()) return;
      const devices = Array.isArray(data?.devices) ? data.devices : [];
      const cozyDevice = devices.find(device => device?.name === expectedDeviceName && !device?.is_restricted);
      if (!cozyDevice?.id) return;
      const discoveredDeviceId = cozyDevice.id;
      if (!isCurrentSync()) return;
      deviceId = discoveredDeviceId;
      detectedSpotifyProduct = detectedSpotifyProduct || 'premium';
      librespotRestartAttempts = 0;
      stopDeviceSync();
      if (playbackAuthProcess === expectedProcess) closePlaybackAuthWindow(true);
      setPlaybackCapability('ready', 'Standalone playback is ready.');
      sendToRenderer('spotify-device-ready', { name: DEVICE_NAME });
      startDeviceHealthCheck(expectedProcess, expectedDeviceName, discoveredDeviceId);
    } catch (error) {
      console.warn('[Playback] Device discovery is still waiting:', error.message);
    } finally {
      syncInFlight = false;
    }
  };
  deviceSyncInterval = setInterval(syncCozyDevice, 3000);
  syncCozyDevice();
}

function logoutSession() {
  authSessionGeneration += 1;
  refreshPromise = null;
  accessToken = '';
  refreshToken = '';
  accessTokenExpiresAt = 0;
  deviceId = null;
  detectedSpotifyProduct = null;
  saveConfig();
  stopDeviceSync();
  killLibrespot();
  closePlaybackAuthWindow(true);
  clearPlaybackCache();
  closeAuthResources();
  setPlaybackCapability('disconnected');
  sendToRenderer('spotify-connection-logout');
}

async function restoreSession() {
  if (!(await ensureAccessToken())) {
    setPlaybackCapability('disconnected');
    return false;
  }
  sendToRenderer('spotify-connection-success', { isConnected: true });
  await configurePlaybackForAccount();
  return true;
}

function installNavigationGuards(window, trustedUrl = TRUSTED_RENDERER_URL) {
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== trustedUrl) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      shell.openExternal(normalizeSpotifyExternalUrl(url));
    } catch {
      // Renderer-created windows are denied unless they are Spotify links.
    }
    return { action: 'deny' };
  });
}

async function runSmokeTest() {
  try {
    // Hidden BrowserWindows can defer viewport layout on macOS runners. Exercise
    // the same visible-window path users get before measuring responsive views.
    mainWindow.showInactive();
    mainWindow.setSize(360, 520);
    await new Promise(resolve => setTimeout(resolve, 150));
    const result = await mainWindow.webContents.executeJavaScript(`
      new Promise(resolve => setTimeout(async () => {
        const activate = view => {
          document.querySelector('[data-view="' + view + '"]').click();
          return document.getElementById('view-' + view).classList.contains('active');
        };
        const viewFits = view => {
          activate(view);
          const element = document.getElementById('view-' + view);
          const visibleChildren = Array.from(element.children).filter(child => child.getClientRects().length > 0);
          const lastChild = visibleChildren.at(-1);
          element.scrollTop = element.scrollHeight;
          const elementRect = element.getBoundingClientRect();
          const playerTop = document.querySelector('.player-bar').getBoundingClientRect().top;
          const lastRect = lastChild?.getBoundingClientRect();
          const visibleBottom = Math.min(elementRect.bottom, playerTop);
          const bottomIsReachable = !lastRect || lastRect.bottom <= visibleBottom + 2;
          element.scrollTop = 0;
          return (
            element.scrollWidth <= element.clientWidth + 8 &&
            getComputedStyle(element).overflowY === 'auto' &&
            bottomIsReachable
          );
        };
        const capability = await window.cozyApi.spotify.getPlaybackCapability();
        document.getElementById('sidebar-toggle').click();
        const sidebar = document.getElementById('app-sidebar');
        const sidebarScrolls = getComputedStyle(sidebar).overflowY === 'auto';
        sidebar.scrollTop = sidebar.scrollHeight;
        const sidebarRect = sidebar.getBoundingClientRect();
        const userCardRect = sidebar.querySelector('.user-card').getBoundingClientRect();
        const sidebarEndReachable = userCardRect.bottom <= sidebarRect.bottom + 2;
        document.getElementById('sidebar-toggle').click();
        const playbackContextRequest = window.CozyPlaybackContext?.createPlaybackRequest({
          spotifyUri: 'spotify:track:smokeTrack',
          playbackContextUri: 'spotify:playlist:smokePlaylist',
          playbackContextPosition: 3
        }, [], 0);
        const lyricsPayload = await window.cozyApi.lyrics.get({
          title: 'Smoke Test Song',
          artist: 'Cozy-Fi',
          album: 'Morning Blend',
          durationMs: 180000
        });
        const localLyricsPayload = await window.cozyApi.lyrics.importLocal({
          title: 'Smoke Test Song',
          artist: 'Cozy-Fi',
          album: 'Morning Blend',
          durationMs: 180000
        });
        const lyricsModel = window.CozyLyrics?.buildLyricsModel(lyricsPayload);
        const localLyricsModel = window.CozyLyrics?.buildLyricsModel(localLyricsPayload);
        const lyricsTab = document.getElementById('player-lyrics-tab');
        const artworkTab = document.getElementById('player-now-playing-tab');
        lyricsTab.click();
        const lyricsTabSwitches = !document.getElementById('player-lyrics-panel').hidden &&
          document.getElementById('player-now-playing-panel').hidden &&
          lyricsTab.getAttribute('aria-selected') === 'true';
        artworkTab.click();
        activate('settings');
        document.querySelector('[data-theme="cover-match"]').click();
        const coverThemePreview = Boolean(
          document.body.classList.contains('theme-cover-match') &&
          !document.getElementById('cover-theme-editor').hidden &&
          ['cover-theme-style', 'cover-theme-mood', 'cover-theme-intensity'].every(id => Boolean(document.getElementById(id))) &&
          /^#[0-9a-f]{6}$/i.test(getComputedStyle(document.body).getPropertyValue('--cover-start').trim()) &&
          viewFits('settings')
        );
        document.querySelector('[data-theme="morning-lo-fi"]').click();
        activate('home');
        const checks = {
          title: document.title === 'Cozy-Fi',
          api: Boolean(window.cozyApi),
          home: document.getElementById('view-home').classList.contains('active'),
          search: activate('search'),
          library: activate('library'),
          settings: activate('settings'),
          customTheme: Boolean(document.getElementById('custom-theme-editor') && document.querySelectorAll('[data-color-key]').length >= 7),
          coverTheme: coverThemePreview,
          sidePlayerToggle: Boolean(document.getElementById('side-player-toggle')),
          pagination: ['liked-tracks-pagination', 'library-grid-pagination', 'search-pagination'].every(id => Boolean(document.getElementById(id))),
          capability: Boolean(capability && typeof capability.mode === 'string' && typeof capability.preference === 'string'),
          playbackContext: Boolean(
            playbackContextRequest?.type === 'context' &&
            playbackContextRequest.contextUri === 'spotify:playlist:smokePlaylist' &&
            playbackContextRequest.offset?.position === 3 &&
            playbackContextRequest.offset?.uri === 'spotify:track:smokeTrack'
          ),
          lyricsApi: Boolean(
            lyricsModel?.kind === 'synced' &&
            lyricsModel.lines?.length === 2 &&
            window.CozyLyrics.findActiveLineIndex(lyricsModel.lines, 4600) === 1
          ),
          localLyricsApi: Boolean(
            localLyricsModel?.kind === 'synced' &&
            localLyricsModel.record?.source === 'local' &&
            localLyricsModel.lines?.length === 2 &&
            document.getElementById('lyrics-import-button')
          ),
          lyricsTab: Boolean(
            lyricsTabSwitches &&
            !document.getElementById('player-now-playing-panel').hidden &&
            document.getElementById('player-lyrics-panel').hidden &&
            getComputedStyle(document.getElementById('lyrics-scroll')).overflowY === 'auto'
          ),
          contentAbovePlayer: document.querySelector('.app-container').getBoundingClientRect().bottom <= document.querySelector('.player-bar').getBoundingClientRect().top + 1,
          compactHome: viewFits('home'),
          compactSearch: viewFits('search'),
          compactLibrary: viewFits('library'),
          compactSettings: viewFits('settings'),
          compactSidebar: sidebarScrolls && sidebarEndReachable
        };
        const startedEnlarged = document.body.classList.contains('font-enlarged');
        document.body.classList.add('font-enlarged');
        checks.enlargedPages = ['home', 'search', 'library', 'settings'].every(viewFits);
        document.body.classList.toggle('font-enlarged', startedEnlarged);
        document.getElementById('player-track-info-trigger').click();
        checks.player = document.getElementById('view-player').classList.contains('active');
        checks.controls = ['player-play-btn', 'player-prev-btn', 'player-next-btn', 'volume-slider', 'timeline-slider']
          .every(id => Boolean(document.getElementById(id)));
        const playerRect = document.querySelector('.player-bar').getBoundingClientRect();
        checks.compactPlayer = playerRect.left >= -1 && playerRect.right <= window.innerWidth + 1 && playerRect.bottom <= window.innerHeight + 1;
        checks.noBodyOverflow = document.documentElement.scrollWidth <= window.innerWidth + 8;
        resolve({ ok: Object.values(checks).every(Boolean), checks });
      }, 1000))
    `, true);
    mainWindow.setSize(1200, 520);
    const wideShortPages = await mainWindow.webContents.executeJavaScript(`
      new Promise(resolve => setTimeout(() => {
        const playerTop = document.querySelector('.player-bar').getBoundingClientRect().top;
        const shellBottom = document.querySelector('.app-container').getBoundingClientRect().bottom;
        const pagesFit = ['home', 'search', 'library', 'settings', 'player'].every(view => {
          const nav = document.querySelector('[data-view="' + view + '"]');
          if (nav) nav.click();
          else document.getElementById('player-track-info-trigger').click();
          const element = document.getElementById('view-' + view);
          const visibleChildren = Array.from(element.children).filter(child => child.getClientRects().length > 0);
          element.scrollTop = element.scrollHeight;
          const lastRect = visibleChildren.at(-1)?.getBoundingClientRect();
          const reachable = !lastRect || lastRect.bottom <= playerTop + 2;
          element.scrollTop = 0;
          return reachable && element.scrollWidth <= element.clientWidth + 8;
        });
        resolve(shellBottom <= playerTop + 1 && pagesFit);
      }, 150))
    `, true);
    result.checks.wideShortPages = wideShortPages;
    result.ok = result.ok && wideShortPages;
    // Match the real user transition: the full app is visible before compact
    // mode takes over. Packaged Windows apps may suppress an initial show from
    // a process whose only window has never been activated.
    mainWindow.show();
    await new Promise(resolve => setTimeout(resolve, 75));
    await showSidePlayer();
    await new Promise(resolve => setTimeout(resolve, 75));
    const compactWindow = sidePlayerWindow;
    const compactOpenState = {
      compactMode: sidePlayerModeActive,
      sideVisible: compactWindow.isVisible(),
      sideMinimized: compactWindow.isMinimized(),
      mainVisible: mainWindow.isVisible()
    };
    const compactOnlyAtOpen = sidePlayerModeActive && compactWindow.isVisible() && !mainWindow.isVisible();
    compactWindow.setSize(SIDE_PLAYER_MIN_WIDTH, SIDE_PLAYER_MIN_HEIGHT);
    await mainWindow.webContents.executeJavaScript(`Promise.all([
      window.cozyApi.sidePlayer.syncTheme({
        kind: 'custom',
        fontSize: 'enlarged',
        colors: {
          bgPrimary: '#f2e9dc', bgSecondary: '#fffaf2', bgCard: '#dfc8b4',
          textPrimary: '#302625', textSecondary: '#6b554e', accentColor: '#b98268',
          borderColor: '#302625'
        }
      }),
      window.cozyApi.sidePlayer.syncSnapshot({
        track: {
          title: 'Side Player Test', artist: 'Cozy-Fi', album: 'Morning Blend',
          cover: ${JSON.stringify(SMOKE_ARTWORK_URL || null)},
          spotifyUri: 'spotify:track:1234567890', spotifyType: 'track'
        },
        isPlaying: false, positionMs: 45000, durationMs: 180000, loading: false
      })
    ])`, true);
    if (sidePlayerSnapshot?.track && !SMOKE_ARTWORK_URL) {
      sidePlayerSnapshot = {
        ...sidePlayerSnapshot,
        track: {
          ...sidePlayerSnapshot.track,
          cover: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
        }
      };
      compactWindow.webContents.send('side-player-snapshot', sidePlayerSnapshot);
    }
    await mainWindow.webContents.executeJavaScript(`window.cozyApi.sidePlayer.syncSnapshot({
      track: {
        title: 'Side Player Test', artist: 'Cozy-Fi', album: 'Morning Blend', cover: null,
        spotifyUri: 'spotify:track:1234567890', spotifyType: 'track'
      },
      isPlaying: false, positionMs: 45000, durationMs: 180000, loading: false
    })`, true);
    const mainArtworkPreserved = Boolean(sidePlayerSnapshot?.track?.cover);
    compactWindow.webContents.send('spotify-playback-capability', {
      mode: 'standalone', tier: 'premium', preference: 'auto'
    });
    compactWindow.webContents.send('side-player-snapshot', {
      ...sidePlayerSnapshot,
      track: { ...sidePlayerSnapshot.track, cover: null }
    });
    const sideResult = await compactWindow.webContents.executeJavaScript(`
      new Promise(resolve => setTimeout(async () => {
        const shell = document.getElementById('mini-window');
        const titlebar = document.querySelector('.mini-titlebar');
        const headerActionsFit = Array.from(document.querySelectorAll('.mini-window-actions button'))
          .every(button => (
            button.getBoundingClientRect().right <= titlebar.getBoundingClientRect().right + 1 &&
            button.scrollWidth <= button.clientWidth
          ));
        const unpinned = await window.cozyApi.sidePlayer.setPinned(false);
        const repinned = await window.cozyApi.sidePlayer.setPinned(true);
        await window.cozyApi.sidePlayer.syncTheme({
          kind: 'cover',
          fontSize: 'standard',
          colors: {
            bgPrimary: '#18213a', bgSecondary: '#222d4b', bgCard: '#2d3c61',
            textPrimary: '#fffaf4', textSecondary: '#d9e2f5', accentColor: '#e4a95f',
            borderColor: '#fffaf4'
          },
          cover: { style: 'vivid-gradient', start: '#102d6b', end: '#562b68', glow: '#6b4610' },
          options: { style: 'vivid-gradient', mood: 'dark', intensity: 82 }
        });
        await new Promise(done => setTimeout(done, 40));
        const coverThemeApplied = document.body.classList.contains('theme-cover-match') &&
          document.body.classList.contains('cover-style-vivid-gradient') &&
          /^#[0-9a-f]{6}$/i.test(getComputedStyle(document.body).getPropertyValue('--cover-start').trim());
        await window.cozyApi.sidePlayer.syncTheme({
          kind: 'custom',
          fontSize: 'enlarged',
          colors: {
            bgPrimary: '#f2e9dc', bgSecondary: '#fffaf2', bgCard: '#dfc8b4',
            textPrimary: '#302625', textSecondary: '#6b554e', accentColor: '#b98268',
            borderColor: '#302625'
          }
        });
        await new Promise(done => setTimeout(done, 40));
        const artworkProbeUrl = ${JSON.stringify(SMOKE_ARTWORK_URL)};
        const proxiedArtwork = artworkProbeUrl
          ? await window.cozyApi.sidePlayer.resolveArtwork(artworkProbeUrl)
          : null;
        const coverTab = document.getElementById('mini-cover-tab');
        const lyricsTab = document.getElementById('mini-lyrics-tab');
        const artworkPanel = document.getElementById('mini-art-frame');
        const lyricsPanel = document.getElementById('mini-lyrics-panel');
        const lyricsLazyBeforeOpen = document.getElementById('mini-lyrics-state').textContent === 'OPTIONAL' &&
          document.querySelectorAll('#mini-lyrics-scroll .lyrics-line').length === 0;
        lyricsTab.click();
        const lyricsDeadline = Date.now() + 1000;
        while (document.getElementById('mini-lyrics-state').textContent !== 'SYNCED' && Date.now() < lyricsDeadline) {
          await new Promise(done => setTimeout(done, 25));
        }
        const lyricsRect = lyricsPanel.getBoundingClientRect();
        const stageRect = document.querySelector('.mini-stage').getBoundingClientRect();
        const compactLyrics = Boolean(
          !lyricsPanel.hidden &&
          artworkPanel.hidden &&
          lyricsTab.getAttribute('aria-selected') === 'true' &&
          document.querySelectorAll('#mini-lyrics-scroll .lyrics-line').length === 2 &&
          document.querySelectorAll('#mini-lyrics-scroll .lyrics-line.is-active').length === 1 &&
          getComputedStyle(document.getElementById('mini-lyrics-scroll')).overflowY === 'auto'
        );
        const compactLyricsFits = lyricsRect.left >= stageRect.left - 1 &&
          lyricsRect.top >= stageRect.top - 1 &&
          lyricsRect.right <= stageRect.right + 1 &&
          lyricsRect.bottom <= stageRect.bottom + 1;
        const compactLyricsPlaybackVisible = ['.mini-track-area', '.mini-progress-area', '.mini-controls']
          .every(selector => {
            const elementRect = document.querySelector(selector).getBoundingClientRect();
            return elementRect.width > 0 && elementRect.height > 0 && elementRect.bottom <= window.innerHeight + 1;
          });
        coverTab.click();
        const lyricsRoundTrip = !artworkPanel.hidden && lyricsPanel.hidden &&
          coverTab.getAttribute('aria-selected') === 'true';
        const beforeResize = { width: window.outerWidth, height: window.outerHeight };
        const resized = await window.cozyApi.sidePlayer.resizeBy({ width: 24, height: 24 });
        const resizeDeadline = Date.now() + 1000;
        let afterResize = { width: window.outerWidth, height: window.outerHeight };
        while (
          (afterResize.width < beforeResize.width + 20 || afterResize.height < beforeResize.height + 20) &&
          Date.now() < resizeDeadline
        ) {
          await new Promise(done => setTimeout(done, 25));
          afterResize = { width: window.outerWidth, height: window.outerHeight };
        }
        const rect = shell.getBoundingClientRect();
        const checks = {
          title: document.title === 'Cozy-Fi Side Player',
          api: Boolean(window.cozyApi?.sidePlayer),
          loaded: !document.body.classList.contains('is-loading'),
          controls: ['mini-play', 'mini-previous', 'mini-next', 'mini-progress', 'mini-pin', 'mini-hide', 'mini-cover-tab', 'mini-lyrics-tab', 'mini-lyrics-import']
            .every(id => Boolean(document.getElementById(id))),
          skeleton: Boolean(document.querySelector('.mini-art-skeleton.ghost') && document.querySelector('.mini-copy-skeleton .ghost')),
          themeSync: getComputedStyle(document.body).getPropertyValue('--bg-primary').trim() === '#f2e9dc' && document.body.classList.contains('font-enlarged'),
          snapshotSync: document.getElementById('mini-track-title').textContent === 'Side Player Test' && document.getElementById('mini-progress').max === '180000',
          artwork: !document.getElementById('mini-cover').hidden && document.getElementById('mini-cover').naturalWidth > 0 && document.getElementById('mini-cover-fallback').hidden && getComputedStyle(document.getElementById('mini-cover-fallback')).display === 'none',
          incompleteArtworkUpdatePreserved: ${JSON.stringify(mainArtworkPreserved)} && !document.getElementById('mini-cover').hidden && document.getElementById('mini-cover').naturalWidth > 0 && getComputedStyle(document.getElementById('mini-cover-fallback')).display === 'none',
          artworkProxy: !artworkProbeUrl || (
            typeof proxiedArtwork === 'string' &&
            proxiedArtwork.startsWith('data:image/') &&
            proxiedArtwork.includes(';base64,')
          ),
          pinRoundTrip: unpinned?.pinned === false && repinned?.pinned === true,
          coverTheme: coverThemeApplied,
          lyricsLazyBeforeOpen,
          compactLyrics,
          compactLyricsFits,
          compactLyricsPlaybackVisible,
          lyricsRoundTrip,
          resizeGrip: Boolean(document.getElementById('mini-resize')),
          resizable: Boolean(resized) && afterResize.width >= beforeResize.width + 20 && afterResize.height >= beforeResize.height + 20,
          headerActionsFit,
          fits: rect.left >= -1 && rect.top >= -1 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1,
          noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 2 && document.documentElement.scrollHeight <= window.innerHeight + 2
        };
        resolve({
          ok: Object.values(checks).every(Boolean),
          checks,
          metrics: {
            beforeResize,
            requestedResize: resized,
            afterResize,
            stageBounds: {
              left: stageRect.left, top: stageRect.top, right: stageRect.right,
              bottom: stageRect.bottom, width: stageRect.width, height: stageRect.height
            },
            lyricsBounds: {
              left: lyricsRect.left, top: lyricsRect.top, right: lyricsRect.right,
              bottom: lyricsRect.bottom, width: lyricsRect.width, height: lyricsRect.height
            }
          }
        });
      }, 650))
    `, true);
    openFullPlayer();
    const fullOnlyAfterFull = !sidePlayerModeActive && mainWindow.isVisible() && !compactWindow.isVisible();
    await showSidePlayer();
    await new Promise(resolve => setTimeout(resolve, 75));
    const compactOnlyAfterReturn = sidePlayerModeActive && compactWindow.isVisible() && !mainWindow.isVisible();
    const combined = {
      ok: result.ok && sideResult.ok && compactOnlyAtOpen && fullOnlyAfterFull && compactOnlyAfterReturn,
      checks: {
        ...result.checks,
        sidePlayer: sideResult.ok,
        sidePlayerOnly: compactOnlyAtOpen && compactOnlyAfterReturn,
        sidePlayerOnlyAtOpen: compactOnlyAtOpen,
        sidePlayerOnlyAfterReturn: compactOnlyAfterReturn,
        fullRestoresAlone: fullOnlyAfterFull
      },
      sidePlayerChecks: sideResult.checks,
      sidePlayerMetrics: sideResult.metrics,
      compactOpenState
    };
    console.log(`COZY_SMOKE_RESULT ${JSON.stringify(combined)}`);
    app.exit(combined.ok ? 0 : 1);
  } catch (error) {
    console.error('COZY_SMOKE_ERROR', error);
    app.exit(1);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1250,
    height: 850,
    minWidth: 360,
    minHeight: 520,
    show: !IS_SMOKE_TEST,
    icon: path.join(__dirname, 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  installNavigationGuards(mainWindow);
  mainWindow.webContents.on('did-finish-load', () => {
    if (IS_SMOKE_TEST) runSmokeTest();
    else if (!accessToken || playbackCapabilityState === 'disconnected') restoreSession();
    else {
      mainWindow.webContents.send('spotify-connection-success', { isConnected: true });
      mainWindow.webContents.send('spotify-playback-capability', getPlaybackCapability());
      if (deviceId) mainWindow.webContents.send('spotify-device-ready', { name: DEVICE_NAME });
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (sidePlayerWindow && !sidePlayerWindow.isDestroyed() && !sidePlayerModeActive) {
      sidePlayerWindow.destroy();
    }
  });
  mainWindow.loadFile('index.html');
}

function registerIpcHandlers() {
  const requireSidePlayerSender = event => {
    if (
      !sidePlayerWindow ||
      sidePlayerWindow.isDestroyed() ||
      event.sender !== sidePlayerWindow.webContents
    ) {
      throw new Error('This action is only available from the Cozy-Fi side player.');
    }
    return sidePlayerWindow;
  };

  ipcMain.handle('side-player-get-state', () => getSidePlayerState());
  ipcMain.handle('side-player-toggle', () => toggleSidePlayer());
  ipcMain.handle('side-player-hide', () => hideSidePlayer());
  ipcMain.handle('side-player-open-main', () => openFullPlayer());
  ipcMain.handle('side-player-resolve-artwork', (event, rawUrl) => {
    requireSidePlayerSender(event);
    return resolveSidePlayerArtwork(rawUrl);
  });
  ipcMain.handle('side-player-resize-start', (event, rawPoint) => {
    const window = requireSidePlayerSender(event);
    const point = normalizeResizePoint(rawPoint);
    sidePlayerResizeSession = {
      senderId: event.sender.id,
      startX: point.x,
      startY: point.y,
      bounds: window.getBounds()
    };
    return { width: sidePlayerResizeSession.bounds.width, height: sidePlayerResizeSession.bounds.height };
  });
  ipcMain.on('side-player-resize-move', (event, rawPoint) => {
    if (!sidePlayerResizeSession || event.sender.id !== sidePlayerResizeSession.senderId) return;
    try {
      requireSidePlayerSender(event);
      const point = normalizeResizePoint(rawPoint);
      resizeSidePlayerTo(
        sidePlayerResizeSession.bounds.width + point.x - sidePlayerResizeSession.startX,
        sidePlayerResizeSession.bounds.height + point.y - sidePlayerResizeSession.startY
      );
    } catch (error) {
      console.warn('[Side Player] Ignoring invalid resize update:', error.message);
    }
  });
  ipcMain.on('side-player-resize-end', event => {
    if (sidePlayerResizeSession?.senderId === event.sender.id) sidePlayerResizeSession = null;
  });
  ipcMain.handle('side-player-resize-by', (event, rawDelta) => {
    const window = requireSidePlayerSender(event);
    const widthDelta = Math.max(-100, Math.min(100, Math.round(Number(rawDelta?.width) || 0)));
    const heightDelta = Math.max(-100, Math.min(100, Math.round(Number(rawDelta?.height) || 0)));
    const current = window.getBounds();
    return resizeSidePlayerTo(current.width + widthDelta, current.height + heightDelta);
  });
  ipcMain.handle('side-player-set-pinned', (_event, value) => {
    sidePlayerPinned = Boolean(value);
    if (sidePlayerWindow && !sidePlayerWindow.isDestroyed()) {
      sidePlayerWindow.setAlwaysOnTop(sidePlayerPinned);
    }
    saveConfig();
    return publishSidePlayerState();
  });
  ipcMain.handle('side-player-sync-theme', (_event, rawTheme) => {
    sidePlayerTheme = normalizeSidePlayerTheme(rawTheme);
    if (sidePlayerWindow && !sidePlayerWindow.isDestroyed()) {
      sidePlayerWindow.webContents.send('side-player-theme', sidePlayerTheme);
    }
    return true;
  });
  ipcMain.handle('side-player-sync-snapshot', (_event, rawSnapshot) => {
    const nextSnapshot = normalizeSidePlayerSnapshot(rawSnapshot);
    if (
      nextSnapshot?.track &&
      !nextSnapshot.track.cover &&
      sidePlayerSnapshot?.track?.cover &&
      isSameSidePlayerTrack(nextSnapshot.track, sidePlayerSnapshot.track)
    ) {
      nextSnapshot.track.cover = sidePlayerSnapshot.track.cover;
    }
    sidePlayerSnapshot = nextSnapshot;
    if (sidePlayerWindow && !sidePlayerWindow.isDestroyed()) {
      sidePlayerWindow.webContents.send('side-player-snapshot', sidePlayerSnapshot);
    }
    return true;
  });

  ipcMain.handle('get-auth-status', async () => Boolean(await ensureAccessToken()));
  ipcMain.handle('get-public-config', () => ({ clientId, playbackPreference }));
  ipcMain.handle('theme-resolve-artwork', (_event, rawUrl) => resolveSidePlayerArtwork(rawUrl));
  ipcMain.handle('get-playback-capability', () => getPlaybackCapability());
  ipcMain.handle('set-playback-preference', async (_event, rawPreference) => {
    playbackPreference = normalizePlaybackPreference(rawPreference);
    saveConfig();
    if (accessToken) await configurePlaybackForAccount();
    else setPlaybackCapability('disconnected');
    return getPlaybackCapability();
  });
  ipcMain.handle('spotify-login', (_event, requestedClientId) => startSpotifyLogin(requestedClientId));
  ipcMain.handle('spotify-logout', () => { logoutSession(); return true; });

  ipcMain.handle('get-profile', () => fetchWebApi('v1/me'));
  ipcMain.handle('get-playlists', () => fetchAllPages('v1/me/playlists?limit=50', data => data?.items));
  ipcMain.handle('get-playlist-tracks', async (_event, rawPlaylistId) => {
    const playlistId = normalizeSpotifyId(rawPlaylistId, 'playlist ID');
    const entries = await fetchAllPages(`v1/playlists/${playlistId}/items?limit=50`, data => data?.items);
    return entries
      .map((entry, contextPosition) => ({
        item: entry?.item || entry?.track,
        contextPosition
      }))
      .filter(entry => (
        entry.item?.type === 'track' &&
        !entry.item?.is_local &&
        /^spotify:track:/.test(entry.item?.uri || '')
      ))
      .map(entry => ({
        ...entry.item,
        cozy_context_position: entry.contextPosition
      }));
  });
  ipcMain.handle('get-albums', async () => {
    const entries = await fetchAllPages('v1/me/albums?limit=50', data => data?.items);
    return entries.map(entry => entry?.album).filter(Boolean);
  });
  ipcMain.handle('get-artists', async () => {
    const artists = [];
    let next = 'v1/me/following?type=artist&limit=50';
    while (next && artists.length < MAX_LIBRARY_ITEMS) {
      const data = await fetchWebApi(next);
      const page = data?.artists;
      if (Array.isArray(page?.items)) artists.push(...page.items);
      next = typeof page?.next === 'string' && page.next.startsWith(SPOTIFY_API_BASE) ? page.next : null;
    }
    return artists.slice(0, MAX_LIBRARY_ITEMS);
  });
  ipcMain.handle('get-artist-top-tracks', async (_event, rawArtistId) => {
    const artistId = normalizeSpotifyId(rawArtistId, 'artist ID');
    const artist = await fetchWebApi(`v1/artists/${artistId}`);
    const query = encodeURIComponent(`artist:"${String(artist?.name || '').replace(/"/g, '')}"`);
    const data = await fetchWebApi(`v1/search?q=${query}&type=track&limit=10`);
    return (Array.isArray(data?.tracks?.items) ? data.tracks.items : [])
      .filter(track => Array.isArray(track?.artists) && track.artists.some(item => item?.id === artistId));
  });
  ipcMain.handle('get-album-tracks', (_event, rawAlbumId) => {
    const albumId = normalizeSpotifyId(rawAlbumId, 'album ID');
    return fetchAllPages(`v1/albums/${albumId}/tracks?limit=50`, data => data?.items);
  });
  ipcMain.handle('get-liked-tracks', async () => {
    const entries = await fetchAllPages('v1/me/tracks?limit=50', data => data?.items);
    return entries
      .map(entry => entry?.track)
      .filter(track => track && !track.is_local && /^spotify:track:/.test(track.uri || ''));
  });
  ipcMain.handle('get-top-tracks', async () => {
    const data = await fetchWebApi('v1/me/top/tracks?time_range=medium_term&limit=20');
    return Array.isArray(data?.items) ? data.items : [];
  });
  ipcMain.handle('get-personalized-tracks', async (_event, rawSeedId) => {
    const seedId = rawSeedId ? normalizeSpotifyId(rawSeedId, 'track ID') : '';
    const [top, recent] = await Promise.all([
      fetchWebApi('v1/me/top/tracks?time_range=short_term&limit=20'),
      fetchWebApi('v1/me/player/recently-played?limit=20')
    ]);
    const combined = [
      ...(Array.isArray(top?.items) ? top.items : []),
      ...(Array.isArray(recent?.items) ? recent.items.map(entry => entry?.track) : [])
    ].filter(Boolean);
    const unique = new Map(combined.map(track => [track.id, track]));
    if (seedId) unique.delete(seedId);
    return Array.from(unique.values()).slice(0, 10);
  });
  ipcMain.handle('search-tracks', async (_event, rawQuery, rawOffset = 0) => {
    const query = encodeURIComponent(normalizeQuery(rawQuery));
    const offset = Math.max(0, Math.min(990, Math.floor(Number(rawOffset) || 0)));
    const data = await fetchWebApi(`v1/search?q=${query}&type=track&limit=10&offset=${offset}`);
    const tracks = data?.tracks || {};
    return {
      items: Array.isArray(tracks.items) ? tracks.items : [],
      total: Math.max(0, Number(tracks.total) || 0),
      limit: Math.max(1, Number(tracks.limit) || 10),
      offset: Math.max(0, Number(tracks.offset) || offset)
    };
  });
  ipcMain.handle('create-playlist', (_event, rawName) => {
    const name = typeof rawName === 'string' ? rawName.trim().slice(0, 100) : '';
    if (!name) throw new Error('Playlist name cannot be empty.');
    return fetchWebApi('v1/me/playlists', 'POST', { name, public: false, description: 'Created with Cozy-Fi' });
  });
  ipcMain.handle('open-spotify-link', (_event, rawUrl) => shell.openExternal(normalizeSpotifyExternalUrl(rawUrl)));
  ipcMain.handle('get-lyrics', (_event, rawTrack, rawOptions) => (
    queueLyricsLookup(() => getLyricsForTrack(rawTrack, Boolean(rawOptions?.force)))
  ));
  ipcMain.handle('import-local-lyrics', (event, rawTrack) => importLocalLyrics(event, rawTrack));

  ipcMain.handle('get-player-state', async () => {
    if (!deviceId || usesExternalPlayback()) return null;
    const state = await fetchWebApi('v1/me/player?additional_types=episode');
    return state?.device?.id === deviceId ? state : null;
  });
  ipcMain.handle('get-queue', async () => {
    if (usesExternalPlayback()) return { currentlyPlaying: null, queue: [], external: true };
    const data = await fetchWebApi('v1/me/player/queue');
    return { currentlyPlaying: data?.currently_playing || null, queue: Array.isArray(data?.queue) ? data.queue : [] };
  });
  ipcMain.handle('add-to-queue', (_event, rawTrackUri) => {
    const params = new URLSearchParams({ uri: normalizeSpotifyUri(rawTrackUri) });
    params.set('device_id', requirePlaybackDevice());
    return fetchWebApi(`v1/me/player/queue?${params}`, 'POST');
  });
  ipcMain.handle('play-track', async (_event, rawTrackUri) => {
    const trackUri = normalizeSpotifyUri(rawTrackUri, ['track']);
    if (usesExternalPlayback()) return openSpotifyUriExternally(trackUri, ['track']);
    const endpoint = `v1/me/player/play?device_id=${encodeURIComponent(requirePlaybackDevice())}`;
    return fetchWebApi(endpoint, 'PUT', { uris: [trackUri] });
  });
  ipcMain.handle('play-tracks', async (_event, rawUris) => {
    if (!Array.isArray(rawUris) || rawUris.length === 0) throw new Error('No playable tracks were provided.');
    if (rawUris.length > 100) throw new Error('Spotify accepts at most 100 explicit tracks per playback request.');
    const uris = rawUris.map(uri => normalizeSpotifyUri(uri, ['track']));
    if (usesExternalPlayback()) return openSpotifyUriExternally(uris[0], ['track']);
    const endpoint = `v1/me/player/play?device_id=${encodeURIComponent(requirePlaybackDevice())}`;
    return fetchWebApi(endpoint, 'PUT', { uris });
  });
  ipcMain.handle('play-context', async (_event, rawContextUri, rawOffsetUri) => {
    const contextUri = normalizeSpotifyUri(rawContextUri, ['playlist', 'album', 'artist']);
    const offset = normalizeContextOffset(rawOffsetUri);
    if (usesExternalPlayback()) {
      return offset?.uri
        ? openSpotifyUriExternally(offset.uri, ['track'])
        : openSpotifyUriExternally(contextUri, ['playlist', 'album', 'artist']);
    }
    const body = { context_uri: contextUri };
    if (offset?.position !== undefined) body.offset = { position: offset.position };
    else if (offset?.uri) body.offset = { uri: normalizeSpotifyUri(offset.uri, ['track']) };
    const endpoint = `v1/me/player/play?device_id=${encodeURIComponent(requirePlaybackDevice())}`;
    return fetchWebApi(endpoint, 'PUT', body);
  });
  ipcMain.handle('pause-track', () => fetchWebApi(`v1/me/player/pause?device_id=${encodeURIComponent(requirePlaybackDevice())}`, 'PUT'));
  ipcMain.handle('resume-track', () => fetchWebApi(`v1/me/player/play?device_id=${encodeURIComponent(requirePlaybackDevice())}`, 'PUT'));
  ipcMain.handle('next-track', () => fetchWebApi(`v1/me/player/next?device_id=${encodeURIComponent(requirePlaybackDevice())}`, 'POST'));
  ipcMain.handle('prev-track', () => fetchWebApi(`v1/me/player/previous?device_id=${encodeURIComponent(requirePlaybackDevice())}`, 'POST'));
  ipcMain.handle('seek-track', (_event, rawPositionMs) => {
    const params = new URLSearchParams({ position_ms: String(Math.max(0, Math.floor(Number(rawPositionMs) || 0))) });
    params.set('device_id', requirePlaybackDevice());
    return fetchWebApi(`v1/me/player/seek?${params}`, 'PUT');
  });
  ipcMain.handle('set-volume', (_event, rawVolumePercent) => {
    const volumePercent = Math.max(0, Math.min(100, Math.round(Number(rawVolumePercent) || 0)));
    const params = new URLSearchParams({ volume_percent: String(volumePercent) });
    params.set('device_id', requirePlaybackDevice());
    return fetchWebApi(`v1/me/player/volume?${params}`, 'PUT');
  });
  const normalizeLibraryItem = rawItem => {
    const value = typeof rawItem === 'string' ? rawItem.trim() : '';
    return value.startsWith('spotify:')
      ? normalizeSpotifyUri(value, ['track', 'episode'])
      : `spotify:track:${normalizeSpotifyId(value, 'track ID')}`;
  };
  ipcMain.handle('like-track', (_event, rawItem) => {
    const uri = normalizeLibraryItem(rawItem);
    return fetchWebApi(`v1/me/library?uris=${encodeURIComponent(uri)}`, 'PUT');
  });
  ipcMain.handle('unlike-track', (_event, rawItem) => {
    const uri = normalizeLibraryItem(rawItem);
    return fetchWebApi(`v1/me/library?uris=${encodeURIComponent(uri)}`, 'DELETE');
  });
  ipcMain.handle('check-liked', async (_event, rawItem) => {
    const uri = normalizeLibraryItem(rawItem);
    const data = await fetchWebApi(`v1/me/library/contains?uris=${encodeURIComponent(uri)}`);
    return Array.isArray(data) ? Boolean(data[0]) : false;
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  if (IS_SMOKE_TEST) {
    console.error('COZY_SMOKE_ERROR Another Cozy-Fi instance already owns the app lock.');
    app.exit(1);
  } else {
    app.quit();
  }
} else {
  app.on('second-instance', () => {
    focusPreferredWindow();
  });

  app.whenReady().then(() => {
    loadConfig();
    registerIpcHandlers();
    createWindow();
    app.on('activate', focusPreferredWindow);
  });
}

app.on('will-quit', () => {
  clearTimeout(sidePlayerBoundsSaveTimer);
  rememberSidePlayerBounds();
  saveConfig();
  stopDeviceSync();
  closeAuthResources();
  closePlaybackAuthWindow(true);
  killLibrespot();
});

app.on('window-all-closed', () => {
  stopDeviceSync();
  killLibrespot();
  if (process.platform !== 'darwin') app.quit();
});
