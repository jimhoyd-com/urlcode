// Contributed templates, site copy overrides and rendering. Generalized from auth's email copy to
// '<namespace>.<key>' templates whose slots carry a kind mail enforces.
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MailError } from './types.ts';
import type { MailSlotKind, MailTemplate } from './types.ts';

const NAME = /^[a-z][a-z0-9-]{0,63}$/, SLOT = /^[A-Za-z]{1,32}$/, KINDS: readonly MailSlotKind[] = ['page-link', 'token-link', 'code', 'text'];
const limits = { templates: 128, slots: 8, subject: 160, text: 16384, value: 8192, pageLink: 2048, tokenLink: 4096, copyBytes: 65536, copyChars: 65536, locales: 32 };
const placeholder = /\{([A-Za-z]+)\}/g;
/** Subjects: no control character at all. Text: \n and \t only (\r is refused, so the body has one line ending). */
const subjectControls = /[\x00-\x1f\x7f-\x9f]/, textControls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const code = /^[A-Za-z0-9-]{4,64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const slotsOf = (text: string): string[] => [...new Set([...text.matchAll(placeholder)].map(match => match[1]!))].sort();
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

function copyText(subject: unknown, text: unknown, where: string): { subject: string; text: string } {
  if (typeof subject !== 'string' || !subject || subject.length > limits.subject || subjectControls.test(subject) || slotsOf(subject).length)
    throw new Error(`${where}: the subject must be 1-${limits.subject} characters with no control characters and no {slots}`);
  if (typeof text !== 'string' || !text || text.length > limits.text || textControls.test(text))
    throw new Error(`${where}: the text must be 1-${limits.text} characters with no control characters except newline and tab`);
  return { subject, text };
}

/**
 * Validates every contribution and returns the templates by '<namespace>.<key>'. Throws naming the namespace or key.
 * Each entry is `{from, value}` as `HostContext.contributions` returns it: `from` is the contributing extension's name,
 * stamped by core, and the value's `namespace` must equal it, so no extension can contribute under another's name.
 */
export function validateContributions(contributions: readonly unknown[]): ReadonlyMap<string, MailTemplate> {
  const templates = new Map<string, MailTemplate>(), namespaces = new Set<string>();
  for (const entry of contributions) {
    if (!isRecord(entry) || typeof entry.from !== 'string' || !NAME.test(entry.from))
      throw new Error('A mail contribution must be {from, value} with the contributing extension\'s name in from');
    const from = entry.from, contribution = entry.value;
    if (!isRecord(contribution) || typeof contribution.namespace !== 'string' || !NAME.test(contribution.namespace))
      throw new Error(`The mail contribution from extension "${from}" needs a namespace matching ${NAME.source}`);
    const namespace = contribution.namespace;
    if (namespace !== from)
      throw new Error(`Mail namespace "${namespace}" is contributed by extension "${from}": an extension contributes mail templates only under its own name`);
    if (namespaces.has(namespace)) throw new Error(`Two extensions contribute mail namespace ${namespace}`);
    namespaces.add(namespace);
    const entries = isRecord(contribution.templates) ? Object.entries(contribution.templates) : undefined;
    if (!entries || entries.length === 0 || entries.length > limits.templates) throw new Error(`Mail namespace ${namespace} needs 1-${limits.templates} templates`);
    for (const [key, template] of entries) {
      const where = `Mail template ${namespace}.${NAME.test(key) ? key : '?'}`;
      if (!NAME.test(key)) throw new Error(`${where}: template keys must match ${NAME.source}`);
      if (!isRecord(template) || !isRecord(template.slots)) throw new Error(`${where} needs subject, text and slots`);
      const { subject, text } = copyText(template.subject, template.text, where);
      const slots = Object.entries(template.slots);
      if (slots.length > limits.slots) throw new Error(`${where}: at most ${limits.slots} slots`);
      for (const [slot, kind] of slots)
        if (!SLOT.test(slot) || !KINDS.includes(kind as MailSlotKind)) throw new Error(`${where}: slot ${SLOT.test(slot) ? slot : '?'} needs a name matching ${SLOT.source} and a kind of ${KINDS.join(', ')}`);
      if (!same(slotsOf(text), slots.map(([slot]) => slot).sort())) throw new Error(`${where}: the {slots} in its text must be exactly its declared slots`);
      templates.set(`${namespace}.${key}`, Object.freeze({ subject, text, slots: Object.freeze(Object.fromEntries(slots)) as Readonly<Record<string, MailSlotKind>> }));
    }
  }
  return templates;
}

/** Canonical BCP 47 tag, or undefined. */
export function canonicalLocale(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 64) return undefined;
  try { return Intl.getCanonicalLocales(value)[0]; } catch { return undefined; }
}

export type Copy = ReadonlyMap<string, ReadonlyMap<string, { subject: string; text: string }>>;

/** Reads `extensions.mail.config.copy`: site-relative JSON files, bounded, keyed by contributed templates, keeping every slot. */
export async function loadCopy(site: string, files: Readonly<Record<string, string>>, templates: ReadonlyMap<string, MailTemplate>): Promise<Copy> {
  const copy = new Map<string, Map<string, { subject: string; text: string }>>();
  const entries = Object.entries(files);
  if (entries.length > limits.locales) throw new Error(`mail copy names at most ${limits.locales} locales`);
  const root = await realpath(site);
  for (const [raw, file] of entries) {
    const locale = canonicalLocale(raw);
    if (!locale) throw new Error(`mail copy locale ${JSON.stringify(raw)} is not a language tag`);
    if (copy.has(locale)) throw new Error(`mail copy names locale ${locale} twice`);
    if (typeof file !== 'string' || !/^mail\/copy\/[A-Za-z0-9_-]{1,64}\.json$/.test(file)) throw new Error(`mail copy ${locale} must be mail/copy/<name>.json`);
    let path: string;
    try { path = await realpath(resolve(root, file)); } catch { throw new Error(`mail copy file ${file} does not exist`); }
    const rel = relative(root, path);
    if (!rel || isAbsolute(rel) || rel.split(sep).includes('..')) throw new Error(`mail copy file ${file} must stay inside the site`);
    const info = await stat(path);
    if (!info.isFile() || info.size > limits.copyBytes) throw new Error(`mail copy file ${file} must be a file of at most ${limits.copyBytes} bytes`);
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error(`mail copy file ${file} is not JSON`); }
    if (!isRecord(parsed)) throw new Error(`mail copy file ${file} must be an object of "<namespace>.<key>": {subject, text}`);
    const catalogue = new Map<string, { subject: string; text: string }>();
    let total = 0;
    for (const [key, value] of Object.entries(parsed)) {
      const source = templates.get(key);
      if (!source) throw new Error(`mail copy file ${file}: ${/^[a-z][a-z0-9-]{0,63}\.[a-z][a-z0-9-]{0,63}$/.test(key) ? key : 'a key'} is not a contributed template`);
      if (!isRecord(value)) throw new Error(`mail copy file ${file}: ${key} needs subject and text`);
      const entry = copyText(value.subject, value.text, `mail copy file ${file}: ${key}`);
      if (!same(slotsOf(entry.text), slotsOf(source.text))) throw new Error(`mail copy file ${file}: ${key} must keep exactly the {slots} ${slotsOf(source.text).map(slot => `{${slot}}`).join(' ') || '(none)'}`);
      total += entry.subject.length + entry.text.length;
      if (total > limits.copyChars) throw new Error(`mail copy file ${file} holds more than ${limits.copyChars} characters`);
      catalogue.set(key, Object.freeze(entry));
    }
    copy.set(locale, catalogue);
  }
  return copy;
}

function valueFits(kind: MailSlotKind, value: string, origin: string): boolean {
  if (kind === 'code') return code.test(value);
  if (kind === 'text') return value.length <= limits.value && !textControls.test(value);
  if (value.length > (kind === 'page-link' ? limits.pageLink : limits.tokenLink)) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  // The canonical serialization only: the URL parser drops tabs and newlines, so a non-canonical value could smuggle
  // a line into the body while its parsed form looked harmless.
  return url.href === value && url.origin === origin && !url.username && !url.password && !value.includes('#')
    && (kind === 'token-link' || !value.includes('?'));
}

/** Picks the copy (exact tag, base language, default locale, English source), checks every value and renders. */
export function render(template: string, source: MailTemplate, copy: Copy, defaultLocale: string, values: unknown, requested: string | undefined, origin: string): { subject: string; text: string; locale: string } {
  const slots = Object.keys(source.slots).sort();
  if (!isRecord(values) || !same(Object.keys(values).sort(), slots)) throw new MailError('invalid-values', template);
  for (const slot of slots) {
    const value = values[slot];
    if (typeof value !== 'string' || !valueFits(source.slots[slot]!, value, origin)) throw new MailError('invalid-values', template);
  }
  const locale = canonicalLocale(requested) ?? defaultLocale;
  let chosen: { subject: string; text: string } = source, used = 'en';
  for (const candidate of [locale, locale.split('-')[0]!, defaultLocale]) {
    const entry = copy.get(candidate)?.get(template);
    if (entry) { chosen = entry; used = candidate; break; }
  }
  const text = chosen.text.replace(placeholder, (_match, name: string) => values[name] as string);
  if (text.length > limits.text) throw new MailError('invalid-values', template);
  return { subject: chosen.subject, text, locale: used };
}
