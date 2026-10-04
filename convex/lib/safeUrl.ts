/**
 * Reject callback URLs that point anywhere but the public internet. Callbacks
 * are fired by pushr's servers on behalf of whoever holds a source-app token,
 * so without this a token holder could make pushr call internal addresses.
 *
 * This checks the URL as written: scheme, hostname and literal IPs. It can't
 * see what a public hostname resolves to (the default Convex runtime has no
 * DNS), which is why callers must also refuse to follow redirects.
 */
export function unsafeCallbackReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'callbackUrl is not a valid URL';
  }
  if (url.protocol !== 'https:') return 'callbackUrl must use https';
  if (url.username || url.password) return 'callbackUrl must not contain credentials';

  // A trailing dot names the same host ("localhost." is localhost), so it's
  // dropped before the name checks.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (
    // A name with no dot isn't on the public internet; it's a LAN or cluster name.
    (!host.includes('.') && !host.includes(':')) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    return 'callbackUrl must be a public host';
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return 'callbackUrl must be a public host';
  return null;
}

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && Number(m[3]) === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  if (!host.includes(':')) return false;
  if (host === '::' || host === '::1') return true;
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  // WHATWG URL normalizes ::ffff:10.0.0.1 to ::ffff:a00:1.
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // Unique-local, link-local and site-local; then the forms that carry an IPv4
  // address inside (NAT64 64:ff9b::/96, 6to4 2002::/16, IPv4-compatible ::/96).
  return /^(fc|fd|fe[89ab]|fe[c-f])/.test(host) || /^(64:ff9b::|2002:|::[0-9a-f])/.test(host);
}

/**
 * The same guard for URLs an uptime check fetches, which may also be plain
 * http. The check doesn't follow redirects, for the reason above.
 */
export function unsafeMonitorUrlReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'url is not a valid URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'url must use http or https';
  if (url.username || url.password) return 'url must not contain credentials';
  const asHttps = new URL(raw);
  asHttps.protocol = 'https:';
  const reason = unsafeCallbackReason(asHttps.toString());
  return reason ? reason.replace('callbackUrl', 'url') : null;
}

/** Whether a resolved IP address is private, loopback, link-local or reserved. */
export function isPrivateAddress(ip: string): boolean {
  const host = ip.toLowerCase().replace(/^\[|\]$/g, '');
  return host.includes(':') ? isPrivateIpv6(host) : isPrivateIpv4(host);
}

/** The hostname a fetch of `raw` would resolve, or null for a literal IP or a bad URL. */
export function hostToResolve(raw: string): string | null {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}
