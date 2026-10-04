import { ConvexError } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/**
 * What a logo upload may be. The clients send PNG (web, resized to 512px) or
 * whatever the photo picker returns (JPEG, sometimes HEIC or WebP); the
 * mobile picker crops but doesn't resize, so the cap sits well above a
 * 0.8-quality JPEG of a phone photo. Never SVG or HTML: storage serves the
 * blob under the content type it was uploaded with, to anyone.
 */
export const LOGO_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif']);
export const LOGO_MAX_BYTES = 5 * 1024 * 1024;

export function isLogoBlob(blob: { contentType?: string; size: number }): boolean {
  const type = blob.contentType?.split(';')[0].trim().toLowerCase();
  return !!type && LOGO_CONTENT_TYPES.has(type) && blob.size <= LOGO_MAX_BYTES;
}

/**
 * Refuses an uploaded blob that isn't a plausible logo, or that already
 * belongs to another app or status page. A refused upload is left for
 * `cleanup.sweepStorage`: deleting it here would roll back with the throw.
 */
export async function requireLogoBlob(
  ctx: MutationCtx,
  storageId: Id<'_storage'>,
  /** The row this blob may already belong to. */
  self: { sourceApp?: Id<'sourceApps'>; statusPage?: Id<'statusPages'> } = {}
): Promise<void> {
  const blob = await ctx.db.system.get(storageId);
  if (!blob) throw new ConvexError('That upload expired. Pick the image again.');

  const apps = await ctx.db
    .query('sourceApps')
    .withIndex('by_logo', (q) => q.eq('logoStorageId', storageId))
    .take(2);
  const pages = await ctx.db
    .query('statusPages')
    .withIndex('by_logo', (q) => q.eq('logoStorageId', storageId))
    .take(2);
  if (apps.some((a) => a._id !== self.sourceApp) || pages.some((p) => p._id !== self.statusPage)) {
    throw new ConvexError('That image is already in use. Upload it again.');
  }

  if (!isLogoBlob(blob)) {
    throw new ConvexError('Logos must be a PNG, JPEG, WebP or HEIC image up to 5 MB.');
  }
}
