(function exposeCoverTheme(globalScope, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.CozyCoverTheme = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const DEFAULT_SOURCE_COLORS = Object.freeze({
    primary: '#c08a6e',
    secondary: '#ebd9c5',
    accent: '#705e54',
    average: '#c7a891'
  });
  const COVER_STYLES = new Set(['soft-gradient', 'vivid-gradient', 'solid']);
  const COVER_MOODS = new Set(['auto', 'light', 'dark']);
  const GLASS_STYLES = new Set(['frosted', 'liquid']);
  const GLASS_TONES = new Set(['cover', 'light', 'dark']);

  function clamp(value, minimum = 0, maximum = 1) {
    return Math.max(minimum, Math.min(maximum, Number(value) || 0));
  }

  function normalizeHex(value, fallback = '#000000') {
    return /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : fallback;
  }

  function hexToRgb(value) {
    const hex = normalizeHex(value).slice(1);
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16)
    };
  }

  function rgbToHex(red, green, blue) {
    return `#${[red, green, blue]
      .map(channel => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, '0'))
      .join('')}`;
  }

  function rgbToHsl(red, green, blue) {
    const r = clamp(red, 0, 255) / 255;
    const g = clamp(green, 0, 255) / 255;
    const b = clamp(blue, 0, 255) / 255;
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    const delta = maximum - minimum;
    let hue = 0;
    if (delta) {
      if (maximum === r) hue = ((g - b) / delta) % 6;
      else if (maximum === g) hue = ((b - r) / delta) + 2;
      else hue = ((r - g) / delta) + 4;
      hue = ((hue * 60) + 360) % 360;
    }
    const lightness = (maximum + minimum) / 2;
    const saturation = delta ? delta / (1 - Math.abs((2 * lightness) - 1)) : 0;
    return { h: hue, s: saturation, l: lightness };
  }

  function hexToHsl(value) {
    const { r, g, b } = hexToRgb(value);
    return rgbToHsl(r, g, b);
  }

  function hslToHex(hue, saturation, lightness) {
    const h = ((Number(hue) % 360) + 360) % 360;
    const s = clamp(saturation);
    const l = clamp(lightness);
    const chroma = (1 - Math.abs((2 * l) - 1)) * s;
    const segment = h / 60;
    const x = chroma * (1 - Math.abs((segment % 2) - 1));
    let channels = [0, 0, 0];
    if (segment < 1) channels = [chroma, x, 0];
    else if (segment < 2) channels = [x, chroma, 0];
    else if (segment < 3) channels = [0, chroma, x];
    else if (segment < 4) channels = [0, x, chroma];
    else if (segment < 5) channels = [x, 0, chroma];
    else channels = [chroma, 0, x];
    const offset = l - (chroma / 2);
    return rgbToHex(...channels.map(channel => (channel + offset) * 255));
  }

  function mixHex(first, second, secondWeight) {
    const a = hexToRgb(first);
    const b = hexToRgb(second);
    const weight = clamp(secondWeight);
    return rgbToHex(
      a.r * (1 - weight) + b.r * weight,
      a.g * (1 - weight) + b.g * weight,
      a.b * (1 - weight) + b.b * weight
    );
  }

  function relativeLuminance(value) {
    const { r, g, b } = hexToRgb(value);
    const channels = [r, g, b].map(channel => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return (channels[0] * 0.2126) + (channels[1] * 0.7152) + (channels[2] * 0.0722);
  }

  function contrastRatio(first, second) {
    const firstLuminance = relativeLuminance(first);
    const secondLuminance = relativeLuminance(second);
    const lighter = Math.max(firstLuminance, secondLuminance);
    const darker = Math.min(firstLuminance, secondLuminance);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function colorDistance(first, second) {
    const a = hexToRgb(first);
    const b = hexToRgb(second);
    return Math.sqrt(((a.r - b.r) ** 2) + ((a.g - b.g) ** 2) + ((a.b - b.b) ** 2)) / 441.673;
  }

  function normalizeCoverOptions(value = {}) {
    const style = COVER_STYLES.has(value.style) ? value.style : 'soft-gradient';
    const mood = COVER_MOODS.has(value.mood) ? value.mood : 'auto';
    const intensity = Math.round(clamp(Number(value.intensity) || 68, 20, 100));
    return { style, mood, intensity };
  }

  function normalizeGlassOptions(value = {}) {
    const style = GLASS_STYLES.has(value.style) ? value.style : 'liquid';
    const tone = GLASS_TONES.has(value.tone) ? value.tone : 'cover';
    const opacity = Math.round(clamp(Number(value.opacity) || 78, 65, 96));
    const blur = Math.round(clamp(Number(value.blur) || 26, 8, 48));
    return { style, tone, opacity, blur };
  }

  function representativeColor(bucket) {
    const divisor = bucket.weight || 1;
    return rgbToHex(bucket.red / divisor, bucket.green / divisor, bucket.blue / divisor);
  }

  function extractArtworkColors(rawPixels, rawWidth, rawHeight) {
    const pixels = rawPixels && typeof rawPixels.length === 'number' ? rawPixels : [];
    const width = Math.max(1, Math.floor(Number(rawWidth) || 0));
    const height = Math.max(1, Math.floor(Number(rawHeight) || 0));
    if (pixels.length < width * height * 4) return { ...DEFAULT_SOURCE_COLORS };

    const buckets = new Map();
    let totalWeight = 0;
    let averageRed = 0;
    let averageGreen = 0;
    let averageBlue = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = ((y * width) + x) * 4;
        const alpha = Number(pixels[offset + 3]) || 0;
        if (alpha < 96) continue;
        const red = Number(pixels[offset]) || 0;
        const green = Number(pixels[offset + 1]) || 0;
        const blue = Number(pixels[offset + 2]) || 0;
        const edge = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
        const weight = (alpha / 255) * (edge ? 0.62 : 1);
        const key = `${red >> 4}:${green >> 4}:${blue >> 4}`;
        const bucket = buckets.get(key) || { weight: 0, red: 0, green: 0, blue: 0 };
        bucket.weight += weight;
        bucket.red += red * weight;
        bucket.green += green * weight;
        bucket.blue += blue * weight;
        buckets.set(key, bucket);
        totalWeight += weight;
        averageRed += red * weight;
        averageGreen += green * weight;
        averageBlue += blue * weight;
      }
    }
    if (!totalWeight || buckets.size === 0) return { ...DEFAULT_SOURCE_COLORS };

    const candidates = Array.from(buckets.values()).map(bucket => {
      const color = representativeColor(bucket);
      const hsl = hexToHsl(color);
      const extremePenalty = hsl.l < 0.025 || hsl.l > 0.975 ? 0.58 : 1;
      return {
        color,
        weight: bucket.weight,
        saturation: hsl.s,
        lightness: hsl.l,
        dominantScore: bucket.weight * (0.76 + (hsl.s * 0.5)) * extremePenalty
      };
    }).sort((left, right) => right.dominantScore - left.dominantScore);

    const primary = candidates[0]?.color || DEFAULT_SOURCE_COLORS.primary;
    const distinct = candidates.filter(candidate => colorDistance(candidate.color, primary) >= 0.14);
    const secondaryCandidate = [...distinct].sort((left, right) => (
      (right.weight * (0.55 + colorDistance(right.color, primary))) -
      (left.weight * (0.55 + colorDistance(left.color, primary)))
    ))[0];
    const secondary = secondaryCandidate?.color || mixHex(primary, DEFAULT_SOURCE_COLORS.secondary, 0.42);
    const accentCandidates = candidates.filter(candidate => (
      colorDistance(candidate.color, primary) >= 0.1 && candidate.lightness > 0.05 && candidate.lightness < 0.95
    ));
    const accentCandidate = [...accentCandidates].sort((left, right) => {
      const leftScore = Math.sqrt(left.weight) * (0.3 + (left.saturation * 1.5)) * (0.4 + colorDistance(left.color, primary));
      const rightScore = Math.sqrt(right.weight) * (0.3 + (right.saturation * 1.5)) * (0.4 + colorDistance(right.color, primary));
      return rightScore - leftScore;
    })[0];
    let accent = accentCandidate?.color || secondary;
    if (hexToHsl(accent).s < 0.08) accent = DEFAULT_SOURCE_COLORS.accent;
    const average = rgbToHex(averageRed / totalWeight, averageGreen / totalWeight, averageBlue / totalWeight);
    return { primary, secondary, accent, average };
  }

  function toneColor(value, targetLightness, saturationScale, maximumSaturation) {
    const hsl = hexToHsl(value);
    return hslToHex(hsl.h, Math.min(maximumSaturation, hsl.s * saturationScale), targetLightness);
  }

  function ensureContrast(foreground, backgrounds, minimumRatio, lightText) {
    let hsl = hexToHsl(foreground);
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const candidate = hslToHex(hsl.h, hsl.s, hsl.l);
      if (backgrounds.every(background => contrastRatio(candidate, background) >= minimumRatio)) return candidate;
      hsl = { ...hsl, l: clamp(hsl.l + (lightText ? 0.035 : -0.035)) };
    }
    return lightText ? '#fffaf4' : '#211b20';
  }

  function constrainBackground(value, dark) {
    const referenceText = dark ? '#fffaf4' : '#211b20';
    const minimumRatio = 7;
    let hsl = hexToHsl(value);
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const candidate = hslToHex(hsl.h, hsl.s, hsl.l);
      if (contrastRatio(referenceText, candidate) >= minimumRatio) return candidate;
      hsl = { ...hsl, l: clamp(hsl.l + (dark ? -0.02 : 0.02)) };
    }
    return dark ? '#17151b' : '#f7f2eb';
  }

  function buildCoverThemePalette(rawSourceColors = {}, rawOptions = {}) {
    const options = normalizeCoverOptions(rawOptions);
    const source = {
      primary: normalizeHex(rawSourceColors.primary, DEFAULT_SOURCE_COLORS.primary),
      secondary: normalizeHex(rawSourceColors.secondary, DEFAULT_SOURCE_COLORS.secondary),
      accent: normalizeHex(rawSourceColors.accent, DEFAULT_SOURCE_COLORS.accent),
      average: normalizeHex(rawSourceColors.average, DEFAULT_SOURCE_COLORS.average)
    };
    if (hexToHsl(source.accent).s < 0.08) source.accent = DEFAULT_SOURCE_COLORS.accent;
    const strength = options.intensity / 100;
    const mood = options.mood === 'auto'
      ? (relativeLuminance(source.average) < 0.32 ? 'dark' : 'light')
      : options.mood;
    const dark = mood === 'dark';
    const styleSaturation = options.style === 'vivid-gradient' ? 1.12 : options.style === 'solid' ? 0.82 : 0.72;
    const saturationScale = (0.24 + (strength * 0.82)) * styleSaturation;
    const maximumSaturation = options.style === 'vivid-gradient' ? 0.86 : 0.68;

    let bgPrimary = toneColor(
      source.primary,
      dark ? 0.1 + (strength * 0.075) : 0.97 - (strength * 0.08),
      saturationScale,
      maximumSaturation
    );
    let bgSecondary = toneColor(
      source.secondary,
      dark ? 0.14 + (strength * 0.085) : 0.985 - (strength * 0.055),
      saturationScale * 0.78,
      maximumSaturation * 0.82
    );
    let bgCard = toneColor(
      mixHex(source.primary, source.secondary, 0.42),
      dark ? 0.18 + (strength * 0.09) : 0.94 - (strength * 0.095),
      saturationScale * 0.9,
      maximumSaturation * 0.9
    );
    let gradientStart = toneColor(
      source.primary,
      dark ? 0.13 + (strength * 0.1) : 0.94 - (strength * 0.125),
      saturationScale * 1.05,
      maximumSaturation
    );
    let gradientEnd = toneColor(
      source.secondary,
      dark ? 0.15 + (strength * 0.11) : 0.96 - (strength * 0.13),
      saturationScale,
      maximumSaturation
    );
    let glowColor = toneColor(
      source.accent,
      dark ? 0.17 + (strength * 0.115) : 0.93 - (strength * 0.13),
      saturationScale * 1.12,
      maximumSaturation
    );
    const accentColor = toneColor(
      source.accent,
      dark ? 0.62 + (strength * 0.05) : 0.5 - (strength * 0.055),
      Math.max(0.85, saturationScale * 1.25),
      0.9
    );
    bgPrimary = constrainBackground(bgPrimary, dark);
    bgSecondary = constrainBackground(bgSecondary, dark);
    bgCard = constrainBackground(bgCard, dark);
    gradientStart = constrainBackground(gradientStart, dark);
    gradientEnd = constrainBackground(gradientEnd, dark);
    glowColor = constrainBackground(glowColor, dark);
    const readableBackgrounds = [bgPrimary, bgSecondary, bgCard, gradientStart, gradientEnd, glowColor];
    const primarySeed = toneColor(source.primary, dark ? 0.94 : 0.12, 0.22, 0.28);
    const secondarySeed = toneColor(source.secondary, dark ? 0.76 : 0.3, 0.25, 0.32);
    const textPrimary = ensureContrast(primarySeed, readableBackgrounds, 7, dark);
    const textSecondary = ensureContrast(secondarySeed, readableBackgrounds, 4.5, dark);

    return {
      mood,
      options,
      source,
      colors: {
        bgPrimary,
        bgSecondary,
        bgCard,
        textPrimary,
        textSecondary,
        accentColor,
        borderColor: textPrimary
      },
      cover: {
        style: options.style,
        start: gradientStart,
        end: gradientEnd,
        glow: glowColor
      }
    };
  }

  function buildGlassThemePalette(rawSourceColors = {}, rawOptions = {}) {
    const options = normalizeGlassOptions(rawOptions);
    const sourceColors = options.tone === 'light'
      ? DEFAULT_SOURCE_COLORS
      : options.tone === 'dark'
        ? { primary: '#293442', secondary: '#725b69', accent: '#c58f73', average: '#1c232d' }
        : rawSourceColors;
    const palette = buildCoverThemePalette(sourceColors, {
      style: options.style === 'liquid' ? 'vivid-gradient' : 'soft-gradient',
      mood: options.tone === 'cover' ? 'auto' : options.tone,
      intensity: options.style === 'liquid' ? 76 : 58
    });
    const lightGlass = palette.mood === 'light';
    return {
      mood: palette.mood,
      options,
      source: palette.source,
      colors: palette.colors,
      glass: {
        style: options.style,
        start: palette.cover.start,
        end: palette.cover.end,
        glow: palette.cover.glow,
        sheen: lightGlass ? '#ffffff' : '#fffaf4'
      }
    };
  }

  function extractArtworkFromDataUrl(dataUrl, sampleSize = 40) {
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      return Promise.reject(new Error('Artwork color extraction requires a browser canvas.'));
    }
    if (
      typeof dataUrl !== 'string' || dataUrl.length > 4_200_000 ||
      !/^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(dataUrl)
    ) {
      return Promise.reject(new Error('Artwork data was not a supported image.'));
    }
    const size = Math.max(16, Math.min(72, Math.round(Number(sampleSize) || 40)));
    return new Promise((resolve, reject) => {
      const image = new Image();
      const timeout = setTimeout(() => reject(new Error('Artwork decoding timed out.')), 5000);
      image.onload = () => {
        clearTimeout(timeout);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
          if (!context) throw new Error('Artwork canvas is unavailable.');
          const sourceWidth = image.naturalWidth || image.width;
          const sourceHeight = image.naturalHeight || image.height;
          const cropSize = Math.min(sourceWidth, sourceHeight);
          const sourceX = Math.max(0, (sourceWidth - cropSize) / 2);
          const sourceY = Math.max(0, (sourceHeight - cropSize) / 2);
          context.drawImage(image, sourceX, sourceY, cropSize, cropSize, 0, 0, size, size);
          const imageData = context.getImageData(0, 0, size, size);
          resolve(extractArtworkColors(imageData.data, size, size));
        } catch (error) {
          reject(error);
        }
      };
      image.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Artwork could not be decoded.'));
      };
      image.decoding = 'async';
      image.src = dataUrl;
    });
  }

  return {
    DEFAULT_SOURCE_COLORS,
    normalizeHex,
    hexToRgb,
    mixHex,
    relativeLuminance,
    contrastRatio,
    colorDistance,
    normalizeCoverOptions,
    normalizeGlassOptions,
    extractArtworkColors,
    buildCoverThemePalette,
    buildGlassThemePalette,
    extractArtworkFromDataUrl
  };
});
