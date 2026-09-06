// Shared, keyboard-accessible queue popover for the full and compact players.
(function () {
  class QueuePanel {
    constructor({ api, panel, toggle, shuffle, similar, getTrack, canControl, onPlayback, onError }) {
      Object.assign(this, { api, panel, toggle, shuffle, similar, getTrack, canControl, onPlayback, onError });
      this.state = { queue: [], managed: false };
      this.busy = false;
      this.limit = 40;
      this.generation = 0;
      this.searchGeneration = 0;
      this.panel.classList.add('queue-popover');
      this.panel.setAttribute('role', 'dialog');
      this.panel.setAttribute('aria-label', 'Playback queue');
      this.panel.tabIndex = -1;
      this.panel.innerHTML = `
        <header class="queue-heading"><strong>UP NEXT <span data-count></span></strong><button type="button" data-close aria-label="Close queue">CLOSE</button></header>
        <p class="queue-context" data-context></p>
        <div class="queue-now" data-now></div>
        <form class="queue-search" role="search"><input type="search" aria-label="Find songs to add to queue" placeholder="Find a song to add…" maxlength="200"><button type="submit">FIND</button></form>
        <p class="queue-feedback" data-feedback role="status" aria-live="polite"></p>
        <div class="queue-results" data-results></div>
        <div class="queue-list" data-list></div>
        <button type="button" data-more hidden>SHOW MORE</button>`;
      this.list = panel.querySelector('[data-list]');
      this.results = panel.querySelector('[data-results]');
      this.feedback = panel.querySelector('[data-feedback]');
      toggle.addEventListener('click', event => { event.stopPropagation(); this.setExpanded(!this.expanded, true); });
      panel.querySelector('[data-close]').addEventListener('click', () => this.setExpanded(false, true));
      panel.querySelector('[data-more]').addEventListener('click', () => { this.limit += 40; this.render(); });
      panel.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        void this.search(panel.querySelector('input').value.trim());
      });
      panel.querySelector('input').addEventListener('input', () => { this.searchGeneration += 1; });
      document.addEventListener('click', event => {
        // Row actions can redraw their target before the event reaches document.
        // The event path retains its original ancestors after that redraw.
        const path = event.composedPath();
        if (this.expanded && ![panel, toggle, similar, shuffle].some(element => path.includes(element))) this.setExpanded(false);
      });
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && this.expanded) { event.preventDefault(); this.setExpanded(false, true); }
      });
      shuffle?.addEventListener('click', () => this.command('shuffle', !this.state.shuffle));
      similar?.addEventListener('click', () => this.findSimilar());
      api.onQueueChanged?.(state => {
        this.generation += 1;
        if (!state?.currentlyPlaying) { this.searchGeneration += 1; this.results.replaceChildren(); this.feedback.textContent = ''; }
        this.accept(state);
      });
      window.addEventListener('cozy-network-changed', () => this.render());
      this.setExpanded(false);
      this.updateControls();
    }

    get expanded() { return this.panel.style.display === 'block'; }
    get available() { return this.canControl() && window.CozyNetwork?.online !== false; }

    updateControls() {
      this.toggle.disabled = false; // The saved queue remains readable while offline.
      if (this.shuffle) {
        this.shuffle.disabled = !this.available || !this.state.managed || this.busy;
        this.shuffle.setAttribute('aria-pressed', String(Boolean(this.state.shuffle)));
        this.shuffle.title = this.state.shuffle ? 'Turn shuffle off' : 'Shuffle upcoming songs';
      }
      if (this.similar) this.similar.disabled = !this.available || !/^spotify:track:/.test(this.getTrack()?.spotifyUri || this.getTrack()?.uri || '');
      this.results.querySelectorAll('button').forEach(button => { button.disabled = !this.available || this.busy; });
    }

    setExpanded(expanded, focus = false) {
      this.panel.style.display = expanded ? 'block' : 'none';
      this.toggle.setAttribute('aria-expanded', String(expanded));
      if (expanded) { void this.refresh(); if (focus) this.panel.focus(); }
      else if (focus) this.toggle.focus();
    }

    async refresh() {
      const generation = ++this.generation;
      try {
        const state = await this.api.getQueue();
        if (generation === this.generation) this.accept(state);
      } catch (error) {
        if (generation === this.generation) this.feedback.textContent = error.message || 'Could not refresh the queue. Open it again to retry.';
      }
    }

    accept(state) {
      // An older read must not replace a newer event from the other window.
      if (state?.revision && this.state?.revision > state.revision) return;
      this.state = state || { queue: [] };
      this.render();
    }

    button(text, label, action, disabled = false) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.setAttribute('aria-label', label);
      button.disabled = disabled || this.busy || !this.available;
      button.addEventListener('click', action);
      return button;
    }

    trackRow(track) {
      const row = document.createElement('div');
      row.className = 'queue-item';
      const imageUrl = track.album?.images?.[0]?.url;
      if (typeof imageUrl === 'string' && imageUrl.startsWith('https://')) {
        const image = document.createElement('img');
        image.src = imageUrl;
        image.alt = '';
        image.loading = 'lazy';
        image.addEventListener('error', () => { image.hidden = true; });
        row.append(image);
      }
      const details = document.createElement('div');
      details.className = 'queue-item-copy';
      const title = document.createElement('strong');
      title.textContent = track.name || 'Spotify track';
      const artist = document.createElement('span');
      artist.textContent = (track.artists || []).map(artist => artist.name).join(', ');
      details.append(title, artist);
      row.append(details);
      return row;
    }

    render() {
      this.updateControls();
      const focused = document.activeElement?.dataset?.queueFocus;
      const scrollTop = this.panel.scrollTop;
      const queue = this.state.queue || [];
      this.panel.querySelector('[data-count]').textContent = `· ${queue.length}`;
      this.panel.querySelector('[data-context]').textContent = this.state.external
        ? 'Playback controls are in Spotify in this mode.'
        : this.state.managed ? `${this.state.context?.name || 'Your session'}${this.state.shuffle ? ' · Shuffle on' : ''}`
          : 'Choose a song or playlist in Cozy-Fi to start an editable queue.';
      const now = this.panel.querySelector('[data-now]');
      now.replaceChildren();
      if (this.state.currentlyPlaying) {
        const label = document.createElement('span');
        label.className = 'queue-section-label';
        label.textContent = 'NOW PLAYING';
        now.append(label, this.trackRow(this.state.currentlyPlaying));
      }
      this.list.replaceChildren();
      if (!queue.length) this.list.textContent = 'No songs up next. Find a song above or use + QUEUE in your library.';
      queue.slice(0, this.limit).forEach((track, index) => {
        const row = this.trackRow(track);
        row.dataset.queueId = track.queueId || '';
        if (this.state.managed) {
          const actions = document.createElement('div');
          actions.className = 'queue-item-actions';
          const addButton = (text, label, command, disabled) => {
            const button = this.button(text, `${label} ${track.name}`, command, disabled);
            button.dataset.queueFocus = `${track.queueId}:${text}`;
            actions.append(button);
          };
          addButton('PLAY', 'Play', () => this.command('play', track.queueId));
          addButton('↑', 'Move up', () => this.command('move', { id: track.queueId, beforeId: queue[index - 1]?.queueId }), index === 0);
          addButton('↓', 'Move down', () => this.command('move', {
            id: track.queueId,
            beforeId: queue[index + 2]?.queueId || null
          }), index === queue.length - 1);
          addButton('×', 'Remove', () => this.command('remove', track.queueId));
          row.append(actions);
          row.draggable = this.available && !this.busy;
          row.addEventListener('dragstart', event => {
            this.dragRevision = this.state.revision;
            event.dataTransfer.setData('text/plain', track.queueId);
            event.dataTransfer.effectAllowed = 'move';
          });
          row.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; });
          row.addEventListener('drop', event => {
            event.preventDefault();
            const id = event.dataTransfer.getData('text/plain');
            if (id && id !== track.queueId) this.command('move', { id, beforeId: track.queueId }, this.dragRevision);
          });
        }
        this.list.append(row);
      });
      this.panel.querySelector('[data-more]').hidden = queue.length <= this.limit;
      this.panel.querySelector('input').disabled = !this.available;
      this.panel.querySelector('[type="submit"]').disabled = !this.available || this.busy;
      if (focused) Array.from(this.list.querySelectorAll('button')).find(button => button.dataset.queueFocus === focused)?.focus({ preventScroll: true });
      this.panel.scrollTop = scrollTop;
    }

    async command(action, value, revision = this.state.revision) {
      if (this.busy || !this.available) return;
      const active = document.activeElement;
      const focusKey = active?.dataset?.queueFocus;
      this.busy = true;
      this.render();
      try {
        this.accept(await this.api.editQueue(action, value, revision));
        this.feedback.textContent = action === 'shuffle' ? `Shuffle ${value ? 'on' : 'off'}.` : 'Queue updated.';
        this.onPlayback?.(action === 'play' ? true : undefined);
      } catch (error) {
        this.feedback.textContent = error.message || 'Could not update the queue.';
        if (!this.expanded) this.onError?.(this.feedback.textContent);
        await this.refresh();
      } finally {
        this.busy = false;
        this.render();
        if (focusKey) {
          const target = Array.from(this.list.querySelectorAll('button')).find(button => button.dataset.queueFocus === focusKey)
            || this.list.querySelector('button') || this.panel;
          target.focus({ preventScroll: true });
        } else if (active === this.shuffle) active.focus({ preventScroll: true });
      }
    }

    async search(query) {
      if (!query || !this.available) return;
      const generation = ++this.searchGeneration;
      this.feedback.textContent = 'Finding songs…';
      this.results.replaceChildren();
      try {
        const result = await this.api.search(query);
        if (generation !== this.searchGeneration) return;
        this.renderResults(result.items || []);
        this.feedback.textContent = result.items?.length ? 'Select + to add a song.' : 'No matching songs. Try another search.';
      } catch (error) { if (generation === this.searchGeneration) this.feedback.textContent = error.message; }
    }

    async findSimilar() {
      const uri = this.getTrack()?.spotifyUri || this.getTrack()?.uri;
      if (!/^spotify:track:/.test(uri || '') || !this.available) return;
      this.setExpanded(true, true);
      const generation = ++this.searchGeneration;
      this.results.replaceChildren();
      this.feedback.textContent = 'Finding more like this song…';
      try {
        const result = await this.api.getSimilarTracks(uri.split(':')[2]);
        if (generation !== this.searchGeneration) return;
        this.renderResults(result.tracks || []);
        this.feedback.textContent = result.tracks?.length
          ? `More like “${result.seed.name}” · ${result.description}`
          : 'No similar songs found for this track. Try searching above.';
      } catch (error) { if (generation === this.searchGeneration) this.feedback.textContent = error.message; }
    }

    renderResults(tracks) {
      this.results.replaceChildren();
      if (tracks.length) {
        const hide = this.button('HIDE RESULTS', 'Hide search results and view the queue', () => {
          this.results.replaceChildren();
          this.feedback.textContent = '';
          this.panel.querySelector('input').focus();
        });
        this.results.append(hide);
      }
      tracks.slice(0, 20).forEach(track => {
        const row = this.trackRow(track);
        const add = this.button('+', `Add ${track.name} to queue`, async () => {
          add.disabled = true;
          try {
            const result = await this.api.addToQueue(track.uri);
            if (result?.queue) this.accept(result);
            this.feedback.textContent = `Added “${track.name}” to the queue.`;
          } catch (error) { this.feedback.textContent = error.message; }
          finally { add.disabled = !this.available; }
        });
        row.append(add);
        this.results.append(row);
      });
    }
  }
  window.CozyQueuePanel = QueuePanel;
})();
