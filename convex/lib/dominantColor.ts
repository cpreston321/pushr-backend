/**
 * Pick the color a logo "reads as".
 *
 * Deliberately not an average: meaning a flat mean of every pixel turns a
 * gold-on-navy mark into muddy olive, and any logo on a white card into
 * off-white. What a person names as a logo's color is its most prominent
 * *chromatic* region, so this bins pixels by hue and picks the strongest bin.
 *
 * Pure and runtime-free — no Node built-ins, no image decoding — so it can be
 * unit-tested directly. Decoding lives in `convex/logoColor.ts`.
 */

/** Hue bins. 24 gives 15° buckets: fine enough to separate gold from orange. */
const HUE_BINS = 24;

/** Below this alpha a pixel is transparent padding and carries no color. */
const MIN_ALPHA = 128;

/**
 * Saturation floor for a pixel to count as chromatic. Below it, the pixel is
 * part of the neutral scaffolding (background, white text, black outline) that
 * nearly every logo has and that nobody would name as its color.
 */
const MIN_SATURATION = 0.18;

/**
 * Value floor. Excludes near-black outlines and shadows.
 *
 * There is deliberately no *ceiling*: a fully-bright saturated pixel (a vivid
 * red at v = 1) is exactly the kind of pixel we want, and capping value would
 * throw it away. Near-white is already excluded by `MIN_SATURATION`, which is
 * the property that actually distinguishes white from a bright color.
 */
const MIN_VALUE = 0.12;

/**
 * Fraction of sampled pixels that must be chromatic for a hue to win. Under it,
 * the mark is genuinely monochrome (a black glyph, a white wordmark) and we
 * return null rather than amplify a few stray anti-aliasing pixels into an
 * identity color.
 */
const MIN_CHROMATIC_RATIO = 0.02;

export type Rgba = { r: number; g: number; b: number; a: number };

type Hsv = { h: number; s: number; v: number };

export function rgbToHsv({ r, g, b }: { r: number; g: number; b: number }): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): { r: number; g: number; b: number } {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = v - c;
  const seg = Math.floor(hp) % 6;
  const table: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x]
  ];
  const [r1, g1, b1] = table[seg];
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255)
  };
}

export function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/**
 * The color a set of pixels reads as, or `null` when there's no chromatic
 * signal worth calling an identity color.
 *
 * Bins chromatic pixels by hue, weights each by saturation so a small vivid
 * mark beats a large washed-out field, then averages within the winning bin —
 * circularly, so hues either side of 0° don't average to cyan.
 */
export function dominantColor(pixels: Rgba[]): string | null {
  const bins = Array.from({ length: HUE_BINS }, () => ({
    weight: 0,
    // Hue accumulates as a unit vector; averaging degrees directly would put
    // the mean of 350° and 10° at 180°.
    x: 0,
    y: 0,
    s: 0,
    v: 0,
    count: 0
  }));

  let considered = 0;
  let chromatic = 0;

  for (const px of pixels) {
    if (px.a < MIN_ALPHA) continue;
    considered++;
    const { h, s, v } = rgbToHsv(px);
    if (s < MIN_SATURATION || v < MIN_VALUE) continue;
    chromatic++;

    const bin = bins[Math.min(HUE_BINS - 1, Math.floor((h / 360) * HUE_BINS))];
    // Weight by saturation × value², squaring value so darkness suppresses a
    // pixel's claim sharply. A large dark field is technically saturated — a
    // navy backdrop reads s ≈ 0.71 — and with a linear weight its sheer area
    // beats the small bright mark sitting on it. Squaring matches how little
    // chroma the eye actually takes from a near-black region, so gold-on-navy
    // resolves to gold.
    const weight = s * v * v;
    const rad = (h * Math.PI) / 180;
    bin.weight += weight;
    bin.x += Math.cos(rad) * weight;
    bin.y += Math.sin(rad) * weight;
    bin.s += s * weight;
    bin.v += v * weight;
    bin.count++;
  }

  if (considered === 0) return null;
  if (chromatic / considered < MIN_CHROMATIC_RATIO) return null;

  const best = bins.reduce((a, b) => (b.weight > a.weight ? b : a));
  if (best.count === 0 || best.weight === 0) return null;

  let h = (Math.atan2(best.y, best.x) * 180) / Math.PI;
  if (h < 0) h += 360;
  const s = best.s / best.weight;
  const v = best.v / best.weight;

  // Lift toward the vividness the design's card blooms assume. A logo's own
  // color is often too dark or too pale to read as a glow at 13–30% opacity.
  return toHex(
    hsvToRgb({
      h,
      s: Math.max(0.55, Math.min(1, s)),
      v: Math.max(0.62, Math.min(0.95, v))
    })
  );
}

/**
 * Reduce a decoded RGBA buffer to at most `target` evenly-spaced pixels.
 *
 * A stride keeps the cost bounded and independent of upload resolution, and
 * because it steps by rows and columns rather than by flat index it can't
 * accidentally sample a single column of a wide image.
 */
export function samplePixels(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  target = 4096
): Rgba[] {
  const out: Rgba[] = [];
  if (width <= 0 || height <= 0) return out;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / target)));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (i + 3 >= data.length) continue;
      out.push({ r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] });
    }
  }
  return out;
}
