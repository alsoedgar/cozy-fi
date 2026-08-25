(function exposePlaybackContext(globalScope, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.CozyPlaybackContext = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const CONTEXT_TYPES = new Set(['playlist', 'album']);
  const SPOTIFY_ID_PATTERN = /^[A-Za-z0-9]{1,128}$/;
  const TRACK_URI_PATTERN = /^spotify:track:[A-Za-z0-9]+$/;
  const CONTEXT_URI_PATTERN = /^spotify:(playlist|album):[A-Za-z0-9]+$/;

  function resolveContextUri(itemType, itemId, providedUri = null) {
    const contextType = itemType === 'playlist' || itemType === 'album' ? itemType : null;
    if (!contextType) return null;

    const normalizedId = typeof itemId === 'string' ? itemId.trim() : '';
    const expectedUri = SPOTIFY_ID_PATTERN.test(normalizedId)
      ? `spotify:${contextType}:${normalizedId}`
      : null;
    const candidate = typeof providedUri === 'string' ? providedUri.trim() : '';
    const candidateMatch = CONTEXT_URI_PATTERN.exec(candidate);
    if (candidateMatch?.[1] === contextType && (!expectedUri || candidate === expectedUri)) return candidate;

    return expectedUri;
  }

  function normalizeContextOffset(rawOffset) {
    if (rawOffset === null || rawOffset === undefined || rawOffset === '') return null;

    const candidate = typeof rawOffset === 'object' && !Array.isArray(rawOffset)
      ? rawOffset
      : Number.isInteger(rawOffset)
        ? { position: rawOffset }
        : { uri: rawOffset };
    const normalized = {};

    if (candidate.position !== null && candidate.position !== undefined && candidate.position !== '') {
      const position = Number(candidate.position);
      if (!Number.isSafeInteger(position) || position < 0) {
        throw new Error('Invalid Spotify playback context position.');
      }
      normalized.position = position;
    }

    if (candidate.uri !== null && candidate.uri !== undefined && candidate.uri !== '') {
      const uri = typeof candidate.uri === 'string' ? candidate.uri.trim() : '';
      if (!TRACK_URI_PATTERN.test(uri)) throw new Error('Invalid Spotify playback offset URI.');
      normalized.uri = uri;
    }

    if (normalized.position === undefined && !normalized.uri) {
      throw new Error('A Spotify playback offset needs a track position or URI.');
    }
    return normalized;
  }

  function createPlaybackRequest(track, queue, selectedIndex, maxExplicitTracks = 100) {
    const selectedTrack = track && typeof track === 'object' ? track : {};
    const selectedUri = typeof selectedTrack.spotifyUri === 'string'
      ? selectedTrack.spotifyUri.trim()
      : '';
    const contextUri = typeof selectedTrack.playbackContextUri === 'string'
      ? selectedTrack.playbackContextUri.trim()
      : '';

    if (CONTEXT_URI_PATTERN.test(contextUri) && TRACK_URI_PATTERN.test(selectedUri)) {
      const rawPosition = selectedTrack.playbackContextPosition;
      const position = rawPosition === null || rawPosition === undefined || rawPosition === ''
        ? null
        : Number(rawPosition);
      const offset = normalizeContextOffset({
        position: Number.isSafeInteger(position) && position >= 0 ? position : undefined,
        uri: selectedUri
      });
      return { type: 'context', contextUri, offset };
    }

    const tracks = Array.isArray(queue) ? queue : [];
    const fallbackIndex = tracks.indexOf(track);
    const startIndex = Number.isSafeInteger(selectedIndex) && selectedIndex >= 0
      ? selectedIndex
      : Math.max(0, fallbackIndex);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(maxExplicitTracks) || 100)));
    const uris = tracks
      .slice(startIndex)
      .map(item => typeof item?.spotifyUri === 'string' ? item.spotifyUri.trim() : '')
      .filter(uri => TRACK_URI_PATTERN.test(uri))
      .slice(0, limit);

    if (uris.length === 0 && TRACK_URI_PATTERN.test(selectedUri)) uris.push(selectedUri);
    if (uris.length === 0) throw new Error('No playable Spotify tracks were provided.');
    return { type: 'tracks', uris };
  }

  return {
    CONTEXT_TYPES,
    resolveContextUri,
    normalizeContextOffset,
    createPlaybackRequest
  };
});
