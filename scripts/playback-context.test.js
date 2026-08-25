const assert = require('node:assert/strict');
const {
  resolveContextUri,
  normalizeContextOffset,
  createPlaybackRequest
} = require('../js/playback-context');

assert.equal(resolveContextUri('playlist', 'playlist123'), 'spotify:playlist:playlist123');
assert.equal(resolveContextUri('album', 'album123'), 'spotify:album:album123');
assert.equal(
  resolveContextUri('playlist', 'newPlaylist', 'spotify:playlist:stalePlaylist'),
  'spotify:playlist:newPlaylist'
);
assert.equal(resolveContextUri('liked', 'liked', 'spotify:playlist:stalePlaylist'), null);
assert.equal(resolveContextUri('artist', 'artist123', 'spotify:artist:artist123'), null);

assert.deepEqual(normalizeContextOffset(7), { position: 7 });
assert.deepEqual(normalizeContextOffset('spotify:track:track123'), { uri: 'spotify:track:track123' });
assert.deepEqual(
  normalizeContextOffset({ position: 9, uri: 'spotify:track:track456' }),
  { position: 9, uri: 'spotify:track:track456' }
);
assert.throws(() => normalizeContextOffset({ position: -1 }), /Invalid Spotify playback context position/);
assert.throws(() => normalizeContextOffset({ uri: 'https://example.com' }), /Invalid Spotify playback offset URI/);

const playlistQueue = [
  {
    spotifyUri: 'spotify:track:duplicateTrack',
    playbackContextUri: 'spotify:playlist:playlist123',
    playbackContextPosition: 2
  },
  {
    spotifyUri: 'spotify:track:duplicateTrack',
    playbackContextUri: 'spotify:playlist:playlist123',
    playbackContextPosition: 8
  }
];
assert.deepEqual(createPlaybackRequest(playlistQueue[1], playlistQueue, 1), {
  type: 'context',
  contextUri: 'spotify:playlist:playlist123',
  offset: { position: 8, uri: 'spotify:track:duplicateTrack' }
});

assert.deepEqual(createPlaybackRequest({
  spotifyUri: 'spotify:track:track456',
  playbackContextUri: 'spotify:album:album123',
  playbackContextPosition: null
}, [], 0), {
  type: 'context',
  contextUri: 'spotify:album:album123',
  offset: { uri: 'spotify:track:track456' }
});

const explicitQueue = Array.from({ length: 120 }, (_, index) => ({
  spotifyUri: `spotify:track:track${index}`
}));
const explicitRequest = createPlaybackRequest(explicitQueue[10], explicitQueue, 10);
assert.equal(explicitRequest.type, 'tracks');
assert.equal(explicitRequest.uris.length, 100);
assert.equal(explicitRequest.uris[0], 'spotify:track:track10');
assert.equal(explicitRequest.uris.at(-1), 'spotify:track:track109');

async function testPlaybackCommandOrdering() {
  const calls = [];
  let releaseFirstCommand;
  const firstCommandGate = new Promise(resolve => { releaseFirstCommand = resolve; });
  const noop = () => {};
  global.window = {
    cozyApi: {
      auth: {
        getConfig: async () => ({ clientId: 'test' }),
        getStatus: async () => true,
        connect: async () => true,
        disconnect: async () => true
      },
      events: {
        onConnectionSuccess: noop,
        onConnectionLogout: noop,
        onConnectionError: noop,
        onPlaybackError: noop,
        onPlaybackCapability: noop,
        onDeviceReady: noop,
        onDeviceNotReady: noop
      },
      spotify: {
        getPlaybackCapability: async () => ({ mode: 'standalone', preference: 'auto', canPlayLocally: true }),
        playTrack: async uri => {
          calls.push(`play:${uri}`);
          await firstCommandGate;
        },
        next: async () => { calls.push('next'); },
        previous: async () => { calls.push('previous'); }
      }
    },
    dispatchEvent: noop
  };

  const SpotifyClient = require('../js/spotify');
  const client = new SpotifyClient();
  await client.ready;
  const playPromise = client.playTrack('spotify:track:track1');
  const nextPromise = client.next();
  const previousPromise = client.prev();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['play:spotify:track:track1']);
  releaseFirstCommand();
  await Promise.all([playPromise, nextPromise, previousPromise]);
  assert.deepEqual(calls, ['play:spotify:track:track1', 'next', 'previous']);
  delete global.window;
}

testPlaybackCommandOrdering()
  .then(() => console.log('Playback context and command-order checks passed.'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
