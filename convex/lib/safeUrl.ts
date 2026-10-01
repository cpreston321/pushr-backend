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

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
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
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(host);
}
