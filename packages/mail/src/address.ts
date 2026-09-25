// Recipient and sender mailbox validation. Deliberately independent of auth's normalizeEmail: mail refuses anything
// that could split a header or name a second mailbox, and lower-cases only the domain.
const forbidden = /[\s\x00-\x1f\x7f-\x9f,;<>()[\]"\\]/;
const label = /^[^.]+$/;

/** The normalized mailbox (domain lower-cased), or undefined when it is not one plain address. */
export function mailbox(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 320 || forbidden.test(value)) return undefined;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return undefined;
  const local = value.slice(0, at), domain = value.slice(at + 1).toLowerCase();
  if (domain !== 'localhost' && (!domain.includes('.') || !domain.split('.').every(part => label.test(part)))) return undefined;
  return `${local}@${domain}`;
}
