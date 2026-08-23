// Cozy-Fi Search and Mood Module
class SearchManager {
  constructor(audioEngine, spotifyClient, elements, onTrackSelectCallback, onMoodChangeCallback) {
    this.audio = audioEngine;
    this.spotify = spotifyClient;
    this.searchInput = elements.searchInput;
    this.resultsContainer = elements.resultsContainer;
    this.placeholderContainer = elements.placeholderContainer;
    this.recommendationsGrid = elements.recommendationsGrid;
    this.paginationEl = elements.paginationEl || document.getElementById('search-pagination');
    this.onTrackSelectCallback = onTrackSelectCallback;
    this.onMoodChangeCallback = onMoodChangeCallback;
    this.searchGeneration = 0;
    this.suggestionsGeneration = 0;
    this.searchPageSize = 10;
    this.searchPage = 1;
    this.currentQuery = '';

    this.init();
  }

  init() {
    this.renderSuggestions();

    // Initial load - show recommendations or presentable empty placeholders
    this.triggerSearch('');

    let debounceTimeout;
    this.searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimeout);
      // Invalidate any slower request immediately, before the debounce fires.
      this.searchGeneration += 1;
      const query = e.target.value.trim();
      debounceTimeout = setTimeout(() => {
        this.triggerSearch(query);
      }, 300);
    });
  }

  async refresh() {
    document.querySelector('.search-suggestions-container')?.remove();
    await this.renderSuggestions();
    await this.triggerSearch(this.searchInput.value.trim());
  }

  async renderSuggestions() {
    const renderGeneration = ++this.suggestionsGeneration;
    document.querySelector('.search-suggestions-container')?.remove();
    const suggestionsWrapper = document.createElement('div');
    suggestionsWrapper.className = 'search-suggestions-container';
    suggestionsWrapper.style.margin = '-24px 0 32px 0';
    suggestionsWrapper.style.display = 'flex';
    suggestionsWrapper.style.gap = '10px';
    suggestionsWrapper.style.flexWrap = 'wrap';
    suggestionsWrapper.style.justifyContent = 'center';

    let suggestions = ['Study Beats', 'Sleep Rain', 'Morning Coffee', 'Ghibli Mix', 'Jazz Cafe'];

    if (this.spotify.isAuthenticated) {
      try {
        const topTracks = await this.spotify.getTopTracks();
        if (renderGeneration !== this.suggestionsGeneration) return;
        if (topTracks && topTracks.length > 0) {
          const artists = topTracks.map(track => track?.artists?.[0]?.name).filter(Boolean);
          suggestions = Array.from(new Set(artists)).slice(0, 5);
        }
      } catch (err) {
        console.error('Failed to load personalized suggestions:', err);
      }
    }

    if (renderGeneration !== this.suggestionsGeneration) return;

    suggestions.forEach(text => {
      const chip = document.createElement('button');
      chip.className = 'retro-button';
      chip.style.padding = '4px 10px';
      chip.style.fontSize = '0.8rem';
      chip.textContent = text;
      chip.addEventListener('click', () => {
        this.searchInput.value = text;
        this.triggerSearch(text);
      });
      suggestionsWrapper.appendChild(chip);
    });

    // Insert suggestions container before popular moods label
    const subTitle = document.querySelector('.search-sub-title');
    if (subTitle && subTitle.parentNode) {
      subTitle.parentNode.insertBefore(suggestionsWrapper, subTitle);
    }
  }

  async triggerSearch(query, requestedPage = 1) {
    const searchGeneration = ++this.searchGeneration;
    if (!query) {
      this.currentQuery = '';
      this.searchPage = 1;
      this.hidePagination();
      // Show recommendations grid under the "Recommended" section header
      this.placeholderContainer.style.display = 'none';
      this.resultsContainer.style.display = 'none';
      this.recommendationsGrid.style.display = 'grid';

      if (this.spotify.isAuthenticated) {
        this.renderRecommendationsSkeletons();
        try {
          const topTracks = await this.spotify.getTopTracks();
          if (searchGeneration !== this.searchGeneration) return;
          if (topTracks && topTracks.length > 0) {
            const seedId = topTracks[0].id;
            const recommendations = await this.spotify.getRecommendations(seedId);
            if (searchGeneration !== this.searchGeneration) return;
            this.renderRecommendations(recommendations.length ? recommendations : topTracks);
          } else {
            this.renderRecommendationsPlaceholders();
          }
        } catch (e) {
          if (searchGeneration !== this.searchGeneration) return;
          console.error(e);
          this.renderRecommendationsPlaceholders();
        }
      } else {
        this.renderRecommendationsPlaceholders();
      }
      return;
    }

    // Hide recommended grid during active queries
    this.recommendationsGrid.style.display = 'none';
    this.placeholderContainer.style.display = 'none';
    this.resultsContainer.style.display = 'flex';
    this.currentQuery = query;
    this.searchPage = Math.max(1, Math.floor(Number(requestedPage) || 1));
    this.renderSearchSkeletons();
    this.hidePagination();

    let searchResults = [];
    let searchTotal = 0;
    let searchError = null;

    // Query Spotify Web API if authenticated
    if (this.spotify.isAuthenticated) {
      try {
        const response = await this.spotify.search(query, (this.searchPage - 1) * this.searchPageSize);
        if (searchGeneration !== this.searchGeneration) return;
        if (Array.isArray(response)) {
          searchResults = response;
          searchTotal = response.length;
        } else {
          searchResults = Array.isArray(response?.items) ? response.items : [];
          searchTotal = Math.max(searchResults.length, Number(response?.total) || 0);
        }
      } catch (e) {
        if (searchGeneration !== this.searchGeneration) return;
        console.error('Spotify search error:', e);
        searchError = e;
      }
    }

    if (searchGeneration !== this.searchGeneration) return;

    if (searchError) {
      this.resultsContainer.textContent = 'Spotify search could not load. Check your connection and try again.';
      this.resultsContainer.removeAttribute('aria-busy');
      return;
    }

    if (searchResults.length === 0) {
      const msg = this.spotify.isAuthenticated ? 'No matching tracks found.' : 'No tracks found. Please connect Spotify in Settings to search tracks.';
      this.resultsContainer.innerHTML = `<div style="text-align:center; padding: 20px; font-family: monospace; width:100%;">${msg}</div>`;
      this.resultsContainer.removeAttribute('aria-busy');
      return;
    }

    if (this.searchPage > 1) {
      this.renderTracksList(searchResults, `SEARCH RESULTS FOR "${query.toUpperCase()}"`);
      this.renderSearchPagination(searchTotal, this.searchPage, query);
      return;
    }

    // Fetch related/recommended tracks based on the first matching track to show related songs
    try {
      const seedTrackId = searchResults[0].id;
      const relatedTracks = await this.spotify.getRecommendations(seedTrackId);
      if (searchGeneration !== this.searchGeneration) return;
      this.renderSearchAndRelated(searchResults, relatedTracks, query);
      this.renderSearchPagination(searchTotal, this.searchPage, query);
    } catch (err) {
      if (searchGeneration !== this.searchGeneration) return;
      console.warn('Failed to load related recommendations, showing search matches only:', err);
      this.renderTracksList(searchResults, `SEARCH RESULTS FOR "${query.toUpperCase()}"`);
      this.renderSearchPagination(searchTotal, this.searchPage, query);
    }
  }

  renderRecommendations(tracks) {
    this.recommendationsGrid.innerHTML = '';
    this.recommendationsGrid.removeAttribute('aria-busy');

    (Array.isArray(tracks) ? tracks : []).filter(Boolean).slice(0, 4).forEach(track => {
      const card = document.createElement('div');
      card.className = 'playlist-grid-card';
      const coverUrl = this.safeImageUrl(track.album?.images?.[0]?.url);
      const trackName = this.escapeHtml(track.name || 'Unknown Track');
      const artistName = this.escapeHtml(track.artists?.[0]?.name || 'Unknown Artist');

      const coverMarkup = coverUrl
        ? `<img src="${coverUrl}" alt="" class="playlist-grid-img">`
        : `<div class="playlist-grid-img placeholder-gradient-cover"><span>${trackName.charAt(0)}</span></div>`;

      card.innerHTML = `
        <div style="width:100%; aspect-ratio:1; margin-bottom:8px;">
          ${coverMarkup}
        </div>
        <div class="playlist-grid-title" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size:0.85rem; font-weight:700;">${trackName}</div>
        <div class="playlist-grid-desc" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size:0.75rem; color:var(--text-secondary);">${artistName}</div>
        <button class="play-card-btn" data-play-action>${this.spotify.isExternalPlayback ? 'OPEN' : 'PLAY'}</button>
        ${track.external_urls?.spotify ? '<button class="open-spotify-card-btn">OPEN IN SPOTIFY</button>' : ''}
      `;

      card.querySelector('.open-spotify-card-btn')?.addEventListener('click', event => {
        event.stopPropagation();
        this.spotify.openExternal(track.external_urls.spotify).catch(error => console.error(error));
      });
      const playButton = card.querySelector('.play-card-btn');
      playButton.setAttribute('aria-label', `${this.spotify.isExternalPlayback ? 'Open' : 'Play'} ${track.name || 'track'}`);
      card.querySelector('.open-spotify-card-btn')?.setAttribute('aria-label', `Open ${track.name || 'track'} in Spotify`);

      const playCard = async () => {
        try {
          const result = await this.spotify.playTrack(track.uri);
          this.onTrackSelectCallback(this.toDisplayTrack(track), true, Boolean(result?.external));
        } catch (error) {
          console.error('Could not start Spotify playback:', error);
        }
      };
      playButton.addEventListener('click', playCard);
      card.addEventListener('click', event => {
        if (!event.target.closest('button')) playCard();
      });

      this.recommendationsGrid.appendChild(card);
    });
  }

  renderRecommendationsPlaceholders() {
    this.recommendationsGrid.innerHTML = '';
    this.recommendationsGrid.removeAttribute('aria-busy');
    for (let i = 0; i < 4; i++) {
      const card = document.createElement('div');
      card.className = 'playlist-grid-card';
      card.style.opacity = '0.6';

      card.innerHTML = `
        <div style="width:100%; aspect-ratio:1; margin-bottom:8px; border: 2px dashed var(--border-color); display:flex; align-items:center; justify-content:center; border-radius: 8px; background-color: var(--bg-card);">
          <span style="font-family: monospace; font-size: 0.8rem; color: var(--text-secondary);">COZY</span>
        </div>
        <div class="playlist-grid-title" style="height: 12px; width: 80%; background-color: var(--border-color); border-radius: 2px; margin-bottom: 6px;"></div>
        <div class="playlist-grid-desc" style="height: 8px; width: 50%; background-color: var(--border-color); border-radius: 2px;"></div>
      `;
      this.makeInteractive(card, () => {
        document.querySelector('[data-view="settings"]').click();
      });
      this.recommendationsGrid.appendChild(card);
    }
  }

  renderSearchAndRelated(searchResults, relatedTracks, query) {
    this.resultsContainer.innerHTML = '';
    this.resultsContainer.removeAttribute('aria-busy');

    // 1. Render Search Matches Header
    const searchHeader = document.createElement('div');
    searchHeader.style.width = '100%';
    searchHeader.style.fontFamily = "'Space Mono', monospace";
    searchHeader.style.fontWeight = '700';
    searchHeader.style.fontSize = '0.9rem';
    searchHeader.style.marginBottom = '16px';
    searchHeader.style.borderBottom = '2px solid var(--border-color)';
    searchHeader.style.paddingBottom = '6px';
    searchHeader.textContent = `SEARCH RESULTS FOR "${query.toUpperCase()}"`;
    this.resultsContainer.appendChild(searchHeader);

    this.appendTrackRows(searchResults);

    // 2. Render Related Songs Header
    const relatedHeader = document.createElement('div');
    relatedHeader.style.width = '100%';
    relatedHeader.style.fontFamily = "'Space Mono', monospace";
    relatedHeader.style.fontWeight = '700';
    relatedHeader.style.fontSize = '0.9rem';
    relatedHeader.style.marginTop = '24px';
    relatedHeader.style.marginBottom = '16px';
    relatedHeader.style.borderBottom = '2px solid var(--border-color)';
    relatedHeader.style.paddingBottom = '6px';
    relatedHeader.textContent = 'MORE FROM YOUR RECENT LISTENING';
    this.resultsContainer.appendChild(relatedHeader);

    this.appendTrackRows((Array.isArray(relatedTracks) ? relatedTracks : []).slice(0, 5));
  }

  renderTracksList(tracks, headerTitle) {
    this.resultsContainer.innerHTML = '';
    this.resultsContainer.removeAttribute('aria-busy');

    const header = document.createElement('div');
    header.style.width = '100%';
    header.style.fontFamily = "'Space Mono', monospace";
    header.style.fontWeight = '700';
    header.style.fontSize = '0.9rem';
    header.style.marginBottom = '16px';
    header.style.borderBottom = '2px solid var(--border-color)';
    header.style.paddingBottom = '6px';
    header.textContent = headerTitle;
    this.resultsContainer.appendChild(header);

    this.appendTrackRows(tracks);
  }

  appendTrackRows(tracks) {
    (Array.isArray(tracks) ? tracks : []).filter(Boolean).forEach(track => {
      const coverUrl = this.safeImageUrl(track.album?.images?.[0]?.url);
      const trackName = this.escapeHtml(track.name || 'Unknown Track');
      const artistNames = this.escapeHtml(Array.isArray(track.artists) ? track.artists.map(a => a.name).join(', ') : 'Unknown Artist');

      const row = document.createElement('div');
      row.className = 'liked-track-row retro-border';
      row.style.marginBottom = '8px';
      row.style.width = '100%';
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'center';

      const coverMarkup = coverUrl
        ? `<img src="${coverUrl}" alt="" style="width:40px; height:40px; border-radius: 4px; object-fit:cover;">`
        : `<div class="placeholder-gradient-cover" style="width:40px; height:40px; border-radius: 4px; font-size: 1rem; position: absolute; top: 0; left: 0;"><span>${trackName.charAt(0)}</span></div>`;

      row.innerHTML = `
        <div style="display:flex; align-items:center; gap: 12px; min-width: 0; flex: 1;">
          <div style="width: 40px; height: 40px; flex-shrink: 0; position: relative;">
            ${coverMarkup}
          </div>
          <div style="min-width: 0; flex: 1;">
            <div class="liked-track-name" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${trackName}</div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${artistNames}</div>
          </div>
        </div>
        <div class="track-row-actions">
          <button class="play-row-btn" data-play-action>${this.spotify.isExternalPlayback ? 'OPEN' : 'PLAY'}</button>
          ${track.external_urls?.spotify ? '<button class="open-spotify-row-btn">SPOTIFY</button>' : ''}
          <div class="liked-track-duration">${track.duration_ms ? this.formatMs(track.duration_ms) : '0:00'}</div>
        </div>
      `;

      row.querySelector('.open-spotify-row-btn')?.addEventListener('click', event => {
        event.stopPropagation();
        this.spotify.openExternal(track.external_urls.spotify).catch(error => console.error(error));
      });
      const playButton = row.querySelector('.play-row-btn');
      playButton.setAttribute('aria-label', `${this.spotify.isExternalPlayback ? 'Open' : 'Play'} ${track.name || 'track'}`);
      row.querySelector('.open-spotify-row-btn')?.setAttribute('aria-label', `Open ${track.name || 'track'} in Spotify`);

      const playRow = async () => {
        try {
          const result = await this.spotify.playTrack(track.uri);
          this.onTrackSelectCallback(this.toDisplayTrack(track), true, Boolean(result?.external));
        } catch (error) {
          console.error('Could not start Spotify playback:', error);
        }
      };
      playButton.addEventListener('click', playRow);
      row.addEventListener('click', event => {
        if (!event.target.closest('button')) playRow();
      });

      this.resultsContainer.appendChild(row);
    });
  }

  renderRecommendationsSkeletons(count = 4) {
    this.recommendationsGrid.innerHTML = '';
    this.recommendationsGrid.setAttribute('aria-busy', 'true');
    for (let index = 0; index < count; index += 1) {
      const card = document.createElement('div');
      card.className = 'playlist-grid-card';
      card.setAttribute('aria-hidden', 'true');
      card.innerHTML = `
        <div class="skeleton skeleton-card-art"></div>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line short"></div>
      `;
      this.recommendationsGrid.appendChild(card);
    }
  }

  renderSearchSkeletons(count = 6) {
    this.resultsContainer.innerHTML = '';
    this.resultsContainer.setAttribute('aria-busy', 'true');
    for (let index = 0; index < count; index += 1) {
      const row = document.createElement('div');
      row.className = 'skeleton skeleton-track-row';
      row.setAttribute('aria-hidden', 'true');
      this.resultsContainer.appendChild(row);
    }
  }

  renderSearchPagination(totalItems, page, query) {
    if (!this.paginationEl) return;
    const totalPages = Math.max(1, Math.ceil(totalItems / this.searchPageSize));
    if (totalPages <= 1) {
      this.hidePagination();
      return;
    }
    this.paginationEl.hidden = false;
    this.paginationEl.innerHTML = '';
    const previous = document.createElement('button');
    previous.className = 'pagination-button';
    previous.type = 'button';
    previous.textContent = 'PREV';
    previous.disabled = page <= 1;
    previous.setAttribute('aria-label', 'Previous search results page');

    const status = document.createElement('span');
    status.className = 'pagination-status';
    status.textContent = `PAGE ${page} / ${totalPages}`;
    status.setAttribute('aria-live', 'polite');

    const next = document.createElement('button');
    next.className = 'pagination-button';
    next.type = 'button';
    next.textContent = 'NEXT';
    next.disabled = page >= totalPages;
    next.setAttribute('aria-label', 'Next search results page');

    const changePage = nextPage => {
      this.triggerSearch(query, nextPage);
      this.searchInput.scrollIntoView({ block: 'start' });
    };
    previous.addEventListener('click', () => changePage(page - 1));
    next.addEventListener('click', () => changePage(page + 1));
    this.paginationEl.append(previous, status, next);
  }

  hidePagination() {
    if (!this.paginationEl) return;
    this.paginationEl.hidden = true;
    this.paginationEl.innerHTML = '';
  }

  formatMs(ms) {
    const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000));
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  toDisplayTrack(track) {
    return {
      id: track.id,
      title: track.name || 'Unknown Track',
      artist: Array.isArray(track.artists) ? track.artists.map(a => a.name).join(', ') : 'Unknown Artist',
      album: track.album?.name || 'Single',
      cover: this.safeImageUrl(track.album?.images?.[0]?.url),
      duration: this.formatMs(track.duration_ms || 0),
      durationMs: track.duration_ms || 0,
      isSpotify: true,
      spotifyUri: track.uri,
      spotifyUrl: track.external_urls?.spotify || null,
      spotifyType: track.type || 'track'
    };
  }

  makeInteractive(element, handler) {
    element.tabIndex = 0;
    element.setAttribute('role', 'button');
    element.addEventListener('click', handler);
    element.addEventListener('keydown', event => {
      if (event.target !== element) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handler();
      }
    });
  }

  escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
  }

  safeImageUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? this.escapeHtml(url.toString()) : null;
    } catch {
      return null;
    }
  }

  capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SearchManager;
} else {
  window.SearchManager = SearchManager;
}
