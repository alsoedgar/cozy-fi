// Cozy-Fi Theme and Font scale module
class ThemeManager {
  constructor(themeBoxes, saveThemeBtn, typoRows) {
    this.themeBoxes = Array.from(themeBoxes || []);
    this.saveThemeBtn = saveThemeBtn;
    this.typoRows = Array.from(typoRows || []);
    this.storageKey = 'cozy_custom_palettes_v1';
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
    this.customPalettes = this.loadCustomPalettes();
    this.activeTheme = localStorage.getItem('cozy_theme') || 'morning-lo-fi';
    this.activeCustomId = this.activeTheme.startsWith('custom:') ? this.activeTheme.slice(7) : null;
    this.activeTheme = this.activeCustomId ? 'custom' : this.activeTheme;
    this.activeFontSize = localStorage.getItem('cozy_font_size') || 'standard';
    this.draftPalette = { ...this.defaultCustomPalette };

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
    this.initializeTypographyOptions();

    if (this.activeTheme === 'custom') this.applyCustomPalette(this.draftPalette);
    else this.applyTheme(this.activeTheme);
    this.applyFontSize(this.activeFontSize);
    this.updateThemeBoxesUI();
    this.updateTypoBoxesUI();
  }

  selectTheme(theme) {
    this.activeTheme = ['morning-lo-fi', 'soft-sunset', 'custom'].includes(theme) ? theme : 'morning-lo-fi';
    if (this.activeTheme === 'custom') {
      this.customEditor.hidden = false;
      this.applyCustomPalette(this.draftPalette);
      this.updateContrastFeedback();
    } else {
      this.customEditor.hidden = true;
      this.applyTheme(this.activeTheme);
      this.setFeedback('Previewing. Choose Save Palette to keep it.');
    }
    this.updateThemeBoxesUI();
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
    this.notifyThemeChange();
  }

  clearThemeClassesAndStyles() {
    Array.from(document.body.classList)
      .filter(className => className.startsWith('theme-'))
      .forEach(className => document.body.classList.remove(className));
    [
      '--bg-primary', '--bg-secondary', '--bg-card', '--text-primary', '--text-secondary',
      '--accent-color', '--accent-color-hover', '--border-color', '--progress-bg',
      '--shadow-color', '--card-light', '--button-filled-text'
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
    const payload = this.activeTheme === 'custom'
      ? { kind: 'custom', colors: { ...this.draftPalette }, fontSize: this.activeFontSize }
      : { kind: 'preset', id: this.activeTheme, fontSize: this.activeFontSize };
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
    this.updateCustomSwatches();
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
