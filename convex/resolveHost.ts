'use node';

import { lookup } from 'node:dns/promises';
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { isPrivateAddress } from './lib/safeUrl';

/**
 * Whether a fetch of `host` must not go out: 'private' if any address it
 * resolves to is private, 'unresolved' if it doesn't resolve, null if every
 * address is public. The URL checks in lib/safeUrl.ts can only see the
 * name; this catches public names that point inside (127.0.0.1.nip.io).
 * A name that answers differently between this lookup and the fetch can
 * still slip through: fetch can't be pinned to the address checked here.
 */
export const privateReason = internalAction({
  args: { host: v.string() },
  returns: v.union(v.literal('private'), v.literal('unresolved'), v.null()),
  handler: async (_ctx, { host }) => {
    let addresses: { address: string }[];
    try {
      addresses = await lookup(host, { all: true, verbatim: true });
    } catch {
      return 'unresolved';
    }
    return addresses.some((a) => isPrivateAddress(a.address)) ? 'private' : null;
  }
});
