// One playback session shared by both windows. Queue IDs identify occurrences,
// so removing one copy of a song never removes another copy of the same song.
const { randomUUID } = require('node:crypto');

function normalizeTrack(value) {
  const track = typeof value === 'string' ? { uri: value } : value;
  const uri = track?.uri || track?.spotifyUri;
  if (!/^spotify:track:[A-Za-z0-9]+$/.test(uri || '') || track?.is_local || track?.is_playable === false) return null;
  return {
    id: uri.split(':')[2], uri, type: 'track',
    name: String(track.name || track.title || 'Spotify track').slice(0, 240),
    artists: Array.isArray(track.artists)
      ? track.artists.map(artist => ({ id: artist.id, name: String(artist.name || '').slice(0, 240) }))
      : [{ name: String(track.artist || 'Spotify').slice(0, 240) }],
    album: track.album && typeof track.album === 'object' ? track.album : {
      name: String(track.album || 'Single').slice(0, 240), images: track.cover ? [{ url: track.cover }] : []
    },
    duration_ms: Math.max(0, Number(track.duration_ms || track.durationMs) || 0),
    external_urls: { spotify: `https://open.spotify.com/track/${uri.split(':')[2]}` },
    cozy_context_position: track.cozy_context_position
  };
}

class PlaybackQueue {
  constructor({ request, device, publish = () => {}, random = Math.random }) {
    this.request = request;
    this.device = device;
    this.publish = publish;
    this.random = random;
    this.chain = Promise.resolve();
    this.reset();
  }

  reset() {
    this.generation = (this.generation || 0) + 1;
    this.entries = [];
    this.index = -1;
    this.context = null;
    this.shuffle = false;
    this.revision = (this.revision || 0) + 1;
    this.windowIds = [];
    this.lastState = null;
    this.acknowledgedState = null;
    this.commandAt = 0;
    this.publish(this.snapshot());
  }

  run(operation) {
    const generation = this.generation;
    const execute = async () => {
      if (generation !== this.generation) throw new Error('The playback session changed.');
      return operation(generation);
    };
    const result = this.chain.then(execute, execute);
    this.chain = result.catch(() => {});
    return result;
  }

  endpoint(action) {
    return `v1/me/player/${action}?device_id=${encodeURIComponent(this.device())}`;
  }

  snapshot() {
    return {
      currentlyPlaying: this.entries[this.index] || null,
      queue: this.entries.slice(this.index + 1),
      context: this.context, shuffle: this.shuffle, revision: this.revision,
      managed: this.entries.length > 0
    };
  }

  changed() {
    this.revision += 1;
    const snapshot = this.snapshot();
    this.publish(snapshot);
    return snapshot;
  }

  entry(track, order, source = 'context') {
    const normalized = normalizeTrack(track);
    return normalized ? { ...normalized, queueId: randomUUID(), order, source } : null;
  }

  shuffleUpcoming(entries, index, enabled) {
    const history = entries.slice(0, index + 1);
    const upcoming = entries.slice(index + 1);
    if (enabled) {
      for (let i = upcoming.length - 1; i > 0; i -= 1) {
        const j = Math.floor(this.random() * (i + 1));
        [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]];
      }
    } else upcoming.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'queue' ? -1 : 1;
      return a.order - b.order;
    });
    return [...history, ...upcoming];
  }

  stage(track) {
    return this.run(() => {
      const entry = this.entry(track, Date.now(), 'queue');
      if (!entry) throw new Error('This song is unavailable for playback.');
      this.entries.push(entry);
      return this.changed();
    });
  }

  adopt(currentTrack, upcomingTracks = []) {
    const current = this.entry(currentTrack, 0, 'current');
    if (!current) return false;
    const upcoming = (Array.isArray(upcomingTracks) ? upcomingTracks : [])
      .map((track, index) => this.entry(track, index + 1, 'queue'))
      .filter(Boolean);
    this.entries = [current, ...upcoming];
    this.index = 0;
    this.context = null;
    this.shuffle = false;
    this.windowIds = this.entries.map(entry => entry.queueId);
    this.commandAt = 0;
    this.lastState = null;
    this.acknowledgedState = null;
    this.changed();
    return true;
  }

  async write(entries, index, positionMs = 0, paused = false, nativeBody = null) {
    const first = Math.max(0, index - 10);
    const window = entries.slice(first, first + 100);
    // Native shuffle would reorder our explicit list a second time.
    await this.request(`${this.endpoint('shuffle')}&state=false`, 'PUT');
    await this.request(this.endpoint('play'), 'PUT', nativeBody || {
      uris: window.map(entry => entry.uri), offset: { position: index - first },
      position_ms: Math.max(0, Math.floor(positionMs))
    });
    if (paused) await this.request(this.endpoint('pause'), 'PUT');
    return nativeBody ? entries.map(entry => entry.queueId) : window.map(entry => entry.queueId);
  }

  start(tracks, selectedIndex = 0, context = null, offset = null) {
    return this.run(async generation => {
      const selected = normalizeTrack(tracks[selectedIndex]);
      if (!selected) throw new Error('This song is unavailable for playback.');
      let entries = tracks.map((track, index) => this.entry(track, index)).filter(Boolean);
      let index = entries.findIndex(entry => entry.order === selectedIndex);
      const added = this.entries.slice(this.index + 1).filter(entry => entry.source === 'queue');
      entries.splice(index + 1, 0, ...added);
      if (this.shuffle) entries = this.shuffleUpcoming(entries, index, true);
      const nativeBody = context?.uri && !this.shuffle && added.length === 0 ? {
        context_uri: context.uri,
        offset: offset?.position !== undefined ? { position: offset.position } : { uri: selected.uri }
      } : null;
      await this.request(`${this.endpoint('repeat')}&state=off`, 'PUT');
      const windowIds = await this.write(entries, index, 0, false, nativeBody);
      if (generation !== this.generation) throw new Error('The playback session changed.');
      Object.assign(this, { entries, index, context, windowIds, commandAt: Date.now(), lastState: null });
      this.acknowledgedState = { item: entries[index], is_playing: true, progress_ms: 0, device: { id: this.device() } };
      return this.changed();
    });
  }

  async readState() {
    const state = await this.request('v1/me/player?additional_types=episode');
    if (this.acknowledgedState && Date.now() - this.commandAt < 1800 && state?.device?.id === this.device()) {
      return { ...this.acknowledgedState, progress_ms: this.acknowledgedState.progress_ms +
        (this.acknowledgedState.is_playing ? Date.now() - this.commandAt : 0) };
    }
    return state?.device?.id === this.device() ? state : null;
  }

  transport(action, positionMs) {
    return this.run(async () => {
      const endpoint = this.endpoint(action === 'resume' ? 'play' : action);
      const result = await this.request(action === 'seek' ? `${endpoint}&position_ms=${positionMs}` : endpoint, 'PUT');
      // A deliberate pause or seek takes precedence over optimistic track state.
      this.acknowledgedState = null;
      this.lastState = null;
      this.commandAt = 0;
      return result;
    });
  }

  async reconcile(state) {
    if (!state?.item || this.index < 0) return false;
    const current = this.entries[this.index];
    // Connect can briefly report the old song after acknowledging a command.
    if (Date.now() - this.commandAt < 1800 && state.item.uri !== current?.uri) return false;
    if (Date.now() - this.commandAt >= 1800 && this.context?.uri &&
      /^spotify:(playlist|album):/.test(state.context?.uri || '') && state.context.uri !== this.context.uri) {
      this.reset();
      return true;
    }
    let index = this.index;
    const sameUri = state.item.uri === current?.uri;
    const looped = sameUri && this.entries[index + 1]?.uri === current.uri &&
      this.lastState?.progress_ms > 3000 && state.progress_ms < this.lastState.progress_ms - 2000 &&
      this.lastState.progress_ms > (current.duration_ms || state.item.duration_ms) - 12000;
    if (!sameUri || looped) {
      index = this.entries.findIndex((entry, candidate) => candidate > this.index &&
        entry.uri === state.item.uri && this.windowIds.includes(entry.queueId));
      if (index < 0 && !looped) index = this.entries.findLastIndex((entry, candidate) =>
        candidate < this.index && entry.uri === state.item.uri && this.windowIds.includes(entry.queueId));
      if (index < 0) {
        // Another Spotify controller took over. Never overwrite its new session.
        this.reset();
        return true;
      }
    }
    const changed = index !== this.index;
    this.index = index;
    this.lastState = state;
    if (changed) this.changed();
    return changed;
  }

  observe() {
    return this.run(async generation => {
      const state = await this.readState();
      if (generation !== this.generation) return null;
      await this.reconcile(state);
      if (this.index >= 0 && state?.item?.uri === this.entries[this.index]?.uri) {
        const at = this.windowIds.indexOf(this.entries[this.index].queueId);
        const more = this.windowIds.at(-1) !== this.entries.at(-1)?.queueId;
        if (more && at >= this.windowIds.length - 8 && state.is_playing) {
          const windowIds = await this.write(this.entries, this.index, state.progress_ms);
          if (generation !== this.generation) return null;
          this.windowIds = windowIds;
          this.commandAt = Date.now();
          this.acknowledgedState = state;
        }
        return { ...state, context: this.context ? { uri: this.context.uri } : state.context, shuffle_state: this.shuffle };
      }
      return state;
    });
  }

  edit(action, value, expectedRevision) {
    return this.run(async generation => {
      const pending = this.index < 0;
      const state = pending ? { progress_ms: 0, is_playing: false } : await this.readState();
      if (generation !== this.generation) throw new Error('The playback session changed.');
      await this.reconcile(state);
      if (expectedRevision !== undefined && expectedRevision !== this.revision) {
        throw new Error('The queue changed. Please try that action again.');
      }
      if (!pending && (this.index < 0 || !state?.item || state.item.uri !== this.entries[this.index]?.uri)) {
        throw new Error('Choose a song or playlist in Cozy-Fi to start an editable queue.');
      }
      let entries = [...this.entries];
      let index = this.index;
      let shuffle = this.shuffle;
      let positionMs = state.progress_ms || 0;
      let paused = !state.is_playing;
      const findUpcoming = id => {
        const found = entries.findIndex(entry => entry.queueId === id);
        if (found <= index) throw new Error('That song is no longer in the upcoming queue.');
        return found;
      };
      if (action === 'add') {
        const entry = this.entry(value, Date.now(), 'queue');
        if (!entry) throw new Error('This song is unavailable for playback.');
        const lastAdded = entries.findLastIndex((entry, candidate) => candidate > index && entry.source === 'queue');
        entries.splice(Math.max(index, lastAdded) + 1, 0, entry);
      } else if (action === 'remove') entries.splice(findUpcoming(value), 1);
      else if (action === 'move') {
        const from = findUpcoming(value.id);
        const to = value.beforeId ? findUpcoming(value.beforeId) : entries.length;
        const [entry] = entries.splice(from, 1);
        if (!value.beforeId) entries.push(entry);
        else entries.splice(from < to ? to - 1 : to, 0, entry);
      } else if (action === 'shuffle') {
        shuffle = Boolean(value);
        entries = this.shuffleUpcoming(entries, index, shuffle);
      } else if (action === 'play') {
        index = findUpcoming(value);
        positionMs = 0;
        paused = false;
      } else if (action === 'next') {
        if (index + 1 >= entries.length) {
          await this.request(this.endpoint('pause'), 'PUT');
          this.acknowledgedState = { ...state, is_playing: false };
          this.commandAt = Date.now();
          return this.snapshot();
        }
        index += 1;
        positionMs = 0;
        paused = false;
      } else if (action === 'previous') {
        if (positionMs < 3000) index = Math.max(0, index - 1);
        positionMs = 0;
        paused = false;
      } else throw new Error('Unknown queue action.');
      if (index < 0) {
        Object.assign(this, { entries, shuffle });
        return this.changed();
      }
      const windowIds = await this.write(entries, index, positionMs, paused);
      if (generation !== this.generation) throw new Error('The playback session changed.');
      Object.assign(this, { entries, index, shuffle, windowIds, commandAt: Date.now(), lastState: null });
      this.acknowledgedState = { ...state, item: entries[index], progress_ms: positionMs, is_playing: !paused };
      return this.changed();
    });
  }
}

module.exports = { PlaybackQueue, normalizeTrack };
