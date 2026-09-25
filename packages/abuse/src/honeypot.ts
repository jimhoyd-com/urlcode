// A hidden field bots fill and people do not, for extensions without a honeypot of their own.
import { AbuseError } from './types.ts';
import type { AbuseHoneypot } from './types.ts';

const FIELD = /^[a-z][A-Za-z0-9_]{0,63}$/;
const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
export const honeypot: AbuseHoneypot = Object.freeze({
  markup(field: string): string {
    if (typeof field !== 'string' || !FIELD.test(field)) throw new AbuseError(400, 'invalid_abuse_spec');
    return `<div hidden><label>Leave this field empty<input name="${escape(field)}" tabindex="-1" autocomplete="off"></label></div>`;
  },
  filled(value: unknown): boolean { return value !== undefined && value !== ''; },
});
