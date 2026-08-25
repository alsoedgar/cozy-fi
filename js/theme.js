// Cozy-Fi Theme and Font scale module
const CoverThemeModule = typeof module !== 'undefined' && module.exports
  ? require('./cover-theme')
  : window.CozyCoverTheme;

class ThemeManager {
  constructor(themeBoxes, saveThemeBtn, typoRows) {
    this.themeBoxes = Array.from(themeBoxes || []);
    this.saveThemeBtn = saveThemeBtn;
    this.typoRows = Array.from(typoRows || []);
    this.storageKey = 'cozy_custom_palettes_v1';
    this.coverStorageKey = 'cozy_cover_theme_v1';
    this.maxCustomPalettes = 8;
    this.defaultCustomPalette = {
      bgPrimary: '#f7f0e3',
      bgSecondary: '#fdfaf3',
      bgCard: '#ebd9c5',
      textPrimary: '#3c2f2f',
      textSecondary: '#705e54',
      accentColor: '#c08a6e',
      borderColor: '#3c2f2f'
    };
    this.colorInputs = Array.from(document.querySelectorAll('[data-color-key]'));
    this.customEditor = document.getElementById('custom-theme-editor');
    this.customNameInput = document.getElementById('custom-theme-name');
    this.savedThemeSelect = document.getElementById('saved-theme-select');
    this.newCustomThemeBtn = document.getElementById('new-custom-theme-btn');
    this.deleteCustomThemeBtn = document.getElementById('delete-custom-theme-btn');
    this.feedbackEl = document.getElementById('theme-feedback');
    this.coverEditor = document.getElementById('cover-theme-editor');
    this.coverStyleSelect = document.getElementById('cover-theme-style');
    this.coverMoodSelect = document.getElementById('cover-theme-mood');
    this.coverIntensityInput = document.getElementById('cover-theme-intensity');
    this.coverIntensityOutput = document.getElementById('cover-theme-intensity-output');
    this.coverFeedbackEl = document.getElementById('cover-theme-feedback');
    this.customPalettes = this.loadCustomPalettes();
    this.activeTheme = localStorage.getItem('cozy_theme') || 'morning-lo-fi';
    this.activeCustomId = this.activeTheme.startsWith('custom:') ? this.activeTheme.slice(7) : null;
    this.activeTheme = this.activeCustomId ? 'custom' : this.activeTheme;
    this.activeFontSize = localStorage.getItem('cozy_font_size') || 'standard';
    this.draftPalette = { ...this.defaultCustomPalette };
    this.coverOptions = this.loadCoverOptions();
    this.coverSourceColors = { ...CoverThemeModule.DEFAULT_SOURCE_COLORS };
    this.coverPalette = CoverThemeModule.buildCoverThemePalette(this.coverSourceColors, this.coverOptions);
    this.currentArtworkUrl = '';
    this.currentArtworkKey = '';
    this.coverRequestGeneration = 0;
    this.coverColorCache = new Map();

    if (!['morning-lo-fi', 'soft-sunset', 'custom', 'cover-match'].includes(this.activeTheme)) {
      this.activeTheme = 'morning-lo-fi';
    }

    const savedActive = this.customPalettes.find(palette => palette.id === this.activeCustomId);
    if (savedActive) {
      this.draftPalette = { ...savedActive.colors };
      this.initialCustomName = savedActive.name;
    }
    else if (this.activeTheme === 'custom') {
      this.activeTheme = 'morning-lo-fi';
      this.activeCustomId = null;
    }

    this.init();
  }

  init() {
    this.renderSavedPaletteOptions();
    this.writePaletteToEditor(this.draftPalette);
    if (this.initialCustomName && this.customNameInput) this.customNameInput.value = this.initialCustomName;

    this.themeBoxes.forEach((box, index) => {
      box.setAttribute('role', 'radio');
      const selectTheme = () => this.selectTheme(box.getAttribute('data-theme'));
      box.addEventListener('click', selectTheme);
      box.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectTheme();
        } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          const delta = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
          const next = this.themeBoxes[(index + delta + this.themeBoxes.length) % this.themeBoxes.length];
          next.focus();
          next.click();
        }
      });
    });

    this.colorInputs.forEach(input => {
      input.addEventListener('input', () => {
        this.activeTheme = 'custom';
        this.draftPalette[input.dataset.colorKey] = this.normalizeHex(input.value, this.defaultCustomPalette[input.dataset.colorKey]);
        input.parentElement?.querySelector('output')?.replaceChildren(input.value.toUpperCase());
        this.updateCustomSwatches();
        this.applyCustomPalette(this.draftPalette);
        this.updateThemeBoxesUI();
        this.updateContrastFeedback();
      });
    });

    this.savedThemeSelect?.addEventListener('change', () => {
      const palette = this.customPalettes.find(item => item.id === this.savedThemeSelect.value);
      if (!palette) {
        this.startNewCustomPalette();
        return;
      }
      this.activeCustomId = palette.id;
      this.activeTheme = 'custom';
      this.draftPalette = { ...palette.colors };
      this.customNameInput.value = palette.name;
      this.writePaletteToEditor(this.draftPalette);
      this.applyCustomPalette(this.draftPalette);
      this.updateThemeBoxesUI();
      this.deleteCustomThemeBtn.disabled = false;
      this.setFeedback(`Previewing ${palette.name}.`);
    });

    this.newCustomThemeBtn?.addEventListener('click', () => this.startNewCustomPalette());
    this.deleteCustomThemeBtn?.addEventListener('click', () => this.deleteActiveCustomPalette());
    this.saveThemeBtn?.addEventListener('click', () => this.saveActiveTheme());
    this.initializeCoverOptions();
    this.initializeTypographyOptions();

    if (this.activeTheme === 'custom') this.applyCustomPalette(this.draftPalette);
    else if (this.activeTheme === 'cover-match') {
      this.applyCoverPalette();
      void this.refreshCoverTheme();
    }
    else this.applyTheme(this.activeTheme);
    this.applyFontSize(this.activeFontSize);
    this.updateThemeBoxesUI();
    this.updateTypoBoxesUI();
  }

  selectTheme(theme) {
    this.activeTheme = ['morning-lo-fi', 'soft-sunset', 'custom', 'cover-match'].includes(theme) ? theme : 'morning-lo-fi';
    if (this.activeTheme !== 'cover-match') this.coverRequestGeneration += 1;
    if (this.activeTheme === 'custom') {
      this.customEditor.hidden = false;
      this.applyCustomPalette(this.draftPalette);
      this.updateContrastFeedback();
    } else if (this.activeTheme === 'cover-match') {
      this.applyCoverPalette();
      void this.refreshCoverTheme();
    } else {
      this.customEditor.hidden = true;
      this.applyTheme(this.activeTheme);
      this.setFeedback('Previewing. Choose Save Palette to keep it.');
    }
    this.updateThemeBoxesUI();
  }

  initializeCoverOptions() {
    if (this.coverStyleSelect) this.coverStyleSelect.value = this.coverOptions.style;
    if (this.coverMoodSelect) this.coverMoodSelect.value = this.coverOptions.mood;
    if (this.coverIntensityInput) this.coverIntensityInput.value = String(this.coverOptions.intensity);
    if (this.coverIntensityOutput) this.coverIntensityOutput.textContent = `${this.coverOptions.intensity}%`;

    const updateOptions = () => {
      this.activeTheme = 'cover-match';
      this.coverOptions = CoverThemeModule.normalizeCoverOptions({
        style: this.coverStyleSelect?.value,
        mood: this.coverMoodSelect?.value,
        intensity: this.coverIntensityInput?.value
      });
      if (this.coverIntensityOutput) this.coverIntensityOutput.textContent = `${this.coverOptions.intensity}%`;
      this.applyCoverPalette();
      this.updateThemeBoxesUI();
      this.setCoverFeedback('Previewing these cover settings. Choose Save Palette to keep them.');
    };
    this.coverStyleSelect?.addEventListener('change', updateOptions);
    this.coverMoodSelect?.addEventListener('change', updateOptions);
    this.coverIntensityInput?.addEventListener('input', updateOptions);
  }

  loadCoverOptions() {
    try {
      return CoverThemeModule.normalizeCoverOptions(JSON.parse(localStorage.getItem(this.coverStorageKey) || '{}'));
    } catch {
      return CoverThemeModule.normalizeCoverOptions({});
    }
  }

  setArtwork(rawUrl, rawIdentity = '') {
    let artworkUrl = '';
    if (
      typeof rawUrl === 'string' && rawUrl.length <= 4_200_000 &&
      /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(rawUrl)
    ) {
      artworkUrl = rawUrl;
    } else {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === 'https:') artworkUrl = parsed.toString();
      } catch {}
    }
    const identity = String(rawIdentity || artworkUrl).slice(0, 500);
    if (artworkUrl === this.currentArtworkUrl && identity === this.currentArtworkKey) return;
    this.currentArtworkUrl = artworkUrl;
    this.currentArtworkKey = identity;
    if (this.activeTheme === 'cover-match') void this.refreshCoverTheme();
  }

  async refreshCoverTheme() {
    if (this.activeTheme !== 'cover-match') return;
    const requestGeneration = ++this.coverRequestGeneration;
    const artworkUrl = this.currentArtworkUrl;
    if (!artworkUrl) {
      this.coverSourceColors = { ...CoverThemeModule.DEFAULT_SOURCE_COLORS };
      this.applyCoverPalette();
      this.setCoverFeedback('Waiting for a song cover. Cozy-Fi is using its fallback café colors.');
      return;
    }

    const cached = this.coverColorCache.get(artworkUrl);
    if (cached) {
      this.coverColorCache.delete(artworkUrl);
      this.coverColorCache.set(artworkUrl, cached);
      this.coverSourceColors = { ...cached };
      this.applyCoverPalette();
      this.setCoverFeedback(`Matched this cover · ${this.coverPalette.mood} · ${this.coverOptions.style.replace('-', ' ')}.`);
      return;
    }

    this.setCoverFeedback('Matching the current song cover…');
    try {
      const dataUrl = artworkUrl.startsWith('data:image/')
        ? artworkUrl
        : await window.cozyApi?.theme?.resolveArtwork?.(artworkUrl);
      const sourceColors = await CoverThemeModule.extractArtworkFromDataUrl(dataUrl);
      if (requestGeneration !== this.coverRequestGeneration || this.activeTheme !== 'cover-match') return;
      this.coverColorCache.set(artworkUrl, sourceColors);
      while (this.coverColorCache.size > 32) this.coverColorCache.delete(this.coverColorCache.keys().next().value);
      this.coverSourceColors = { ...sourceColors };
      this.applyCoverPalette();
      this.setCoverFeedback(`Matched this cover · ${this.coverPalette.mood} · ${this.coverOptions.style.replace('-', ' ')}.`);
    } catch (error) {
      if (requestGeneration !== this.coverRequestGeneration || this.activeTheme !== 'cover-match') return;
      this.coverSourceColors = { ...CoverThemeModule.DEFAULT_SOURCE_COLORS };
      this.applyCoverPalette();
      this.setCoverFeedback(error?.message || 'This cover could not be matched. Using fallback café colors.', true);
    }
  }

  initializeTypographyOptions() {
    this.typoRows.forEach((row, index) => {
      row.setAttribute('role', 'radio');
      const selectSize = () => {
        this.typoRows.forEach(item => {
          item.classList.remove('active');
          item.querySelector('.checkbox-custom')?.classList.remove('checked');
          item.setAttribute('aria-checked', 'false');
          item.tabIndex = -1;
        });
        row.classList.add('active');
        row.querySelector('.checkbox-custom')?.classList.add('checked');
        row.setAttribute('aria-checked', 'true');
        row.tabIndex = 0;
        this.activeFontSize = row.getAttribute('data-size');
        this.applyFontSize(this.activeFontSize);
        localStorage.setItem('cozy_font_size', this.activeFontSize);
      };
      row.addEventListener('click', selectSize);
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectSize();
        } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          const delta = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
          const next = this.typoRows[(index + delta + this.typoRows.length) % this.typoRows.length];
          next.focus();
          next.click();
        }
      });
    });
  }

  saveActiveTheme() {
    if (this.activeTheme === 'cover-match') {
      localStorage.setItem('cozy_theme', 'cover-match');
      localStorage.setItem(this.coverStorageKey, JSON.stringify(this.coverOptions));
      this.setCoverFeedback('Cover Match settings saved. Colors will follow each song.');
      return;
    }
    if (this.activeTheme !== 'custom') {
      localStorage.setItem('cozy_theme', this.activeTheme);
      this.setFeedback('Palette saved.');
      return;
    }

    const name = (this.customNameInput?.value || '').trim().slice(0, 32) || 'My Cozy Palette';
    let palette = this.customPalettes.find(item => item.id === this.activeCustomId);
    if (!palette) {
      if (this.customPalettes.length >= this.maxCustomPalettes) {
        this.setFeedback(`You can save up to ${this.maxCustomPalettes} custom palettes. Delete one first.`, true);
        return;
      }
      palette = { id: this.createId(), name, colors: { ...this.draftPalette } };
      this.customPalettes.push(palette);
      this.activeCustomId = palette.id;
    } else {
      palette.name = name;
      palette.colors = { ...this.draftPalette };
    }
    this.persistCustomPalettes();
    localStorage.setItem('cozy_theme', `custom:${palette.id}`);
    this.renderSavedPaletteOptions();
    this.savedThemeSelect.value = palette.id;
    this.deleteCustomThemeBtn.disabled = false;
    this.setFeedback(`${name} saved.`);
  }

  startNewCustomPalette() {
    this.activeTheme = 'custom';
    this.activeCustomId = null;
    this.draftPalette = { ...this.defaultCustomPalette };
    if (this.customNameInput) this.customNameInput.value = 'My Cozy Palette';
    if (this.savedThemeSelect) this.savedThemeSelect.value = '';
    if (this.customEditor) this.customEditor.hidden = false;
    if (this.deleteCustomThemeBtn) this.deleteCustomThemeBtn.disabled = true;
    this.writePaletteToEditor(this.draftPalette);
    this.applyCustomPalette(this.draftPalette);
    this.updateThemeBoxesUI();
    this.setFeedback('New palette ready. Adjust colors, then save it.');
  }

  deleteActiveCustomPalette() {
    if (!this.activeCustomId) return;
    const deleted = this.customPalettes.find(item => item.id === this.activeCustomId);
    this.customPalettes = this.customPalettes.filter(item => item.id !== this.activeCustomId);
    this.persistCustomPalettes();
    localStorage.setItem('cozy_theme', 'morning-lo-fi');
    this.activeCustomId = null;
    this.activeTheme = 'morning-lo-fi';
    this.renderSavedPaletteOptions();
    this.applyTheme('morning-lo-fi');
    this.updateThemeBoxesUI();
    this.setFeedback(`${deleted?.name || 'Custom palette'} deleted.`);
  }

  applyTheme(theme) {
    this.clearThemeClassesAndStyles();
    if (theme === 'soft-sunset') document.body.classList.add('theme-soft-sunset');
    if (this.customEditor) this.customEditor.hidden = true;
    if (this.coverEditor) this.coverEditor.hidden = true;
    this.notifyThemeChange();
  }

  applyCustomPalette(colors) {
    this.clearThemeClassesAndStyles();
    document.body.classList.add('theme-custom');
    const accentHover = this.mixHex(colors.accentColor, colors.borderColor, 0.18);
    const progressBg = this.mixHex(colors.bgCard, colors.bgPrimary, 0.45);
    const cardLight = this.mixHex(colors.bgCard, colors.bgSecondary, 0.45);
    const buttonText = this.contrastRatio(colors.accentColor, '#241b1b') >= 4.5 ? '#241b1b' : '#fffaf4';
    const variables = {
      '--bg-primary': colors.bgPrimary,
      '--bg-secondary': colors.bgSecondary,
      '--bg-card': colors.bgCard,
      '--text-primary': colors.textPrimary,
      '--text-secondary': colors.textSecondary,
      '--accent-color': colors.accentColor,
      '--accent-color-hover': accentHover,
      '--border-color': colors.borderColor,
      '--progress-bg': progressBg,
      '--shadow-color': colors.borderColor,
      '--card-light': cardLight,
      '--button-filled-text': buttonText
    };
    Object.entries(variables).forEach(([property, value]) => document.body.style.setProperty(property, value));
    if (this.customEditor) this.customEditor.hidden = false;
    if (this.coverEditor) this.coverEditor.hidden = true;
    this.notifyThemeChange();
  }

  applyCoverPalette() {
    this.coverPalette = CoverThemeModule.buildCoverThemePalette(this.coverSourceColors, this.coverOptions);
    const colors = this.coverPalette.colors;
    const cover = this.coverPalette.cover;
    this.clearThemeClassesAndStyles();
    document.body.classList.add('theme-cover-match', `cover-style-${cover.style}`);
    const accentHover = this.mixHex(colors.accentColor, colors.borderColor, 0.18);
    const variables = {
      '--bg-primary': colors.bgPrimary,
      '--bg-secondary': colors.bgSecondary,
      '--bg-card': colors.bgCard,
      '--text-primary': colors.textPrimary,
      '--text-secondary': colors.textSecondary,
      '--accent-color': colors.accentColor,
      '--accent-color-hover': accentHover,
      '--border-color': colors.borderColor,
      '--progress-bg': this.mixHex(colors.bgCard, colors.bgPrimary, 0.45),
      '--shadow-color': colors.borderColor,
      '--card-light': this.mixHex(colors.bgCard, colors.bgSecondary, 0.45),
      '--button-filled-text': this.contrastRatio(colors.accentColor, '#241b1b') >= 4.5 ? '#241b1b' : '#fffaf4',
      '--cover-start': cover.start,
      '--cover-end': cover.end,
      '--cover-glow': cover.glow
    };
    Object.entries(variables).forEach(([property, value]) => document.body.style.setProperty(property, value));
    if (this.customEditor) this.customEditor.hidden = true;
    if (this.coverEditor) this.coverEditor.hidden = false;
    this.updateCoverSwatches();
    this.notifyThemeChange();
  }

  clearThemeClassesAndStyles() {
    Array.from(document.body.classList)
      .filter(className => className.startsWith('theme-') || className.startsWith('cover-style-'))
      .forEach(className => document.body.classList.remove(className));
    [
      '--bg-primary', '--bg-secondary', '--bg-card', '--text-primary', '--text-secondary',
      '--accent-color', '--accent-color-hover', '--border-color', '--progress-bg',
      '--shadow-color', '--card-light', '--button-filled-text',
      '--cover-start', '--cover-end', '--cover-glow'
    ].forEach(property => document.body.style.removeProperty(property));
  }

  applyFontSize(size) {
    Array.from(document.body.classList)
      .filter(className => className.startsWith('font-'))
      .forEach(className => document.body.classList.remove(className));
    if (size === 'enlarged') document.body.classList.add('font-enlarged');
    this.notifyThemeChange();
  }

  notifyThemeChange() {
    const api = window.cozyApi?.sidePlayer;
    if (!api?.syncTheme) return;
    let payload;
    if (this.activeTheme === 'custom') {
      payload = { kind: 'custom', colors: { ...this.draftPalette }, fontSize: this.activeFontSize };
    } else if (this.activeTheme === 'cover-match') {
      payload = {
        kind: 'cover',
        colors: { ...this.coverPalette.colors },
        cover: { ...this.coverPalette.cover },
        options: { ...this.coverOptions },
        fontSize: this.activeFontSize
      };
    } else {
      payload = { kind: 'preset', id: this.activeTheme, fontSize: this.activeFontSize };
    }
    api.syncTheme(payload).catch(error => console.warn('Could not sync the side-player theme:', error));
  }

  updateThemeBoxesUI() {
    this.themeBoxes.forEach(box => {
      const active = box.getAttribute('data-theme') === this.activeTheme;
      box.classList.toggle('active', active);
      box.setAttribute('aria-checked', String(active));
      box.tabIndex = active ? 0 : -1;
    });
    if (this.customEditor) this.customEditor.hidden = this.activeTheme !== 'custom';
    if (this.coverEditor) this.coverEditor.hidden = this.activeTheme !== 'cover-match';
    this.updateCustomSwatches();
    this.updateCoverSwatches();
  }

  updateTypoBoxesUI() {
    this.typoRows.forEach(row => {
      const active = row.getAttribute('data-size') === this.activeFontSize;
      row.classList.toggle('active', active);
      row.querySelector('.checkbox-custom')?.classList.toggle('checked', active);
      row.setAttribute('aria-checked', String(active));
      row.tabIndex = active ? 0 : -1;
    });
  }

  writePaletteToEditor(colors) {
    this.colorInputs.forEach(input => {
      const value = this.normalizeHex(colors[input.dataset.colorKey], this.defaultCustomPalette[input.dataset.colorKey]);
      input.value = value;
      input.parentElement?.querySelector('output')?.replaceChildren(value.toUpperCase());
    });
    this.updateCustomSwatches();
  }

  updateCustomSwatches() {
    const assignments = {
      'custom-swatch-primary': this.draftPalette.bgPrimary,
      'custom-swatch-card': this.draftPalette.bgCard,
      'custom-swatch-accent': this.draftPalette.accentColor
    };
    Object.entries(assignments).forEach(([id, color]) => {
      const element = document.getElementById(id);
      if (element) element.style.backgroundColor = color;
    });
  }

  updateCoverSwatches() {
    const palette = this.coverPalette || CoverThemeModule.buildCoverThemePalette();
    const assignments = {
      'cover-swatch-primary': palette.cover.start,
      'cover-swatch-card': palette.cover.end,
      'cover-swatch-accent': palette.colors.accentColor
    };
    Object.entries(assignments).forEach(([id, color]) => {
      const element = document.getElementById(id);
      if (element) element.style.backgroundColor = color;
    });
  }

  updateContrastFeedback() {
    const primaryRatio = this.contrastRatio(this.draftPalette.textPrimary, this.draftPalette.bgPrimary);
    const secondaryRatio = this.contrastRatio(this.draftPalette.textSecondary, this.draftPalette.bgPrimary);
    if (primaryRatio < 4.5 || secondaryRatio < 4.5) {
      this.setFeedback('Low text contrast. Darken the text or lighten the background for readability.', true);
    } else {
      this.setFeedback('Previewing custom colors. Choose Save Palette to keep them.');
    }
  }

  renderSavedPaletteOptions() {
    if (!this.savedThemeSelect) return;
    this.savedThemeSelect.replaceChildren();
    const newOption = document.createElement('option');
    newOption.value = '';
    newOption.textContent = 'New palette';
    this.savedThemeSelect.appendChild(newOption);
    this.customPalettes.forEach(palette => {
      const option = document.createElement('option');
      option.value = palette.id;
      option.textContent = palette.name;
      this.savedThemeSelect.appendChild(option);
    });
    this.savedThemeSelect.value = this.activeCustomId || '';
  }

  loadCustomPalettes() {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.storageKey) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.slice(0, this.maxCustomPalettes).filter(item => (
        item && typeof item.id === 'string' && typeof item.name === 'string' &&
        item.colors && Object.keys(this.defaultCustomPalette).every(key => /^#[0-9a-f]{6}$/i.test(item.colors[key] || ''))
      ));
    } catch {
      return [];
    }
  }

  persistCustomPalettes() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.customPalettes));
  }

  setFeedback(message, warning = false) {
    if (!this.feedbackEl) return;
    this.feedbackEl.textContent = message;
    this.feedbackEl.classList.toggle('warning', warning);
  }

  setCoverFeedback(message, warning = false) {
    if (!this.coverFeedbackEl) return;
    this.coverFeedbackEl.textContent = message;
    this.coverFeedbackEl.classList.toggle('warning', warning);
  }

  normalizeHex(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : fallback;
  }

  createId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  mixHex(first, second, secondWeight) {
    const a = this.hexToRgb(first);
    const b = this.hexToRgb(second);
    const weight = Math.max(0, Math.min(1, secondWeight));
    const targetChannels = [b.r, b.g, b.b];
    const mixed = [a.r, a.g, a.b].map((channel, index) => (
      Math.round(channel * (1 - weight) + targetChannels[index] * weight)
    ));
    return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
  }

  hexToRgb(value) {
    const normalized = this.normalizeHex(value, '#000000').slice(1);
    return {
      r: parseInt(normalized.slice(0, 2), 16),
      g: parseInt(normalized.slice(2, 4), 16),
      b: parseInt(normalized.slice(4, 6), 16)
    };
  }

  contrastRatio(first, second) {
    const luminance = color => {
      const { r, g, b } = this.hexToRgb(color);
      const channels = [r, g, b].map(channel => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const lighter = Math.max(luminance(first), luminance(second));
    const darker = Math.min(luminance(first), luminance(second));
    return (lighter + 0.05) / (darker + 0.05);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ThemeManager;
} else {
  window.ThemeManager = ThemeManager;
}
