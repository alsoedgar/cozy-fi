const assert = require('node:assert/strict');
const test = require('node:test');
const { PlaybackQueue, normalizeTrack } = require('../js/playback-queue');

const song = (id, position) => ({ id, uri: `spotify:track:${id}`, name: id, artists: [{ id: 'artist', name: 'Artist' }], duration_ms: 180000, cozy_context_position: position });
function fixture() {
  const calls = [];
  const events = [];
  let state = { device: { id: 'device' }, item: null, progress_ms: 0, is_playing: false };
  let failure = null;
  const queue = new PlaybackQueue({
    device: () => 'device', random: () => 0,
    publish: value => events.push(value),
    request: async (endpoint, method = 'GET', body) => {
      calls.push({ endpoint, method, body });
      if (failure?.(endpoint, method, body)) throw new Error('Network failed');
      if (method === 'GET') return structuredClone(state);
      if (endpoint.includes('/play?') && body) {
        const uri = body.uris?.[body.offset?.position || 0] || body.offset.uri;
        if (uri) state.item = song(uri.split(':')[2]);
        state.progress_ms = body.position_ms || 0;
        state.is_playing = true;
      }
      if (endpoint.includes('/pause?')) state.is_playing = false;
      return true;
    }
  });
  return { queue, calls, events, state: value => { state = { ...state, ...value }; queue.commandAt = 0; }, fail: value => { failure = value; } };
}

test('playlist starts at selected occurrence and retains the playlist context', async () => {
  const f = fixture();
  const tracks = [song('a', 0), song('duplicate', 2), song('b', 4), song('duplicate', 9), song('c', 10)];
  await f.queue.start(tracks, 3, { uri: 'spotify:playlist:list', name: 'Playlist' }, { position: 9, uri: tracks[3].uri });
  const play = f.calls.find(call => call.body?.context_uri);
  assert.deepEqual(play.body, { context_uri: 'spotify:playlist:list', offset: { position: 9 } });
  assert.deepEqual(f.queue.snapshot().queue.map(track => track.id), ['c']);
  f.state({ item: tracks[3], progress_ms: 2000, is_playing: true });
  await f.queue.edit('next');
  assert.equal(f.queue.snapshot().currentlyPlaying.id, 'c');
  assert.equal(f.queue.snapshot().context.uri, 'spotify:playlist:list');
  await f.queue.edit('previous');
  assert.equal(f.queue.snapshot().currentlyPlaying.id, 'duplicate');
  assert.equal(f.queue.snapshot().currentlyPlaying.cozy_context_position, 9);
});

test('shuffle keeps current song, retains duplicates, and restores remaining list order', async () => {
  const f = fixture();
  await f.queue.start(['a', 'b', 'b', 'c', 'd'].map(id => song(id)));
  const before = f.queue.snapshot();
  await f.queue.edit('shuffle', true, before.revision);
  const shuffled = f.queue.snapshot();
  assert.equal(shuffled.currentlyPlaying.queueId, before.currentlyPlaying.queueId);
  assert.deepEqual(new Set(shuffled.queue.map(track => track.queueId)), new Set(before.queue.map(track => track.queueId)));
  assert.notDeepEqual(shuffled.queue, before.queue);
  await f.queue.edit('shuffle', false);
  assert.deepEqual(f.queue.snapshot().queue.map(track => track.queueId), before.queue.map(track => track.queueId));
});

test('add, reorder and remove preserve paused position and playlist continuation', async () => {
  const f = fixture();
  await f.queue.start(['a', 'b', 'b', 'c'].map(id => song(id)));
  f.state({ item: song('a'), progress_ms: 45000, is_playing: false });
  await f.queue.edit('add', song('extra'));
  assert.deepEqual(f.queue.snapshot().queue.map(track => track.id), ['extra', 'b', 'b', 'c']);
  const lastPlay = f.calls.findLast(call => call.body?.uris);
  assert.equal(lastPlay.body.position_ms, 45000);
  assert.ok(f.calls.at(-1).endpoint.includes('/pause?'));
  const queue = f.queue.snapshot().queue;
  await f.queue.edit('remove', queue[1].queueId);
  assert.deepEqual(f.queue.snapshot().queue.map(track => track.queueId), [queue[0].queueId, queue[2].queueId, queue[3].queueId]);
  await f.queue.edit('move', { id: queue[3].queueId, beforeId: queue[0].queueId });
  assert.deepEqual(f.queue.snapshot().queue.map(track => track.id), ['c', 'extra', 'b']);
  await f.queue.edit('play', queue[0].queueId);
  assert.equal(f.queue.snapshot().currentlyPlaying.id, 'extra');
  assert.deepEqual(f.queue.snapshot().queue.map(track => track.id), ['b']);
});

test('manual additions survive selecting a new playlist', async () => {
  const f = fixture();
  await f.queue.start([song('a'), song('b')]);
  await f.queue.edit('add', song('manual'));
  await f.queue.start([song('c'), song('d')], 0, { uri: 'spotify:playlist:new' });
  assert.deepEqual(f.queue.snapshot().queue.map(track => track.id), ['manual', 'd']);
  assert.ok(f.calls.at(-1).body.uris);
});

test('adding before playback builds an editable queue without starting audio', async () => {
  const f = fixture();
  await f.queue.stage(song('a'));
  await f.queue.stage(song('b'));
  await f.queue.stage(song('c'));
  assert.equal(f.calls.length, 0);
  const first = f.queue.snapshot().queue[0].queueId;
  await f.queue.edit('remove', first);
  await f.queue.edit('shuffle', true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.queue.snapshot().currentlyPlaying, null);
  const selected = f.queue.snapshot().queue[0];
  await f.queue.edit('play', selected.queueId);
  assert.equal(f.queue.snapshot().currentlyPlaying.id, selected.id);
  assert.equal(f.queue.snapshot().queue.length, 1);
});

test('a queue started in another Spotify controller can be adopted and edited', async () => {
  const f = fixture();
  assert.equal(f.queue.adopt(song('playing'), [song('b'), song('c'), song('d')]), true);
  f.state({ item: song('playing'), progress_ms: 0, is_playing: true });
  assert.equal(f.queue.snapshot().managed, true);
  await f.queue.edit('remove', f.queue.snapshot().queue[0].queueId);
  assert.deepEqual(f.queue.snapshot().queue.map(track => track.id), ['c', 'd']);
  await f.queue.edit('move', { id: f.queue.snapshot().queue[1].queueId, beforeId: f.queue.snapshot().queue[0].queueId });
  assert.deepEqual(f.queue.snapshot().queue.map(track => track.id), ['d', 'c']);
});

test('moving a song down inserts it before the requested row', async () => {
  const f = fixture();
  await f.queue.start([song('a'), song('b'), song('c'), song('d')]);
  const queue = f.queue.snapshot().queue;
  await f.queue.edit('move', { id: queue[0].queueId, beforeId: queue[2].queueId });
  assert.deepEqual(f.queue.snapshot().queue.map(track => track.id), ['c', 'b', 'd']);
});

test('long queues roll forward without dropping tracks beyond the API window', async () => {
  const f = fixture();
  const tracks = Array.from({ length: 240 }, (_, i) => song(`t${i}`));
  await f.queue.start(tracks);
  assert.equal(f.queue.snapshot().queue.length, 239);
  assert.equal(f.calls.at(-1).body.uris.length, 100);
  f.state({ item: tracks[93], progress_ms: 25000, is_playing: true });
  await f.queue.observe();
  assert.equal(f.queue.snapshot().currentlyPlaying.id, 't93');
  assert.equal(f.queue.snapshot().queue.at(-1).id, 't239');
  const body = f.calls.at(-1).body;
  assert.equal(body.uris[body.offset.position], tracks[93].uri);
  assert.equal(body.position_ms, 25000);
  assert.equal(body.uris.length, 100);
  await f.queue.observe();
  assert.equal(f.queue.snapshot().currentlyPlaying.id, 't93', 'an immediate poll must not resurrect the previous playback window');
});

test('stale edits and failed writes leave the queue intact', async () => {
  const f = fixture();
  await f.queue.start([song('a'), song('b'), song('c')]);
  const before = f.queue.snapshot();
  await assert.rejects(f.queue.edit('remove', before.queue[0].queueId, before.revision - 1), /queue changed/);
  f.fail(endpoint => endpoint.includes('/play?'));
  await assert.rejects(f.queue.edit('remove', before.queue[0].queueId), /Network failed/);
  assert.deepEqual(f.queue.snapshot(), before);
  f.fail(null);
  await f.queue.edit('remove', before.queue[0].queueId);
  assert.equal(f.queue.snapshot().queue[0].id, 'c');
});

test('rapid next commands are serialized despite a stale Connect response', async () => {
  const f = fixture();
  await f.queue.start([song('a'), song('b'), song('c'), song('d')]);
  await Promise.all([f.queue.edit('next'), f.queue.edit('next')]);
  assert.equal(f.queue.snapshot().currentlyPlaying.id, 'c');
});

test('consecutive copies advance by occurrence on a natural track boundary', async () => {
  const f = fixture();
  await f.queue.start([song('a'), song('a'), song('b')]);
  const nextId = f.queue.snapshot().queue[0].queueId;
  f.state({ item: song('a'), progress_ms: 178000, is_playing: true });
  await f.queue.observe();
  f.state({ item: song('a'), progress_ms: 1000, is_playing: true });
  await f.queue.observe();
  assert.equal(f.queue.snapshot().currentlyPlaying.queueId, nextId);
});

test('external takeovers and logout do not revive stale queue state', async () => {
  const f = fixture();
  await f.queue.start([song('a'), song('b')]);
  f.state({ item: song('outside'), progress_ms: 0, is_playing: true });
  const writes = f.calls.filter(call => call.method === 'PUT').length;
  await f.queue.observe();
  assert.equal(f.queue.snapshot().managed, false);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, writes);
  const pending = f.queue.start([song('a')]);
  f.queue.reset();
  await assert.rejects(pending, /session changed/);
  assert.equal(f.queue.snapshot().managed, false);
});

test('local, unavailable and non-track URIs are rejected', () => {
  assert.equal(normalizeTrack({ ...song('a'), is_playable: false }), null);
  assert.equal(normalizeTrack({ ...song('a'), is_local: true }), null);
  assert.equal(normalizeTrack('spotify:episode:a'), null);
  assert.equal(normalizeTrack('https://example.com'), null);
});
