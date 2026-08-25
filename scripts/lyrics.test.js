const assert = require('node:assert/strict');
const {
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

assert.equal(simplifyTrackTitle('New Light (feat. June) - 2026 Remaster'), 'New Light');
assert.equal(simplifyTrackTitle('Keep This (Part 2)'), 'Keep This (Part 2)');
assert.equal(primaryArtistName('Cozy Artist, June'), 'Cozy Artist');
assert.deepEqual(buildLyricsSearchQueries({
  title: 'New Light (feat. June) - 2026 Remaster',
  artist: 'Cozy Artist, June',
  durationMs: 201000
}), [
  { trackName: 'New Light (feat. June) - 2026 Remaster', artistName: 'Cozy Artist, June' },
  { q: 'New Light Cozy Artist' }
]);

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

const expandedLookup = normalizeLyricsLookup({
  title: 'New Light (feat. June) - 2026 Remaster',
  artist: 'Cozy Artist, June',
  album: 'New Light (Deluxe)',
  durationMs: 201000
});
const closeCandidate = {
  id: 7,
  trackName: 'New Light',
  artistName: 'Cozy Artist',
  albumName: 'New Light',
  duration: 200,
  plainLyrics: 'A newer song now has lyrics.',
  syncedLyrics: '[00:01.00] A newer song now has lyrics.'
};
const acceptedCandidate = scoreLyricsCandidate(expandedLookup, closeCandidate);
assert.ok(acceptedCandidate?.score >= 0.8, 'alternate title and featured-artist forms should match');
assert.ok(scoreLyricsCandidate(normalizeLyricsLookup({
  title: 'Déjà Vu!',
  artist: 'Beyoncé',
  durationMs: 240000
}), {
  trackName: 'Deja Vu',
  artistName: 'Beyonce',
  duration: 240,
  plainLyrics: 'Diacritic-insensitive match'
}), 'punctuation and Latin diacritics should not block a safe match');
assert.equal(scoreLyricsCandidate(expandedLookup, {
  ...closeCandidate,
  artistName: 'Completely Different Performer'
}), null);
assert.equal(selectBestLyricsCandidate(expandedLookup, [
  { ...closeCandidate, duration: 245, syncedLyrics: '', plainLyrics: 'Loose match' },
  closeCandidate
]).record.id, 7);

const expandedResult = finalizeLyricsMatch(expandedLookup, acceptedCandidate, 'expanded');
assert.equal(expandedResult.found, true);
assert.equal(expandedResult.matchType, 'expanded');
assert.equal(expandedResult.source, 'lrclib');
assert.ok(expandedResult.syncedLyrics);

const timingMismatch = finalizeLyricsMatch(expandedLookup, scoreLyricsCandidate(expandedLookup, {
  ...closeCandidate,
  duration: 220
}), 'expanded');
assert.equal(timingMismatch.syncedLyrics, '', 'far-off versions should fall back to safely scrollable lyrics');
assert.ok(timingMismatch.plainLyrics);

const importedSynced = createImportedLyricsRecord({
  title: 'New Light',
  artist: 'Cozy Artist',
  durationMs: 201000
}, '[00:01.00] First local line\n[00:04.50] Second local line', 'new-light.lrc');
assert.equal(importedSynced.source, 'local');
assert.equal(importedSynced.matchType, 'local');
assert.equal(parseSyncedLyrics(importedSynced.syncedLyrics).length, 2);
assert.match(importedSynced.plainLyrics, /First local line/);
const importedPlain = createImportedLyricsRecord({ title: 'New Light', artist: 'Cozy Artist' }, 'Just\nplain lyrics', 'new-light.txt');
assert.equal(importedPlain.syncedLyrics, '');
assert.equal(importedPlain.plainLyrics, 'Just\nplain lyrics');
assert.throws(
  () => createImportedLyricsRecord({ title: 'New Light', artist: 'Cozy Artist' }, 'No timestamps', 'bad.lrc'),
  /timestamps/
);

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
