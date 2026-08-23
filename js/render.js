// Cozy-Fi Render Engine Module
class RenderEngine {
  constructor(audioEngine, spotifyClient, elements, onTrackSelectCallback) {
    this.audio = audioEngine;
    this.spotify = spotifyClient;
    this.recentListEl = elements.recentListEl;
    this.likedListEl = elements.likedListEl;
    this.playlistsGridEl = elements.playlistsGridEl;
    this.trackPaginationEl = elements.trackPaginationEl || document.getElementById('liked-tracks-pagination');
    this.libraryPaginationEl = elements.libraryPaginationEl || document.getElementById('library-grid-pagination');
    this.onTrackSelectCallback = onTrackSelectCallback;
    this.activeType = 'playlists';
    this.currentRenderedQueue = [];
    this.currentContextUri = null;
    this.currentTrackContext = null;
    this.recentRenderGeneration = 0;
    this.trackRenderGeneration = 0;
    this.libraryRenderGeneration = 0;
    this.trackPage = 1;
    this.trackPageSize = 8;
    this.libraryPage = 1;
    this.libraryPageSize = 12;
    this.libraryItems = [];

    // In-memory cache for Library tabs to prevent API rate limiting (429)
    this.libraryCache = {
      playlists: null,
      albums: null,
      artists: null,
      liked: null
    };
  }

  clearCache() {
    this.recentRenderGeneration += 1;
    this.trackRenderGeneration += 1;
    this.libraryRenderGeneration += 1;
    this.libraryCache = {
      playlists: null,
      albums: null,
      artists: null,
      liked: null
    };
  }

  async renderAll() {
    await this.renderRecentSessions();
    if (this.activeType === 'playlists' || this.activeType === 'all') {
      await Promise.all([
        this.renderLibraryTracks('liked', 'Liked Songs', 'liked'),
        this.renderLibraryPlaylists('playlists')
      ]);
    } else {
      await this.renderLibraryPlaylists(this.activeType);
    }
  }

  // Helper to create a placeholder gradient block or load Spotify image with clean isolated styling class
  createCoverMarkup(coverUrl, titleText, contextClass) {
    const safeCover = this.safeImageUrl(coverUrl);
    const safeTitle = this.escapeHtml(titleText);
    const safeClass = this.escapeHtml(contextClass);
    if (safeCover) {
      return `<img src="${safeCover}" alt="" class="${safeClass}">`;
    }
    // Generate a simple, styled retro cover block using CSS gradient
    const firstChar = titleText ? titleText.charAt(0).toUpperCase() : 'M';
    return `
      <div class="${safeClass} placeholder-gradient-cover">
        <span>${this.escapeHtml(firstChar)}</span>
      </div>
    `;
  }

  async renderRecentSessions() {
    if (!this.recentListEl) return;
    const renderGeneration = ++this.recentRenderGeneration;
    this.recentListEl.innerHTML = '';

    let sessions = [];
    if (this.spotify.isAuthenticated) {
      try {
        const playlists = await this.spotify.getPlaylists();
        if (renderGeneration !== this.recentRenderGeneration) return;
        if (playlists && Array.isArray(playlists)) {
          // Use first 3 playlists as recent sessions
          sessions = playlists.slice(0, 3).map((pl, idx) => ({
            id: pl.id,
            title: pl.name,
            type: 'Playlist',
            cover: pl.images && pl.images.length > 0 ? pl.images[0].url : null,
            spotifyUri: pl.uri,
            isSpotify: true
          }));
        }
      } catch (e) {
        console.error('Failed to load Spotify recents:', e);
      }
    }

    if (renderGeneration !== this.recentRenderGeneration) return;

    // Fallback to local sessions if Spotify returned empty or not authenticated
    if (sessions.length === 0) {
      sessions = [];
    }

    sessions.forEach(session => {
      const card = document.createElement('div');
      card.className = 'session-item';
      card.innerHTML = `
        <div class="session-img-container">
          ${this.createCoverMarkup(session.cover, session.title, 'session-img')}
        </div>
        <div class="session-title">${this.escapeHtml(session.title)}</div>
        <div class="session-type">${this.escapeHtml(session.type)}</div>
      `;
      const playSession = async () => {
        if (session.isSpotify) {
          try {
            // Context playback still works when Development Mode does not expose
            // the item rows for a followed playlist.
            const playbackResult = await this.spotify.playContext(session.spotifyUri);
            if (playbackResult?.external) return;
            this.onTrackSelectCallback(null, true);
            const tracks = await this.spotify.getPlaylistTracks(session.id).catch(() => []);
            if (tracks && Array.isArray(tracks)) {
              const playlistTracks = tracks.map(t => ({
                id: t.id,
                title: t.name || 'Unknown Track',
                artist: t.artists ? t.artists.map(a => a.name).join(', ') : 'Unknown Artist',
                album: t.album ? t.album.name : 'Single',
                cover: t.album && t.album.images && t.album.images.length > 0 ? t.album.images[0].url : null,
                duration: this.formatMs(t.duration_ms || 0),
                durationMs: t.duration_ms || 0,
                isSpotify: true,
                spotifyUri: t.uri,
                spotifyType: t.type || 'track'
              }));

              if (playlistTracks.length > 0) {
                this.onTrackSelectCallback(playlistTracks[0], true);
              }
            }
          } catch (err) {
            console.error(err);
          }
        }
      };
      this.makeInteractive(card, playSession);
      this.recentListEl.appendChild(card);
    });
  }

  async renderLibraryTracks(itemId = 'liked', itemName = 'Liked Songs', itemType = 'liked', itemCoverUrl = null) {
    if (!this.likedListEl) return;
    const renderGeneration = ++this.trackRenderGeneration;
    const contextChanged = !this.currentTrackContext ||
      this.currentTrackContext.id !== itemId || this.currentTrackContext.type !== itemType;
    if (contextChanged) this.trackPage = 1;
    this.currentTrackContext = { id: itemId, name: itemName, type: itemType };
    this.renderTrackSkeletons();
    this.hidePagination(this.trackPaginationEl);
    this.currentRenderedQueue = [];
    const titleEl = document.querySelector('.liked-title');
    const metaEl = document.querySelector('.liked-meta');

    // Update header labels dynamically to represent selected Playlist/Album/Artist
    titleEl.textContent = itemName;
    metaEl.textContent = 'Loading...';

    let tracks = [];
    if (this.spotify.isAuthenticated) {
      try {
        const cacheKey = `${itemType}_${itemId}`;
        if (this.libraryCache[cacheKey]) {
          tracks = this.libraryCache[cacheKey];
        } else {
          if (itemType === 'liked') {
            if (this.libraryCache.liked) {
              tracks = this.libraryCache.liked;
            } else {
              tracks = await this.spotify.getLikedTracks();
              if (renderGeneration !== this.trackRenderGeneration) return;
              this.libraryCache.liked = tracks;
            }
          } else if (itemType === 'playlist') {
            tracks = await this.spotify.getPlaylistTracks(itemId);
            if (renderGeneration !== this.trackRenderGeneration) return;
            this.libraryCache[cacheKey] = tracks;
          } else if (itemType === 'album') {
            const rawTracks = await this.spotify.getAlbumTracks(itemId);
            if (renderGeneration !== this.trackRenderGeneration) return;
            if (rawTracks && Array.isArray(rawTracks)) {
              tracks = rawTracks.map(t => ({
                ...t,
                album: { name: itemName, images: itemCoverUrl ? [{ url: itemCoverUrl }] : [] }
              }));
              this.libraryCache[cacheKey] = tracks;
            }
          } else if (itemType === 'artist') {
            tracks = await this.spotify.getArtistTopTracks(itemId);
            if (renderGeneration !== this.trackRenderGeneration) return;
            this.libraryCache[cacheKey] = tracks;
          }
        }
      } catch (e) {
        if (renderGeneration !== this.trackRenderGeneration) return;
        console.error('Failed to load library tracks:', e);
        const restricted = String(e?.message || '').includes('403');
        this.likedListEl.removeAttribute('aria-busy');
        metaEl.textContent = restricted ? 'Unavailable through Spotify Development Mode' : 'Could not load songs';
        this.likedListEl.textContent = restricted
          ? 'Spotify only exposes item lists for playlists you own or collaborate on.'
          : 'Could not load this track list. Please try again.';
        return;
      }
    }

    if (renderGeneration !== this.trackRenderGeneration) return;

    if (tracks && Array.isArray(tracks) && tracks.length > 0) {
      metaEl.textContent = tracks.length >= 500
        ? `${tracks.length} songs shown (display limit)`
        : `${tracks.length} songs`;
      const playQueue = tracks.map(t => {
        if (!t) return null;
        const artistName = t.artists && Array.isArray(t.artists) ? t.artists.map(a => a.name).join(', ') : 'Unknown';
        const albumName = t.album ? t.album.name : 'Single';
        const coverUrl = t.album && t.album.images && t.album.images.length > 0 ? t.album.images[0].url : null;
        return {
          id: t.id,
          title: t.name || 'Unknown Track',
          artist: artistName,
          album: albumName,
          cover: coverUrl,
          duration: this.formatMs(t.duration_ms || 0),
          durationMs: t.duration_ms || 0,
          isSpotify: true,
          spotifyUri: t.uri,
          spotifyUrl: t.external_urls?.spotify || null,
          spotifyType: t.type || 'track'
        };
      }).filter(t => t);

      this.currentRenderedQueue = playQueue;

      this.renderTrackPage(tracks, playQueue);
    } else {
      metaEl.textContent = '0 songs';
      this.hidePagination(this.trackPaginationEl);
      this.likedListEl.removeAttribute('aria-busy');
      this.likedListEl.innerHTML = '<div style="font-size:0.8rem; color:var(--text-secondary); text-align:center; padding: 20px;">No tracks found for this context.</div>';
    }
  }

  renderTrackPage(tracks, playQueue) {
    const validTracks = (Array.isArray(tracks) ? tracks : []).filter(Boolean);
    const totalPages = Math.max(1, Math.ceil(validTracks.length / this.trackPageSize));
    this.trackPage = Math.min(Math.max(1, this.trackPage), totalPages);
    const startIndex = (this.trackPage - 1) * this.trackPageSize;
    const pageTracks = validTracks.slice(startIndex, startIndex + this.trackPageSize);
    this.likedListEl.innerHTML = '';
    this.likedListEl.removeAttribute('aria-busy');

    pageTracks.forEach((track, pageIndex) => {
      const idx = startIndex + pageIndex;
      const trackData = playQueue[idx];
      if (!trackData) return;
      const row = document.createElement('div');
      row.className = 'liked-track-row';
      const durationStr = track.duration_ms ? this.formatMs(track.duration_ms) : '0:00';
      const playLabel = this.spotify.isExternalPlayback ? 'OPEN' : 'PLAY';
      const queueMarkup = this.spotify.isExternalPlayback
        ? ''
        : '<button class="add-queue-row-btn">+ QUEUE</button>';
      row.innerHTML = `
        <div class="liked-track-name">${this.escapeHtml(track.name || 'Unknown Track')}</div>
        <div class="track-row-actions">
          <button class="play-row-btn" data-play-action>${playLabel}</button>
          ${queueMarkup}
          ${trackData.spotifyUrl ? '<button class="open-spotify-row-btn">SPOTIFY</button>' : ''}
          <div class="liked-track-duration">${durationStr}</div>
        </div>
      `;

      const queueBtn = row.querySelector('.add-queue-row-btn');
      const playBtn = row.querySelector('.play-row-btn');
      playBtn.setAttribute('aria-label', `${this.spotify.isExternalPlayback ? 'Open' : 'Play'} ${trackData.title || 'track'}`);
      queueBtn?.setAttribute('aria-label', `Add ${trackData.title || 'track'} to queue`);
      queueBtn?.addEventListener('click', async event => {
        event.stopPropagation();
        try {
          await this.spotify.addToQueue(trackData.spotifyUri);
          window.showCozyStatus?.(`Added “${trackData.title}” to your Spotify queue.`);
        } catch (error) {
          console.error(error);
        }
      });

      const openBtn = row.querySelector('.open-spotify-row-btn');
      openBtn?.setAttribute('aria-label', `Open ${trackData.title || 'track'} in Spotify`);
      openBtn?.addEventListener('click', event => {
        event.stopPropagation();
        this.spotify.openExternal(trackData.spotifyUrl).catch(error => console.error(error));
      });

      const playRow = async () => {
        const activeQueue = playQueue.slice(idx).map(item => item.spotifyUri).filter(Boolean);
        try {
          const result = /^spotify:(playlist|album):/.test(this.currentContextUri || '')
            ? await this.spotify.playContext(this.currentContextUri, trackData.spotifyUri)
            : await this.spotify.playTracks(activeQueue.slice(0, 100));
          this.onTrackSelectCallback(trackData, true, Boolean(result?.external));
        } catch (error) {
          console.error('Could not start Spotify playback:', error);
        }
      };
      playBtn.addEventListener('click', playRow);
      row.addEventListener('click', event => {
        if (!event.target.closest('button')) playRow();
      });
      this.likedListEl.appendChild(row);
    });

    this.renderPagination(
      this.trackPaginationEl,
      this.trackPage,
      validTracks.length,
      this.trackPageSize,
      nextPage => {
        this.trackPage = nextPage;
        this.renderTrackPage(validTracks, playQueue);
        this.likedListEl.scrollTop = 0;
      },
      'tracks'
    );
  }

  renderTrackSkeletons(count = 6) {
    this.likedListEl.innerHTML = '';
    this.likedListEl.setAttribute('aria-busy', 'true');
    for (let index = 0; index < count; index += 1) {
      const skeleton = document.createElement('div');
      skeleton.className = 'skeleton skeleton-track-row';
      skeleton.setAttribute('aria-hidden', 'true');
      this.likedListEl.appendChild(skeleton);
    }
  }

  async renderLibraryPlaylists(type = 'playlists') {
    const renderGeneration = ++this.libraryRenderGeneration;
    if (this.activeType !== type) this.libraryPage = 1;
    this.activeType = type;
    this.currentContextUri = null;
    const newCard = document.getElementById('create-playlist-btn');
    const contentGrid = document.querySelector('.library-content-grid');
    const likedCard = document.querySelector('.liked-songs-card');

    // Remove Liked Songs panel for albums/artists, show only for playlists (all) by default
    if (type === 'playlists' || type === 'all') {
      likedCard.style.display = 'flex';
      contentGrid.classList.remove('hide-liked');
    } else {
      likedCard.style.display = 'none';
      contentGrid.classList.add('hide-liked');
    }

    // Clear grid
    Array.from(this.playlistsGridEl.children).forEach(child => {
      if (child !== newCard) {
        child.remove();
      }
    });
    newCard.style.display = 'none';
    this.renderLibrarySkeletons(newCard);
    this.hidePagination(this.libraryPaginationEl);

    let items = [];
    let loadError = null;
    if (this.spotify.isAuthenticated) {
      try {
        if (type === 'albums') {
          if (this.libraryCache.albums) {
            items = this.libraryCache.albums;
          } else {
            const albums = await this.spotify.getAlbums();
            if (renderGeneration !== this.libraryRenderGeneration) return;
            if (albums && Array.isArray(albums)) {
              items = albums.map(al => ({
                id: al.id,
                title: al.name || 'Unknown Album',
                desc: al.artists ? al.artists.map(a => a.name).join(', ') : 'Unknown Artist',
                cover: al.images && al.images.length > 0 ? al.images[0].url : null,
                spotifyUri: al.uri,
                spotifyUrl: al.external_urls?.spotify || null,
                isSpotify: true
              }));
              this.libraryCache.albums = items;
            }
          }
        } else if (type === 'artists') {
          if (this.libraryCache.artists) {
            items = this.libraryCache.artists;
          } else {
            const artists = await this.spotify.getArtists();
            if (renderGeneration !== this.libraryRenderGeneration) return;
            if (artists && Array.isArray(artists)) {
              items = artists.map(art => ({
                id: art.id,
                title: art.name || 'Unknown Artist',
                desc: 'Artist',
                cover: art.images && art.images.length > 0 ? art.images[0].url : null,
                spotifyUri: art.uri,
                spotifyUrl: art.external_urls?.spotify || null,
                isSpotify: true
              }));
              this.libraryCache.artists = items;
            }
          }
        } else {
          // Playlists
          const cacheKey = type === 'all' ? 'playlists' : type;
          if (this.libraryCache[cacheKey]) {
            items = this.libraryCache[cacheKey];
          } else {
            const playlists = await this.spotify.getPlaylists();
            if (renderGeneration !== this.libraryRenderGeneration) return;
            if (playlists && Array.isArray(playlists)) {
              items = playlists.map(pl => ({
                id: pl.id,
                title: pl.name || 'Untitled Playlist',
                desc: `${pl.items?.total ?? pl.tracks?.total ?? 0} Songs`,
                cover: pl.images && pl.images.length > 0 ? pl.images[0].url : null,
                spotifyUri: pl.uri,
                spotifyUrl: pl.external_urls?.spotify || null,
                isSpotify: true
              }));
              this.libraryCache[cacheKey] = items;
            }
          }
        }
      } catch (e) {
        if (renderGeneration !== this.libraryRenderGeneration) return;
        console.error(`Failed to load Spotify ${type}:`, e);
        loadError = e;
      }
    }

    if (renderGeneration !== this.libraryRenderGeneration) return;

    // Fallback contents (only show connection prompt if not authenticated and no items)
    if (items.length === 0 && !this.spotify.isAuthenticated) {
      items = [
        { title: 'Connect Spotify', desc: 'Link in Settings', isPlaceholder: true }
      ];
    } else if (items.length === 0 && this.spotify.isAuthenticated) {
      const label = type === 'artists' ? 'followed artists' : `saved ${type}`;
      items = [{
        title: loadError ? `Could not load ${type}` : `No ${label} yet`,
        desc: loadError ? 'Check your connection and try this tab again.' : `Your ${label} will appear here.`,
        isMessage: true
      }];
    }

    if (this.spotify.isAuthenticated && (type === 'playlists' || type === 'all')) {
      if (items && Array.isArray(items) && !items.some(item => item.id === 'liked')) {
        items.unshift({
          id: 'liked',
          title: 'Liked Songs',
          desc: 'Your Liked Tracks',
          cover: null,
          spotifyUri: 'liked',
          spotifyUrl: 'https://open.spotify.com/collection/tracks',
          itemType: 'liked',
          isSpotify: true
        });
      }
    }

    this.libraryItems = items;
    this.renderLibraryGridPage(items, type, newCard, likedCard, contentGrid);
  }

  renderLibraryGridPage(items, type, newCard, likedCard, contentGrid) {
    Array.from(this.playlistsGridEl.children).forEach(child => {
      if (child !== newCard) child.remove();
    });
    this.playlistsGridEl.removeAttribute('aria-busy');
    const totalPages = Math.max(1, Math.ceil(items.length / this.libraryPageSize));
    this.libraryPage = Math.min(Math.max(1, this.libraryPage), totalPages);
    const startIndex = (this.libraryPage - 1) * this.libraryPageSize;
    const pageItems = items.slice(startIndex, startIndex + this.libraryPageSize);
    newCard.style.display = (type === 'playlists' || type === 'all') && this.libraryPage === 1 ? 'flex' : 'none';

    pageItems.forEach(pl => {
      const card = document.createElement('div');
      card.className = 'playlist-grid-card';

      if (pl.isPlaceholder) {
        card.innerHTML = `
          <div style="width:100%; aspect-ratio:1; margin-bottom:8px;" class="new-playlist-card">
            <span>LINK</span>
          </div>
          <div class="playlist-grid-title">${this.escapeHtml(pl.title)}</div>
          <div class="playlist-grid-desc">${this.escapeHtml(pl.desc)}</div>
        `;
        this.makeInteractive(card, () => {
          document.querySelector('[data-view="settings"]').click();
        });
      } else if (pl.isMessage) {
        card.innerHTML = `
          <div class="new-playlist-card" style="width:100%;aspect-ratio:1;margin-bottom:8px;"><span>INFO</span></div>
          <div class="playlist-grid-title">${this.escapeHtml(pl.title)}</div>
          <div class="playlist-grid-desc">${this.escapeHtml(pl.desc)}</div>
        `;
      } else {
        card.innerHTML = `
          <div style="width:100%; aspect-ratio:1; margin-bottom:8px;">
            ${this.createCoverMarkup(pl.cover, pl.title, 'playlist-grid-img')}
          </div>
          <div class="playlist-grid-title">${this.escapeHtml(pl.title)}</div>
          <div class="playlist-grid-desc">${this.escapeHtml(pl.desc)}</div>
          <button class="play-card-btn">VIEW</button>
          ${pl.spotifyUrl ? '<button class="open-spotify-card-btn">OPEN IN SPOTIFY</button>' : ''}
        `;
        const openButton = card.querySelector('.open-spotify-card-btn');
        const viewButton = card.querySelector('.play-card-btn');
        viewButton.setAttribute('aria-label', `View ${pl.title}`);
        openButton?.setAttribute('aria-label', `Open ${pl.title} in Spotify`);
        openButton?.addEventListener('click', event => {
          event.stopPropagation();
          this.spotify.openExternal(pl.spotifyUrl).catch(error => console.error(error));
        });
        const viewCard = async () => {
          if (pl.isSpotify) {
            this.currentContextUri = pl.spotifyUri;
            // Expand/reveal left song list panel and alter columns
            likedCard.style.display = 'flex';
            contentGrid.classList.remove('hide-liked');

            if (pl.id === 'liked' || pl.itemType === 'liked') {
              await this.renderLibraryTracks('liked', 'Liked Songs', 'liked');
            } else if (type === 'playlists' || type === 'all') {
              await this.renderLibraryTracks(pl.id, pl.title, 'playlist');
            } else if (type === 'albums') {
              await this.renderLibraryTracks(pl.id, pl.title, 'album', pl.cover);
            } else if (type === 'artists') {
              await this.renderLibraryTracks(pl.id, pl.title, 'artist');
            }
          }
        };
        viewButton.addEventListener('click', viewCard);
        card.addEventListener('click', event => {
          if (!event.target.closest('button')) viewCard();
        });
      }
      this.playlistsGridEl.insertBefore(card, newCard);
    });

    this.renderPagination(
      this.libraryPaginationEl,
      this.libraryPage,
      items.length,
      this.libraryPageSize,
      nextPage => {
        this.libraryPage = nextPage;
        this.renderLibraryGridPage(items, type, newCard, likedCard, contentGrid);
      },
      type === 'artists' ? 'artists' : type === 'albums' ? 'albums' : 'playlists'
    );
  }

  renderLibrarySkeletons(newCard, count = 8) {
    this.playlistsGridEl.setAttribute('aria-busy', 'true');
    for (let index = 0; index < count; index += 1) {
      const card = document.createElement('div');
      card.className = 'playlist-grid-card library-skeleton';
      card.setAttribute('aria-hidden', 'true');
      card.innerHTML = `
        <div class="skeleton skeleton-card-art"></div>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line short"></div>
      `;
      this.playlistsGridEl.insertBefore(card, newCard);
    }
  }

  renderPagination(container, page, totalItems, pageSize, onPageChange, itemLabel = 'items') {
    if (!container) return;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    if (totalPages <= 1) {
      this.hidePagination(container);
      return;
    }
    container.hidden = false;
    container.innerHTML = '';
    const previous = document.createElement('button');
    previous.className = 'pagination-button';
    previous.type = 'button';
    previous.textContent = 'PREV';
    previous.disabled = page <= 1;
    previous.setAttribute('aria-label', `Previous page of ${itemLabel}`);

    const status = document.createElement('span');
    status.className = 'pagination-status';
    status.textContent = `PAGE ${page} / ${totalPages}`;
    status.setAttribute('aria-live', 'polite');

    const next = document.createElement('button');
    next.className = 'pagination-button';
    next.type = 'button';
    next.textContent = 'NEXT';
    next.disabled = page >= totalPages;
    next.setAttribute('aria-label', `Next page of ${itemLabel}`);

    previous.addEventListener('click', () => onPageChange(page - 1));
    next.addEventListener('click', () => onPageChange(page + 1));
    container.append(previous, status, next);
  }

  hidePagination(container) {
    if (!container) return;
    container.hidden = true;
    container.innerHTML = '';
  }

  formatMs(ms) {
    const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000));
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  async renderLikedSongs() {
    this.libraryCache.liked = null;
    return this.renderLibraryTracks('liked', 'Liked Songs', 'liked');
  }

  invalidateLikedCache() {
    this.libraryCache.liked = null;
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
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RenderEngine;
} else {
  window.RenderEngine = RenderEngine;
}
