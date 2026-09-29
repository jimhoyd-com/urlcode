// The standard string formats a request body schema or a parameter schema may name besides `uuid` (#861, #881). They are URLCode's own small
// checks rather than a format library: each one refuses a value longer than its cap before any regex runs, every
// regex it uses passes the same admission guard as an author's `pattern` (pattern-guard.ts), and the rest is a
// linear scan. The Cloudflare build cannot import this module into its generated validators, so
// `bodySchemaFormatChecks` is self-contained: it names nothing outside its own body, and build-cloudflare.ts
// inlines its source text into the standalone module, the same way it inlines Ajv's runtime helpers.

/** The longest value each format accepts; a longer string fails the format without being scanned. */
export const bodySchemaFormatMaxLength = {
  uuid: 36, date: 10, time: 24, 'date-time': 35, email: 254, uri: 2048, hostname: 253, ipv4: 15, ipv6: 45,
} as const;
export type BodySchemaFormat = keyof typeof bodySchemaFormatMaxLength;

/**
 * Builds the format checks (every format except `uuid`, which stays a RegExp) and the regexes they use. The caps
 * repeat `bodySchemaFormatMaxLength` because this function may not reference anything outside itself; a test
 * asserts the two agree.
 */
export function bodySchemaFormatChecks() {
  const patterns = {
    date: /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/,
    time: /^([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,9})?([Zz]|([+-])([0-9]{2}):([0-9]{2}))$/,
    octet: /^(0|[1-9][0-9]{0,2})$/,
    group: /^[0-9A-Fa-f]{1,4}$/,
    label: /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/,
    atom: /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]{1,64}$/,
    scheme: /^[A-Za-z][A-Za-z0-9+.-]{0,63}$/,
    percent: /%[0-9A-Fa-f]{2}/g,
    userinfo: /^[A-Za-z0-9._~!$&'()*+,;=:-]*$/,
    regName: /^[A-Za-z0-9._~!$&'()*+,;=-]*$/,
    port: /^[0-9]{0,5}$/,
    future: /^[Vv][0-9A-Fa-f]{1,8}\.[A-Za-z0-9._~!$&'()*+,;=:-]{1,40}$/,
    path: /^[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/,
    tail: /^[A-Za-z0-9._~!$&'()*+,;=:@/?-]*$/,
  };
  const days = (year: number, month: number): number => month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  const date = (value: string): boolean => {
    if (value.length > 10) return false;
    const m = patterns.date.exec(value);
    if (!m) return false;
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    return month >= 1 && month <= 12 && day >= 1 && day <= days(year, month);
  };
  // RFC 3339 full-time: the offset is required. A leap second (:60) is accepted only when the time is 23:59 in UTC;
  // the date is not checked against the leap-second table.
  const time = (value: string): boolean => {
    if (value.length > 24) return false;
    const m = patterns.time.exec(value);
    if (!m) return false;
    const hour = Number(m[1]), minute = Number(m[2]), second = Number(m[3]);
    const sign = m[6] === '-' ? -1 : 1, offsetHour = Number(m[7] ?? 0), offsetMinute = Number(m[8] ?? 0);
    if (hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) return false;
    if (second < 60) return true;
    const utc = ((hour * 60 + minute - sign * (offsetHour * 60 + offsetMinute)) % 1440 + 1440) % 1440;
    return utc === 23 * 60 + 59;
  };
  const dateTime = (value: string): boolean => {
    if (value.length > 35) return false;
    return (value[10] === 'T' || value[10] === 't') && date(value.slice(0, 10)) && time(value.slice(11));
  };
  const ipv4 = (value: string): boolean => {
    if (value.length > 15) return false;
    const parts = value.split('.');
    return parts.length === 4 && parts.every(part => patterns.octet.test(part) && Number(part) <= 255);
  };
  // RFC 4291 text forms: eight groups, one `::` for a run of zeros, an optional dotted IPv4 tail; no zone id.
  const ipv6 = (value: string): boolean => {
    if (value.length > 45) return false;
    let text = value;
    if (value.includes('.')) {
      const colon = value.lastIndexOf(':');
      if (colon < 0 || !ipv4(value.slice(colon + 1))) return false;
      text = value.slice(0, colon + 1) + '0:0';
    }
    const halves = text.split('::');
    if (halves.length > 2) return false;
    const count = (half: string): number => {
      if (half === '') return 0;
      const groups = half.split(':');
      return groups.every(group => patterns.group.test(group)) ? groups.length : NaN;
    };
    const left = count(halves[0]!), right = halves.length === 2 ? count(halves[1]!) : 0;
    return halves.length === 2 ? left + right <= 7 : left === 8;
  };
  // RFC 1123 host names: LDH labels of 1 to 63, at most 253 in all, an optional trailing dot. A label with `--` in
  // positions 3 and 4 must be an `xn--` A-label; its Punycode is not decoded.
  const labels = (value: string, trailingDot: boolean): boolean => {
    const name = trailingDot && value.endsWith('.') ? value.slice(0, -1) : value;
    if (name.length < 1 || name.length > 253) return false;
    return name.split('.').every(label => patterns.label.test(label) && (label.slice(2, 4) !== '--' || label.slice(0, 2).toLowerCase() === 'xn'));
  };
  const hostname = (value: string): boolean => value.length <= 253 && labels(value, true);
  // RFC 5321 Mailbox: a dot-atom or quoted local part of at most 64, then a host name or an address literal.
  const email = (value: string): boolean => {
    if (value.length > 254) return false;
    const at = value.lastIndexOf('@');
    if (at < 1) return false;
    const local = value.slice(0, at), domain = value.slice(at + 1);
    if (local.length > 64) return false;
    if (local.startsWith('"')) {
      if (local.length < 2 || !local.endsWith('"')) return false;
      for (let i = 1; i < local.length - 1; i++) {
        const code = local.charCodeAt(i);
        if (code === 92) { const next = local.charCodeAt(++i); if (i >= local.length - 1 || next < 32 || next > 126) return false; }
        else if (code < 32 || code > 126 || code === 34) return false;
      }
    } else if (!local.split('.').every(atom => patterns.atom.test(atom))) return false;
    if (domain.startsWith('[') && domain.endsWith(']')) {
      const literal = domain.slice(1, -1);
      return literal.slice(0, 5).toLowerCase() === 'ipv6:' ? ipv6(literal.slice(5)) : ipv4(literal);
    }
    return labels(domain, false);
  };
  // RFC 3986 URI (absolute, a fragment allowed), ASCII only: a scheme, then each component checked against its own
  // characters, with every `%` followed by two hex digits.
  const uri = (value: string): boolean => {
    if (value.length > 2048) return false;
    const colon = value.indexOf(':');
    if (colon < 1 || !patterns.scheme.test(value.slice(0, colon))) return false;
    const plain = (part: string, allowed: RegExp): boolean => allowed.test(part.replace(patterns.percent, '')) && !part.replace(patterns.percent, '').includes('%');
    let rest = value.slice(colon + 1);
    const hash = rest.indexOf('#');
    if (hash >= 0) { if (!plain(rest.slice(hash + 1), patterns.tail)) return false; rest = rest.slice(0, hash); }
    const question = rest.indexOf('?');
    if (question >= 0) { if (!plain(rest.slice(question + 1), patterns.tail)) return false; rest = rest.slice(0, question); }
    if (rest.startsWith('//')) {
      const slash = rest.indexOf('/', 2);
      let authority = slash < 0 ? rest.slice(2) : rest.slice(2, slash);
      rest = slash < 0 ? '' : rest.slice(slash);
      const atSign = authority.lastIndexOf('@');
      if (atSign >= 0) { if (!plain(authority.slice(0, atSign), patterns.userinfo)) return false; authority = authority.slice(atSign + 1); }
      let port = '';
      if (authority.startsWith('[')) {
        const close = authority.indexOf(']');
        if (close < 0) return false;
        const literal = authority.slice(1, close), after = authority.slice(close + 1);
        if (!(ipv6(literal) || patterns.future.test(literal))) return false;
        if (after !== '' && !after.startsWith(':')) return false;
        port = after.slice(1);
      } else {
        const portAt = authority.lastIndexOf(':');
        if (portAt >= 0) { port = authority.slice(portAt + 1); authority = authority.slice(0, portAt); }
        if (!plain(authority, patterns.regName)) return false;
      }
      if (!patterns.port.test(port)) return false;
    }
    return plain(rest, patterns.path);
  };
  return { formats: { date, time, 'date-time': dateTime, email, uri, hostname, ipv4, ipv6 }, patterns };
}
