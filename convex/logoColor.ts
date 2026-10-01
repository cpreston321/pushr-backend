'use node';

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import jpeg from 'jpeg-js';
import { decode as decodePng } from 'fast-png';
import { dominantColor, samplePixels, type Rgba } from './lib/dominantColor';

/**
 * Derive a source app's identity color from its uploaded logo.
 *
 * The mobile UI lights each feed / apps card with the app's identity color. Without
 * this it falls back to a hash of the app id, which is right for a generated
 * monogram but contradicts real artwork — a gold-and-navy logo would sit in a
 * green card. Sampling the upload replaces the guess with the real thing.
 *
 * Failure is always non-fatal: an undecodable or monochrome logo simply leaves
 * `logoColor` unset and the client falls back to no identity bloom. A logo that
 * can't be read is not a reason to fail an upload.
 *
 * Lives in its own `"use node"` file because the decoders need the Node runtime;
 * the write-back mutation is `sourceApps.setLogoColorInternal`.
 */
export const extract = internalAction({
  args: {
    id: v.id('sourceApps'),
    storageId: v.id('_storage')
  },
  handler: async (ctx, args) => {
    let color: string | null = null;
    try {
      const blob = await ctx.storage.get(args.storageId);
      if (!blob) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const pixels = decodeToPixels(bytes);
      if (pixels) color = dominantColor(pixels);
    } catch (err) {
      // Swallow: a logo we can't read is a cosmetic loss, not an upload failure.
      console.warn(
        `logoColor: could not derive a color for ${args.id}`,
        err instanceof Error ? err.message : err
      );
      return null;
    }

    await ctx.runMutation(internal.sourceApps.setLogoColorInternal, {
      id: args.id,
      storageId: args.storageId,
      color
    });
    return null;
  }
});

/**
 * Decode to RGBA and immediately downsample. Sniffs the magic bytes rather than
 * trusting the stored content type — iOS exports have been seen mislabeled, and
 * handing a JPEG to the PNG decoder just throws.
 */
function decodeToPixels(bytes: Uint8Array): Rgba[] | null {
  if (isPng(bytes)) {
    const img = decodePng(bytes);
    // fast-png yields 8- or 16-bit samples and 1–4 channels; normalize to RGBA.
    const data = toRgba8(img.data, img.channels, img.depth, img.width * img.height);
    return samplePixels(data, img.width, img.height);
  }
  if (isJpeg(bytes)) {
    // `formatAsRGBA` keeps the 4-byte stride `samplePixels` walks.
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    return samplePixels(img.data, img.width, img.height);
  }
  // HEIC/WebP/anything else: no decoder, so leave the color unset.
  return null;
}

function isPng(b: Uint8Array): boolean {
  return (
    b.length > 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  );
}

function isJpeg(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/**
 * Normalize a PNG's samples to 8-bit RGBA. Handles greyscale, greyscale+alpha,
 * RGB and RGBA at 8- or 16-bit depth; a 16-bit sample is scaled down rather
 * than truncated so highlights don't clip.
 */
function toRgba8(
  src: ArrayLike<number>,
  channels: number,
  depth: number,
  pixelCount: number
): Uint8Array {
  const out = new Uint8Array(pixelCount * 4);
  const scale = depth === 16 ? 1 / 257 : 1;
  for (let i = 0; i < pixelCount; i++) {
    const s = i * channels;
    const d = i * 4;
    const at = (o: number) => Math.round((src[s + o] ?? 0) * scale);
    if (channels === 1) {
      const g = at(0);
      out[d] = g;
      out[d + 1] = g;
      out[d + 2] = g;
      out[d + 3] = 255;
    } else if (channels === 2) {
      const g = at(0);
      out[d] = g;
      out[d + 1] = g;
      out[d + 2] = g;
      out[d + 3] = at(1);
    } else {
      out[d] = at(0);
      out[d + 1] = at(1);
      out[d + 2] = at(2);
      out[d + 3] = channels === 4 ? at(3) : 255;
    }
  }
  return out;
}
