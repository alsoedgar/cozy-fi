// Narrow renderer wrapper around the isolated preload bridge.
class SpotifyClient {
  constructor() {
    this.bridge = window.cozyApi;
    this.clientId = '';
    this.isAuthenticated = false;
    this.isDeviceReady = false;
    this.playbackCapability = {
      preference: 'auto',
      mode: 'disconnected',
      canPlayLocally: false,
      opensSpotifyExternally: false,
      tier: null,
      detection: 'unknown',
      reason: ''
    };
    this.sessionGeneration = 0;
    this.onAuthStatusChangeCallback = null;
    this.onErrorCallback = null;
    this.playbackCapabilityCallbacks = new Set();
    this.ready = this.initialize();

    if (!this.bridge) {
      console.error('[Spotify] Secure Electron bridge is unavailable.');
      return;
    }

    this.bridge.events.onConnectionSuccess(() => this.setAuthenticated(true));
    this.bridge.events.onConnectionLogout(() => {
      this.isDeviceReady = false;
      this.setAuthenticated(false);
    });
    this.bridge.events.onConnectionError(message => this.emitError(message));
    this.bridge.events.onPlaybackError(message => this.emitError(message));
    this.bridge.events.onPlaybackCapability(capability => this.setPlaybackCapability(capability));
    this.bridge.events.onDeviceReady(() => {
      this.isDeviceReady = true;
    });
    this.bridge.events.onDeviceNotReady(() => {
      this.isDeviceReady = false;
    });
  }

  async initialize() {
    if (!this.bridge) return false;
    try {
      const [config, status, playbackCapability] = await Promise.all([
        this.bridge.auth.getConfig(),
        this.bridge.auth.getStatus(),
        this.bridge.spotify.getPlaybackCapability()
      ]);
      this.clientId = config?.clientId || '';
      this.setPlaybackCapability(playbackCapability || {
        ...this.playbackCapability,
        preference: config?.playbackPreference || 'auto'
      });
      this.setAuthenticated(Boolean(status));
      return this.isAuthenticated;
    } catch (error) {
      this.emitError(error.message || 'Could not restore the Spotify session.');
      return false;
    }
  }

  setAuthenticated(status) {
    const changed = this.isAuthenticated !== Boolean(status);
    this.isAuthenticated = Boolean(status);
    if (changed) this.sessionGeneration += 1;
    if (changed && this.onAuthStatusChangeCallback) {
      this.onAuthStatusChangeCallback(this.isAuthenticated);
    }
  }

  emitError(message) {
    const safeMessage = typeof message === 'string' ? message : 'Spotify request failed.';
    console.error('[Spotify]', safeMessage);
    if (this.onErrorCallback) this.onErrorCallback(safeMessage);
  }

  setPlaybackCapability(capability) {
    if (!capability || typeof capability !== 'object') return;
    this.playbackCapability = { ...this.playbackCapability, ...capability };
    this.isDeviceReady = Boolean(this.playbackCapability.canPlayLocally);
    this.playbackCapabilityCallbacks.forEach(callback => callback(this.playbackCapability));
  }

  get isExternalPlayback() {
    return this.playbackCapability.mode === 'external';
  }

  get isStandalonePlayback() {
    return this.playbackCapability.mode === 'standalone';
  }

  onPlaybackCapabilityChange(callback) {
    if (typeof callback !== 'function') return () => {};
    this.playbackCapabilityCallbacks.add(callback);
    callback(this.playbackCapability);
    return () => this.playbackCapabilityCallbacks.delete(callback);
  }

  async withCurrentSession(operation) {
    const sessionGeneration = this.sessionGeneration;
    try {
      if (!this.isAuthenticated) throw new Error('Not authenticated with Spotify.');
      const result = await operation();
      if (!this.isAuthenticated || sessionGeneration !== this.sessionGeneration) {
        throw new Error('The Spotify session changed before that action completed.');
      }
      return result;
    } catch (error) {
      this.emitError(error?.message || 'Spotify action failed.');
      throw error;
    }
  }

  onAuthStatusChange(callback) {
    this.onAuthStatusChangeCallback = callback;
    callback(this.isAuthenticated);
  }

  onError(callback) {
    this.onErrorCallback = callback;
  }

  saveConfig(clientId) {
    this.clientId = typeof clientId === 'string' ? clientId.trim() : '';
  }

  async login() {
    if (!this.bridge) throw new Error('Spotify bridge unavailable.');
    return this.bridge.auth.connect(this.clientId);
  }

  async logout() {
    if (!this.bridge) return false;
    return this.bridge.auth.disconnect();
  }

  getProfile() { return this.bridge.spotify.getProfile(); }
  getPlaylists() { return this.bridge.spotify.getPlaylists(); }
  getPlaylistTracks(playlistId) { return this.bridge.spotify.getPlaylistTracks(playlistId); }
  getAlbums() { return this.bridge.spotify.getAlbums(); }
  getArtists() { return this.bridge.spotify.getArtists(); }
  getArtistTopTracks(artistId) { return this.bridge.spotify.getArtistTopTracks(artistId); }
  getAlbumTracks(albumId) { return this.bridge.spotify.getAlbumTracks(albumId); }
  getLikedTracks() { return this.bridge.spotify.getLikedTracks(); }
  getTopTracks() { return this.bridge.spotify.getTopTracks(); }
  getRecommendations(seedId) { return this.bridge.spotify.getPersonalizedTracks(seedId); }
  search(query, offset = 0) { return this.bridge.spotify.search(query, offset); }
  createPlaylist(_userId, name) { return this.withCurrentSession(() => this.bridge.spotify.createPlaylist(name)); }
  openExternal(url) { return this.bridge.spotify.openExternal(url); }
  getMyPlayerState() { return this.bridge.spotify.getPlayerState(); }
  getPlaybackCapability() { return this.bridge.spotify.getPlaybackCapability(); }
  async setPlaybackPreference(preference) {
    const capability = await this.bridge.spotify.setPlaybackPreference(preference);
    this.setPlaybackCapability(capability);
    return capability;
  }
  getQueue() { return this.bridge.spotify.getQueue(); }
  playTrack(trackUri) { return this.withCurrentSession(() => this.bridge.spotify.playTrack(trackUri)); }
  playTracks(trackUris) { return this.withCurrentSession(() => this.bridge.spotify.playTracks(trackUris)); }
  playContext(contextUri, offsetUri) { return this.withCurrentSession(() => this.bridge.spotify.playContext(contextUri, offsetUri)); }
  pause() { return this.withCurrentSession(() => this.bridge.spotify.pause()); }
  resume() { return this.withCurrentSession(() => this.bridge.spotify.resume()); }
  next() { return this.withCurrentSession(() => this.bridge.spotify.next()); }
  prev() { return this.withCurrentSession(() => this.bridge.spotify.previous()); }
  seek(positionMs) { return this.withCurrentSession(() => this.bridge.spotify.seek(positionMs)); }
  setVolume(volumePercent) { return this.withCurrentSession(() => this.bridge.spotify.setVolume(volumePercent)); }
  likeTrack(trackId) { return this.withCurrentSession(() => this.bridge.spotify.likeTrack(trackId)); }
  unlikeTrack(trackId) { return this.withCurrentSession(() => this.bridge.spotify.unlikeTrack(trackId)); }
  checkLiked(trackId) { return this.bridge.spotify.checkLiked(trackId); }
  async addToQueue(trackUri) {
    const result = await this.withCurrentSession(() => this.bridge.spotify.addToQueue(trackUri));
    window.dispatchEvent(new Event('cozy-queue-changed'));
    return result;
  }
}

window.SpotifyClient = SpotifyClient;
