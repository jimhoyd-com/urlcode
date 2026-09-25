import { isIP } from 'node:net';
import { assert } from './errors.ts';

// Client identity for host policies. The socket peer is the truth unless the
// operator names the proxies allowed to speak for a client; then the first
// address to the left of the trusted chain in X-Forwarded-For is used, per
// the usual proxy-protocol convention and docs/RESILIENCE.md. Nothing here
// ever trusts a forwarded header from an address outside that set.

export interface Cidr { bytes: Uint8Array; prefix: number }

function toBytes(address: string): Uint8Array | undefined {
  const kind = isIP(address);
  if (kind === 4) return Uint8Array.from(address.split('.').map(Number));
  if (kind !== 6) return undefined;
  // Mapped IPv4 in IPv6 keeps its v4 identity so one CIDR list covers both.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return toBytes(mapped[1]!);
  // Any other embedded dotted quad (RFC 4291 §2.2) is two trailing groups.
  const dotted = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[2]!.split('.').map(Number);
    address = dotted[1]! + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail = ''] = address.split('::');
  const parts = head ? head.split(':') : [], rest = tail ? tail.split(':') : [];
  const groups = [...parts, ...Array(8 - parts.length - rest.length).fill('0'), ...rest].map(g => parseInt(g || '0', 16));
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => { bytes[i*2] = g >> 8; bytes[i*2+1] = g & 255; });
  return bytes;
}

export function parseCidr(text: string): Cidr {
  const [address = '', prefixText] = String(text).trim().split('/');
  const bytes = toBytes(address);
  assert(bytes, `Invalid trusted proxy address "${text}"`);
  const prefix = prefixText === undefined ? bytes.length * 8 : Number(prefixText);
  assert(Number.isInteger(prefix) && prefix >= 0 && prefix <= bytes.length * 8, `Invalid trusted proxy prefix "${text}"`);
  return { bytes, prefix };
}

export function compileTrustedProxies(list: string | string[] = []): Cidr[] {
  const entries = Array.isArray(list) ? list : String(list).split(',').map(s => s.trim()).filter(Boolean);
  assert(entries.length <= 256, 'At most 256 trusted proxy ranges');
  return entries.map(parseCidr);
}

function within(address: string, { bytes, prefix }: Cidr): boolean {
  const target = toBytes(address);
  if (!target || target.length !== bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    const bits = Math.min(8, Math.max(0, prefix - i*8));
    if (!bits) return true;
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((target[i]! & mask) !== (bytes[i]! & mask)) return false;
  }
  return true;
}

function isTrustedProxy(address: string, trusted: Cidr[]): boolean {
  return trusted.some(range => within(address, range));
}

// Walk X-Forwarded-For from the right, skipping trusted hops; the first
// untrusted address is the client. A chain made entirely of trusted proxies
// yields the leftmost entry. A malformed entry is skipped; an IPv4 entry
// with a port keeps its address.
export function resolveClient(peer: string | undefined, forwarded: string | undefined, trusted: Cidr[]): string | undefined {
  const normalized = normalizeAddress(peer);
  if (!trusted.length || !normalized || !isTrustedProxy(normalized, trusted)) return normalized;
  const hops = (forwarded || '').split(',').map(s => normalizeAddress(s.trim())).filter((hop): hop is string => hop !== undefined);
  if (!hops.length) return normalized;
  for (let i = hops.length - 1; i >= 0; i--) if (!isTrustedProxy(hops[i]!, trusted)) return hops[i];
  return hops[0];
}

export function normalizeAddress(address: unknown): string | undefined {
  if (typeof address !== 'string' || !address) return undefined;
  let value = address;
  if (value.startsWith('[')) value = value.slice(1, value.indexOf(']'));
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(value)) value = value.slice(0, value.indexOf(':'));
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) value = mapped[1]!;
  return isIP(value) ? value.toLowerCase() : undefined;
}

/** Bits of an IPv6 client address that identify one client for rate limits. */
export const clientKeyIpv6Prefix = 64;

/**
 * Rate-limit identity for a client address. An IPv4 address, including an
 * IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or its hex form), is its own key.
 * An IPv6 address is grouped by its /64 network, because one subscriber or
 * cloud host routinely holds a whole /64 and could otherwise rotate addresses
 * for fresh budgets. The key is the network prefix, e.g. `2001:db8:0:1::/64`.
 * Anything that is not an address yields undefined. packages/auth keeps an
 * equivalent function (it may not require a newer core); both are pinned to
 * test/fixtures/client-key-vectors.json.
 */
export function clientKey(address: unknown): string | undefined {
  const normalized = normalizeAddress(address);
  if (!normalized || isIP(normalized) !== 6) return normalized;
  const bytes = toBytes(normalized)!;
  if (bytes.subarray(0, 10).every(b => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return Array.from(bytes.subarray(12)).join('.');
  const groups: string[] = [];
  for (let i = 0; i < clientKeyIpv6Prefix / 8; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return `${groups.join(':')}::/${clientKeyIpv6Prefix}`;
}


/** Whether a bound socket address is loopback: 127.0.0.0/8, ::1 or an IPv4-mapped 127.x address. */
export function isLoopbackAddress(address: string): boolean {
  const bytes = toBytes(address);
  if (bytes?.length === 4) return bytes[0] === 127;
  return bytes?.length === 16 && bytes.every((byte, index) => byte === (index === 15 ? 1 : 0));
}

/**
 * The Host admission check for a server bound to a loopback address, where a
 * DNS-rebinding page can otherwise reach it as a same-origin target. Returns
 * undefined when the bound address is not loopback: such a server is not checked.
 * The returned function answers whether a request's raw headers and target may
 * proceed: exactly one Host header naming a loopback alias (or the bound
 * literal) on the bound port, or the configured public origin's authority.
 */
export function loopbackHostCheck(bound: { address: string; port: number }, origin?: string | readonly string[]): ((rawHeaders: string[], target: string) => boolean) | undefined {
  if (!isLoopbackAddress(bound.address)) return undefined;
  const allowed = new Set<string>();
  const literal = bound.address.includes(':') ? `[${bound.address.toLowerCase()}]` : bound.address;
  for (const name of ['localhost', '127.0.0.1', '[::1]', literal]) {
    allowed.add(`${name}:${bound.port}`);
    // A Host without a port means the scheme's default; the Node server speaks plain HTTP.
    if (bound.port === 80) allowed.add(name);
  }
  // The canonical origin and every operator alias origin name an authority this site is served under.
  for (const each of typeof origin === 'string' ? [origin] : origin ?? []) {
    if (!each) continue;
    const url = new URL(each);
    if (url.port) allowed.add(`${url.hostname}:${url.port}`);
    else { allowed.add(url.hostname); allowed.add(`${url.hostname}:${url.protocol === 'https:' ? 443 : 80}`); }
  }
  return (rawHeaders, target) => {
    let host: string | undefined, count = 0;
    for (let i = 0; i < rawHeaders.length; i += 2) if (rawHeaders[i]?.toLowerCase() === 'host') { count++; host = rawHeaders[i + 1]; }
    if (count !== 1 || host === undefined || !allowed.has(host.toLowerCase())) return false;
    // An absolute-form target carries its own authority, which RFC 9112 §3.2.2 says wins over Host.
    const absolute = /^https?:\/\/([^/?#]*)/i.exec(target);
    return absolute === null || allowed.has((absolute[1] ?? '').toLowerCase());
  };
}
