// createMail(): the registration and MailExports. One transport, one global concurrency bound, a per-message
// deadline, and templates checked at host time. mail logs nothing and serves no routes.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionActivation, ExtensionAuthoringContract, ExtensionInstance, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { mailbox } from './address.ts';
import { canonicalLocale, loadCopy, render, validateContributions } from './templates.ts';
import type { Copy } from './templates.ts';
import { outboxTransport } from './transports.ts';
import { MailError } from './types.ts';
import type { MailContribution, MailEnvelope, MailExports, MailMessage, MailTransport } from './types.ts';

const LOCALE = '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$';
export const mailConfigSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    defaultLocale: { type: 'string', minLength: 2, maxLength: 35, pattern: LOCALE },
    copy: {
      type: 'object', maxProperties: 32, propertyNames: { pattern: LOCALE },
      additionalProperties: { type: 'string', maxLength: 256, pattern: '^mail/copy/[A-Za-z0-9_-]{1,64}\\.json$' },
    },
  },
} as const;

export const mailAuthoring: ExtensionAuthoringContract = {
  description: 'Every email is a template another extension contributes. Change wording or translate in mail/copy/<locale>.json; choose delivery in host.mjs. Never put secrets or addresses in YAML.',
  surfaces: [
    { kind: 'configuration', name: 'defaultLocale', description: 'The locale used when a message names none or an unknown one; the contributed English source is the last fallback.', path: 'urlcode.yaml#extensions.mail.config.defaultLocale' },
    { kind: 'copy', name: 'copy', description: 'Override or translate a contributed template by its <namespace>.<key>; keep every {slot}. List each file under extensions.mail.config.copy.', path: 'mail/copy/<locale>.json' },
    { kind: 'extension', name: 'transport', description: 'host.mjs mail({transport, from, recipients}).', path: 'host.mjs' },
  ],
  fastChecks: ['urlcode validate --project . --host-file <host.mjs> --origin <origin>', 'urlcode test --project . --host-file <host.mjs> --origin <origin>'],
};

export interface MailOptions {
  /** Exact project revision the operator reviewed (`context.projectSha256` in host()). */
  projectSha256: string;
  /** Absolute site directory: copy files and the default outbox resolve against it. */
  site: string;
  contributions: readonly MailContribution[];
  /**
   * Delivery. Omitted: an outbox in `<site>/data/outbox` when the activation origin is loopback on the node target,
   * otherwise none (available false). null: none.
   */
  transport?: MailTransport | null;
  /** The mailbox messages are sent from. Required for a non-development transport; default 'no-reply@localhost'. */
  from?: string;
  /** Operator-named recipients, names /^[a-z][a-z0-9-]{0,63}$/, at most 32. */
  recipients?: Readonly<Record<string, string>>;
  /** Deliveries in flight across all consumers, 1..64, default 8. When full, send() rejects 'busy' at once. */
  maxConcurrent?: number;
  /** Per-message deadline in ms, 1000..30000, default 5000. */
  deadlineMs?: number;
}

interface MailConfig { defaultLocale?: string; copy?: Record<string, string> }
interface Activation { origin: string; transport: MailTransport | undefined; copy: Copy; defaultLocale: string; generation: number }

const RECIPIENT = /^[a-z][a-z0-9-]{0,63}$/;
function bounded(value: number | undefined, fallback: number, min: number, max: number, what: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`mail ${what} must be an integer from ${min} to ${max}`);
  return result;
}
/** http(s) loopback: localhost, 127.0.0.0/8 or ::1. */
export function isLoopbackOrigin(origin: URL): boolean {
  return origin.hostname === 'localhost' || origin.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(origin.hostname);
}

export function createMail(options: MailOptions): { registration: RuntimeExtension; exports: MailExports; close(): Promise<void> } {
  if (!options || !/^[a-f0-9]{64}$/.test(options.projectSha256)) throw new Error('mail extension requires an explicit operator revision pin');
  if (typeof options.site !== 'string' || !options.site) throw new Error('mail needs the site directory');
  if (!Array.isArray(options.contributions)) throw new Error('mail contributions must be a list');
  const templates = validateContributions(options.contributions);
  const configured = options.transport;
  if (configured !== undefined && configured !== null) {
    if (!configured || typeof configured !== 'object' || typeof configured.kind !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(configured.kind)
      || typeof configured.development !== 'boolean' || typeof configured.deliver !== 'function'
      || configured.prepare !== undefined && typeof configured.prepare !== 'function' || configured.close !== undefined && typeof configured.close !== 'function')
      throw new Error('mail transport needs a kind, a development flag and a deliver function');
    if (!configured.development && options.from === undefined) throw new Error('mail needs from for a non-development transport');
  }
  const sender = options.from === undefined ? 'no-reply@localhost' : mailbox(options.from);
  if (!sender) throw new Error('mail from must be one plain mailbox');
  const from: string = sender;
  const recipients = new Map<string, string>();
  if (options.recipients !== undefined) {
    if (!options.recipients || typeof options.recipients !== 'object' || Array.isArray(options.recipients)) throw new Error('mail recipients must map names to addresses');
    const entries = Object.entries(options.recipients);
    if (entries.length > 32) throw new Error('mail names at most 32 recipients');
    for (const [name, address] of entries) {
      if (!RECIPIENT.test(name)) throw new Error(`mail recipient names must match ${RECIPIENT.source}`);
      const normalized = mailbox(address);
      if (!normalized) throw new Error(`mail recipient ${name} is not one plain mailbox`);
      recipients.set(name, normalized);
    }
  }
  const maxConcurrent = bounded(options.maxConcurrent, 8, 1, 64, 'maxConcurrent');
  const deadlineMs = bounded(options.deadlineMs, 5000, 1000, 30000, 'deadlineMs');

  let activation: Activation | undefined, generation = 0, closed = false, inFlight = 0;
  /** One stop function per delivery in flight, so close() can end each with 'closed'. */
  const stoppers = new Set<(why: 'closed') => void>();
  let defaultTransport: MailTransport | undefined;

  async function send(message: MailMessage): Promise<void> {
    if (closed) throw new MailError('closed');
    if (configured === null || activation && !activation.transport) throw new MailError('unavailable');
    if (!activation) throw new MailError('inactive');
    const current = activation, transport = current.transport!;
    const name = message && typeof message === 'object' ? message.template : undefined;
    const source = typeof name === 'string' ? templates.get(name) : undefined;
    if (!source) throw new MailError('unknown-template', typeof name === 'string' ? name : undefined);
    const template = name as string;
    const to = mailbox(message.to);
    if (!to) throw new MailError('invalid-recipient', template);
    const rendered = render(template, source, current.copy, current.defaultLocale, message.values, message.locale, current.origin);
    if (inFlight >= maxConcurrent) throw new MailError('busy', template);
    const signal = message.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new MailError('aborted', template);
    if (signal?.aborted) throw new MailError('aborted', template);
    const envelope: MailEnvelope = Object.freeze({ from, to, subject: rendered.subject, text: rendered.text, template, locale: rendered.locale });
    inFlight++;
    const controller = new AbortController();
    let reason: 'timeout' | 'aborted' | 'closed' | undefined, rejectStop: (error: MailError) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    const stop = (why: 'timeout' | 'aborted' | 'closed'): void => {
      if (reason) return;
      reason = why;
      controller.abort();
      rejectStop(new MailError(why, template));
    };
    const onAbort = (): void => stop('aborted'), timer = setTimeout(() => stop('timeout'), deadlineMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    stoppers.add(stop);
    const delivering = Promise.resolve().then(() => transport.deliver(envelope, controller.signal));
    // The slot is held until the transport settles, not until the caller is answered: a transport that ignores the
    // abort signal keeps its delivery counted, so maxConcurrent bounds the work actually running.
    const release = (): void => { inFlight--; };
    void delivering.then(release, release);
    try {
      await Promise.race([
        delivering.catch((cause: unknown) => {
          throw reason ? new MailError(reason, template) : new MailError('delivery-failed', template, { cause });
        }),
        stopped,
      ]);
    }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      stoppers.delete(stop);
    }
  }

  const exports: MailExports = Object.freeze({
    version: 1 as const,
    get active() { return !closed && activation !== undefined; },
    get available() { return !closed && activation !== undefined && activation.transport !== undefined; },
    has(template: string) { return typeof template === 'string' && templates.has(template); },
    recipient(name: string) {
      const address = typeof name === 'string' ? recipients.get(name) : undefined;
      if (address === undefined) throw new MailError('unknown-recipient', typeof name === 'string' ? name : undefined);
      return address;
    },
    send,
  });

  const abortAll = (): void => { for (const stop of [...stoppers]) stop('closed'); };

  const registration: RuntimeExtension = {
    name: 'mail', version: '1', projectSha256: options.projectSha256, targets: ['node', 'aws', 'vercel'],
    schema: mailConfigSchema, authoring: mailAuthoring,
    async activate(raw, context: ExtensionActivation): Promise<ExtensionInstance> {
      if (closed) throw new Error('mail is closed');
      if (context.mounts.length > 0) throw new Error('mail serves no routes; remove the routes with extension: mail');
      const origin = new URL(context.origin);
      if (origin.origin !== context.origin || origin.username || origin.password || !(origin.protocol === 'https:' || origin.protocol === 'http:' && isLoopbackOrigin(origin)))
        throw new Error('mail requires a canonical HTTPS origin (http only on loopback)');
      const target = context.target;
      if (target !== 'node' && target !== 'aws' && target !== 'vercel') throw new Error(`mail refuses target ${target}`);
      let transport: MailTransport | undefined;
      if (configured) {
        if (configured.development && target !== 'node') throw new Error(`mail development transport ${configured.kind} refuses target ${target}; pass sesTransport in host.mjs`);
        transport = configured;
      }
      else if (configured === undefined && target === 'node' && isLoopbackOrigin(origin)) {
        const directory = join(options.site, 'data', 'outbox');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        transport = defaultTransport ??= outboxTransport({ directory });
      }
      await transport?.prepare?.({ projectRoot: context.root, site: options.site, target });
      const config = raw as MailConfig;
      const defaultLocale = config.defaultLocale === undefined ? 'en' : canonicalLocale(config.defaultLocale);
      if (!defaultLocale) throw new Error('mail defaultLocale is not a language tag');
      const copy = await loadCopy(options.site, config.copy ?? {}, templates);
      const mine = ++generation;
      activation = { origin: origin.origin, transport, copy, defaultLocale, generation: mine };
      return {
        handle() { return { status: 404, headers: [['content-type', 'text/plain; charset=utf-8']], body: 'Not found' }; },
        close() { if (activation?.generation === mine) { activation = undefined; abortAll(); } },
      };
    },
  };

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    closed = true;
    activation = undefined;
    abortAll();
    const transports = new Set([configured ?? undefined, defaultTransport].filter((value): value is MailTransport => !!value));
    for (const transport of transports) await transport.close?.();
  })();

  return { registration, exports, close };
}
