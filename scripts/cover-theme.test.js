const assert = require('node:assert/strict');
const {
  DEFAULT_SOURCE_COLORS,
  contrastRatio,
  colorDistance,
  normalizeCoverOptions,
  normalizeGlassOptions,
  extractArtworkColors,
  buildCoverThemePalette,
  buildGlassThemePalette
} = require('../js/cover-theme');

assert.deepEqual(normalizeCoverOptions({}), {
  style: 'soft-gradient',
  mood: 'auto',
  intensity: 68
});
assert.deepEqual(normalizeCoverOptions({ style: 'nope', mood: 'sepia', intensity: 500 }), {
  style: 'soft-gradient',
  mood: 'auto',
  intensity: 100
});
assert.deepEqual(normalizeCoverOptions({ style: 'solid', mood: 'dark', intensity: 5 }), {
  style: 'solid',
  mood: 'dark',
  intensity: 20
});
assert.deepEqual(normalizeGlassOptions({}), {
  style: 'liquid',
  tone: 'cover',
  opacity: 78,
  blur: 26
});
assert.deepEqual(normalizeGlassOptions({ style: 'flat', tone: 'blue', opacity: 2, blur: 900 }), {
  style: 'liquid',
  tone: 'cover',
  opacity: 65,
  blur: 48
});

const width = 8;
const height = 8;
const pixels = new Uint8ClampedArray(width * height * 4);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const offset = ((y * width) + x) * 4;
    pixels.set(x >= 5 ? [25, 65, 220, 255] : [220, 35, 45, 255], offset);
  }
}
const extracted = extractArtworkColors(pixels, width, height);
assert.ok(colorDistance(extracted.primary, '#dc232d') < 0.05, 'the dominant red area should lead the palette');
assert.ok(colorDistance(extracted.secondary, '#1941dc') < 0.05, 'a distinct secondary blue should be retained');
assert.ok(colorDistance(extracted.primary, extracted.secondary) > 0.4);
assert.deepEqual(extractArtworkColors([], 0, 0), DEFAULT_SOURCE_COLORS);

const sources = [
  extracted,
  { primary: '#ffffff', secondary: '#eeeeee', accent: '#f0f0f0', average: '#fafafa' },
  { primary: '#000000', secondary: '#111111', accent: '#222222', average: '#080808' },
  { primary: '#df2020', secondary: '#2040df', accent: '#20b060', average: '#704060' }
];
for (const source of sources) {
  for (const mood of ['light', 'dark', 'auto']) {
    for (const style of ['soft-gradient', 'vivid-gradient', 'solid']) {
      const palette = buildCoverThemePalette(source, { mood, style, intensity: 100 });
      const backgrounds = [
        palette.colors.bgPrimary,
        palette.colors.bgSecondary,
        palette.colors.bgCard,
        palette.cover.start,
        palette.cover.end,
        palette.cover.glow
      ];
      for (const value of [...Object.values(palette.colors), ...Object.values(palette.cover).slice(1)]) {
        assert.match(value, /^#[0-9a-f]{6}$/i);
      }
      assert.ok(
        backgrounds.every(background => contrastRatio(palette.colors.textPrimary, background) >= 7),
        `${mood}/${style} primary text should retain enhanced contrast`
      );
      assert.ok(
        backgrounds.every(background => contrastRatio(palette.colors.textSecondary, background) >= 4.5),
        `${mood}/${style} secondary text should retain accessible contrast`
      );
      assert.equal(palette.options.style, style);
    }
  }
}

assert.equal(buildCoverThemePalette({ average: '#050505' }, { mood: 'auto' }).mood, 'dark');
assert.equal(buildCoverThemePalette({ average: '#fafafa' }, { mood: 'auto' }).mood, 'light');

for (const source of sources) {
  for (const style of ['frosted', 'liquid']) {
    for (const tone of ['cover', 'light', 'dark']) {
      const palette = buildGlassThemePalette(source, { style, tone, opacity: 72, blur: 32 });
      assert.equal(palette.options.style, style);
      assert.equal(palette.options.tone, tone);
      assert.equal(palette.options.opacity, 72);
      assert.equal(palette.options.blur, 32);
      for (const value of [...Object.values(palette.colors), ...Object.values(palette.glass).slice(1)]) {
        assert.match(value, /^#[0-9a-f]{6}$/i);
      }
      for (const background of [palette.colors.bgPrimary, palette.colors.bgSecondary, palette.colors.bgCard]) {
        assert.ok(contrastRatio(palette.colors.textPrimary, background) >= 7);
        assert.ok(contrastRatio(palette.colors.textSecondary, background) >= 4.5);
      }
    }
  }
}

console.log('Cover color extraction, glass customization, and contrast checks passed.');
