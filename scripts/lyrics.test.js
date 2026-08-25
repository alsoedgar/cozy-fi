const assert = require('node:assert/strict');
const {
  MAX_LYRICS_LENGTH,
  MAX_LYRIC_LINES,
  normalizeLyricsLookup,
  sanitizeLyricsRecord,
  parseSyncedLyrics,
  parsePlainLyrics,
  findActiveLineIndex,
  buildLyricsModel
} = require('../js/lyrics');

assert.deepEqual(normalizeLyricsLookup({
  title: '  Morning\nSong  ',
  artist: ' Cozy  Artist ',
  album: ' Café Sessions ',
  durationMs: 233400
}), {
  trackName: 'Morning Song',
  artistName: 'Cozy Artist',
  albumName: 'Café Sessions',
  durationSeconds: 233,
  cacheKey: ['morning song', 'cozy artist', 'café sessions', '233'].join('\u001f')
});
assert.throws(() => normalizeLyricsLookup({ title: 'Missing artist' }), /title and artist/);

const parsed = parseSyncedLyrics([
  '[ar:Cozy Artist]',
  '[offset:+100]',
  '[00:01.2][00:02.34] First line',
  '[00:03.456] ',
  '[01:00] Last line',
  '[00:02.34] First line'
].join('\n'));
assert.deepEqual(parsed, [
  { timeMs: 1300, text: 'First line', isGap: false },
  { timeMs: 2440, text: 'First line', isGap: false },
  { timeMs: 3556, text: '', isGap: true },
  { timeMs: 60100, text: 'Last line', isGap: false }
]);
assert.equal(findActiveLineIndex(parsed, 1299), -1);
assert.equal(findActiveLineIndex(parsed, 1300), 0);
assert.equal(findActiveLineIndex(parsed, 59000), 2);
assert.equal(findActiveLineIndex(parsed, 60100), 3);

assert.deepEqual(parseSyncedLyrics('[00:01.00]<00:01.00>Enhanced <00:01.50>line'), [
  { timeMs: 1000, text: 'Enhanced line', isGap: false }
]);

assert.deepEqual(parsePlainLyrics('One\r\n\r\nTwo'), ['One', '', 'Two']);
assert.equal(parsePlainLyrics(Array(MAX_LYRIC_LINES + 5).fill('Line').join('\n')).length, MAX_LYRIC_LINES);
const trimmedRecord = sanitizeLyricsRecord({
  id: '42',
  name: ' Song ',
  artistName: ' Artist ',
  plainLyrics: 'x'.repeat(MAX_LYRICS_LENGTH + 10)
});
assert.equal(trimmedRecord.id, 42);
assert.equal(trimmedRecord.trackName, 'Song');
assert.equal(trimmedRecord.plainLyrics.length, MAX_LYRICS_LENGTH);

const syncedModel = buildLyricsModel({
  found: true,
  trackName: 'Song',
  artistName: 'Artist',
  plainLyrics: 'Fallback line',
  syncedLyrics: '[00:01.00] Timed line'
});
assert.equal(syncedModel.kind, 'synced');
assert.equal(syncedModel.lines[0].timeMs, 1000);
assert.equal(buildLyricsModel({ found: true, plainLyrics: 'Plain only' }).kind, 'plain');
assert.equal(buildLyricsModel({ found: true, instrumental: true }).kind, 'instrumental');
assert.equal(buildLyricsModel({ found: false, status: 'not_found' }).kind, 'unavailable');
assert.equal(buildLyricsModel({ found: false, status: 'rate_limited', retryAfter: 18 }).kind, 'rate_limited');

console.log('Lyrics parsing, matching-input, and state checks passed.');
