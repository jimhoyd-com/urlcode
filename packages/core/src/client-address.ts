import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { IPv4, IPv6 } from 'ipaddr.js';
import { assert } from './errors.ts';

// Client identity for host policies. The socket peer is the truth unless the
// operator names the proxies allowed to speak for a client; then the first
// address to the left of the trusted chain in X-Forwarded-For is used, per
// the usual proxy-protocol convention and docs/RESILIENCE.md. Nothing here
// ever trusts a forwarded header from an address outside that set.

export interface Cidr { range: IPv4 | IPv6; prefix: number }

// Node's isIP decides what an address is: ipaddr.js alone also takes forms such as `127.1` and `0x7f.0.0.1`. The
// dotted IPv4-mapped form keeps its v4 identity so one CIDR list covers both; the hex form stays IPv6. A zone ID
// (`fe80::1%eth0`) takes no part in matching. Any other embedded dotted quad is two trailing groups (RFC 4291 §2.2),
// never the IPv4-mapped address ipaddr.js makes of `::a.b.c.d`.
function parse(address: string): IPv4 | IPv6 | undefined {
  const kind = isIP(address), mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (!kind) return undefined;
  if (kind === 4 || mapped) return ipaddr.IPv4.parse(mapped ? mapped[1]! : address);
  const group = (high: string, low: string) => ((Number(high) << 8) | Number(low)).toString(16);
  return ipaddr.IPv6.parse(address.replace(/%.*$/s, '').replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, a: string, b: string, c: string, d: string) => `${group(a, b)}:${group(c, d)}`));
}

export function parseCidr(text: string): Cidr {
  const [address = '', prefixText] = String(text).trim().split('/');
  const range = parse(address);
  assert(range, `Invalid trusted proxy address "${text}"`);
  const bits = range.kind() === 'ipv4' ? 32 : 128, prefix = prefixText === undefined ? bits : Number(prefixText);
  assert(Number.isInteger(prefix) && prefix >= 0 && prefix <= bits, `Invalid trusted proxy prefix "${text}"`);
  return { range, prefix };
}

export function compileTrustedProxies(list: string | string[] = []): Cidr[] {
  const entries = Array.isArray(list) ? list : String(list).split(',').map(s => s.trim()).filter(Boolean);
  assert(entries.length <= 256, 'At most 256 trusted proxy ranges');
  return entries.map(parseCidr);
}

function within(address: string, { range, prefix }: Cidr): boolean {
  const target = parse(address);
  return target !== undefined && target.kind() === range.kind() && target.match(range, prefix);
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
 * Anything that is not an address yields undefined. Pinned to
 * test/client-key-vectors.json; the auth extension keys Better Auth's rate
 * limiter with it.
 */
export function clientKey(address: unknown): string | undefined {
  const normalized = normalizeAddress(address);
  if (!normalized || isIP(normalized) !== 6) return normalized;
  const parsed = parse(normalized) as IPv6;
  if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().toString();
  return `${parsed.parts.slice(0, clientKeyIpv6Prefix / 16).map(part => part.toString(16)).join(':')}::/${clientKeyIpv6Prefix}`;
}


/** Whether a bound socket address is loopback: 127.0.0.0/8, ::1 or an IPv4-mapped 127.x address. */
export function isLoopbackAddress(address: string): boolean {
  const parsed = parse(address);
  return parsed instanceof ipaddr.IPv4 ? parsed.octets[0] === 127 : parsed?.toNormalizedString() === '0:0:0:0:0:0:0:1';
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
