const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('cozyApi', {
  auth: {
    getStatus: () => ipcRenderer.invoke('get-auth-status'),
    getConfig: () => ipcRenderer.invoke('get-public-config'),
    connect: clientId => ipcRenderer.invoke('spotify-login', clientId),
    disconnect: () => ipcRenderer.invoke('spotify-logout')
  },
  lyrics: {
    get: (track, options) => ipcRenderer.invoke('get-lyrics', track, options),
    importLocal: track => ipcRenderer.invoke('import-local-lyrics', track),
    onLocalUpdate: callback => subscribe('lyrics-local-updated', callback)
  },
  spotify: {
    getProfile: () => ipcRenderer.invoke('get-profile'),
    getPlaylists: () => ipcRenderer.invoke('get-playlists'),
    getPlaylistTracks: playlistId => ipcRenderer.invoke('get-playlist-tracks', playlistId),
    getAlbums: () => ipcRenderer.invoke('get-albums'),
    getArtists: () => ipcRenderer.invoke('get-artists'),
    getArtistTopTracks: artistId => ipcRenderer.invoke('get-artist-top-tracks', artistId),
    getAlbumTracks: albumId => ipcRenderer.invoke('get-album-tracks', albumId),
    getLikedTracks: () => ipcRenderer.invoke('get-liked-tracks'),
    getTopTracks: () => ipcRenderer.invoke('get-top-tracks'),
    getPersonalizedTracks: seedId => ipcRenderer.invoke('get-personalized-tracks', seedId),
    search: (query, offset) => ipcRenderer.invoke('search-tracks', query, offset),
    createPlaylist: name => ipcRenderer.invoke('create-playlist', name),
    openExternal: url => ipcRenderer.invoke('open-spotify-link', url),
    getPlayerState: () => ipcRenderer.invoke('get-player-state'),
    getPlaybackCapability: () => ipcRenderer.invoke('get-playback-capability'),
    setPlaybackPreference: preference => ipcRenderer.invoke('set-playback-preference', preference),
    getQueue: () => ipcRenderer.invoke('get-queue'),
    addToQueue: trackUri => ipcRenderer.invoke('add-to-queue', trackUri),
    playTrack: trackUri => ipcRenderer.invoke('play-track', trackUri),
    playTracks: trackUris => ipcRenderer.invoke('play-tracks', trackUris),
    playContext: (contextUri, offset) => ipcRenderer.invoke('play-context', contextUri, offset),
    pause: () => ipcRenderer.invoke('pause-track'),
    resume: () => ipcRenderer.invoke('resume-track'),
    next: () => ipcRenderer.invoke('next-track'),
    previous: () => ipcRenderer.invoke('prev-track'),
    seek: positionMs => ipcRenderer.invoke('seek-track', positionMs),
    setVolume: volumePercent => ipcRenderer.invoke('set-volume', volumePercent),
    likeTrack: trackId => ipcRenderer.invoke('like-track', trackId),
    unlikeTrack: trackId => ipcRenderer.invoke('unlike-track', trackId),
    checkLiked: trackId => ipcRenderer.invoke('check-liked', trackId)
  },
  sidePlayer: {
    getState: () => ipcRenderer.invoke('side-player-get-state'),
    toggle: () => ipcRenderer.invoke('side-player-toggle'),
    hide: () => ipcRenderer.invoke('side-player-hide'),
    openMain: () => ipcRenderer.invoke('side-player-open-main'),
    resolveArtwork: url => ipcRenderer.invoke('side-player-resolve-artwork', url),
    beginResize: point => ipcRenderer.invoke('side-player-resize-start', point),
    resize: point => ipcRenderer.send('side-player-resize-move', point),
    endResize: () => ipcRenderer.send('side-player-resize-end'),
    resizeBy: delta => ipcRenderer.invoke('side-player-resize-by', delta),
    setPinned: pinned => ipcRenderer.invoke('side-player-set-pinned', pinned),
    syncTheme: theme => ipcRenderer.invoke('side-player-sync-theme', theme),
    syncSnapshot: snapshot => ipcRenderer.invoke('side-player-sync-snapshot', snapshot),
    onState: callback => subscribe('side-player-state', callback),
    onTheme: callback => subscribe('side-player-theme', callback),
    onSnapshot: callback => subscribe('side-player-snapshot', callback)
  },
  events: {
    onConnectionSuccess: callback => subscribe('spotify-connection-success', callback),
    onConnectionLogout: callback => subscribe('spotify-connection-logout', callback),
    onConnectionError: callback => subscribe('spotify-connection-error', callback),
    onRateLimit: callback => subscribe('spotify-rate-limit', callback),
    onPlaybackAuthRequired: callback => subscribe('spotify-playback-auth-required', callback),
    onPlaybackError: callback => subscribe('spotify-playback-error', callback),
    onPlaybackCapability: callback => subscribe('spotify-playback-capability', callback),
    onDeviceReady: callback => subscribe('spotify-device-ready', callback),
    onDeviceNotReady: callback => subscribe('spotify-device-not-ready', callback)
  }
});
