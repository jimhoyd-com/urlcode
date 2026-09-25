// Delivery transports. SES and the file/console development output are ported from auth's senders; the
// busy/deadline/abort handling they shared lives in mail's send pipeline (mail.ts), not here.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { MailEnvelope, MailTransport, MailTransportContext, SesEmailCommand, SesEmailInput, SesTransportOptions } from './types.ts';

interface SesModule {
  SESv2Client: new (options: { region: string; maxAttempts: number; credentials?: SesTransportOptions['credentials'] }) => { send(command: unknown, options: { abortSignal: AbortSignal }): Promise<unknown>; destroy(): void };
  SendEmailCommand: new (input: SesEmailInput) => SesEmailCommand;
}
function loadSes(): SesModule {
  try { return createRequire(import.meta.url)('@aws-sdk/client-sesv2') as SesModule; }
  catch { throw new Error('SES delivery requires the optional @aws-sdk/client-sesv2 package'); }
}

/** Amazon SES v2, plain text, one recipient, at most two SDK attempts. The optional SDK loads on first use. */
export function sesTransport(options: SesTransportOptions): MailTransport {
  if (!options || typeof options.region !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(options.region)) throw new Error('Invalid SES region');
  if (options.send !== undefined && typeof options.send !== 'function') throw new Error('SES send must be a function');
  if (options.credentials !== undefined && typeof options.credentials !== 'function' && (!options.credentials || typeof options.credentials.accessKeyId !== 'string' || typeof options.credentials.secretAccessKey !== 'string'))
    throw new Error('Invalid SES credentials');
  let sdk: SesModule | undefined, client: InstanceType<SesModule['SESv2Client']> | undefined;
  const load = (): void => {
    if (options.send || client) return;
    sdk = loadSes();
    client = new sdk.SESv2Client({ region: options.region, maxAttempts: 2, ...(options.credentials ? { credentials: options.credentials } : {}) });
  };
  return {
    kind: 'ses', development: false,
    async prepare() { load(); },
    async deliver(envelope, signal) {
      load();
      const input: SesEmailInput = { FromEmailAddress: envelope.from, Destination: { ToAddresses: [envelope.to] }, Content: { Simple: { Subject: { Data: envelope.subject, Charset: 'UTF-8' }, Body: { Text: { Data: envelope.text, Charset: 'UTF-8' } } } } };
      const command = sdk ? new sdk.SendEmailCommand(input) : { input };
      await (options.send ?? ((value, init) => client!.send(value, init)))(command, { abortSignal: signal });
    },
    close() { client?.destroy(); client = undefined; },
  };
}

const maxBytes = 32768;
function limit(value: number | undefined, fallback: number, max: number, what: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > max) throw new Error(`Invalid ${what}`);
  return result;
}
function line(envelope: MailEnvelope): string {
  const text = JSON.stringify({ development: true, template: envelope.template, to: envelope.to, from: envelope.from, subject: envelope.subject, text: envelope.text, locale: envelope.locale }) + '\n';
  if (Buffer.byteLength(text) > maxBytes) throw new Error('Development message too large');
  return text;
}
const isJson = (name: string): boolean => name.endsWith('.json');

/**
 * Development only: each message becomes one exclusive 0600 `<uuid>.json` file in an existing private directory
 * outside the project. The count is capped across restarts (existing `.json` files count).
 */
export function outboxTransport(options: { directory: string; maxMessages?: number }): MailTransport {
  if (!options || typeof options.directory !== 'string' || !isAbsolute(options.directory)) throw new Error('outboxTransport needs an absolute directory');
  const maximum = limit(options.maxMessages, 100, 1000, 'development message limit');
  let directory: string | undefined, count = 0;
  return {
    kind: 'outbox', development: true,
    async prepare(context: MailTransportContext) {
      const real = await realpath(options.directory);
      const project = await realpath(context.projectRoot);
      const rel = relative(project, real);
      if (!rel || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')))
        throw new Error('Development messages must be outside the project');
      const info = await stat(real);
      if (!info.isDirectory() || process.platform !== 'win32' && (info.mode & 0o077) !== 0)
        throw new Error('Development message directory must be private');
      count = (await readdir(real)).filter(isJson).length;
      directory = real;
    },
    async deliver(envelope, signal) {
      if (!directory) throw new Error('outboxTransport is not prepared');
      signal.throwIfAborted();
      if (count >= maximum) throw new Error('Development message limit reached');
      const text = line(envelope);
      if ((await readdir(directory)).filter(isJson).length >= maximum) throw new Error('Development message directory limit reached');
      signal.throwIfAborted();
      count++;
      const file = await open(join(directory, randomUUID() + '.json'), 'wx', 0o600);
      try { await file.writeFile(text); await file.sync(); }
      finally { await file.close(); }
    },
  };
}

/** Development only: one JSON line per message to `write` (default console.log), capped. */
export function consoleTransport(options: { write?: (line: string) => void; maxMessages?: number } = {}): MailTransport {
  if (options.write !== undefined && typeof options.write !== 'function') throw new Error('consoleTransport write must be a function');
  const maximum = limit(options.maxMessages, 100, 1000, 'development message limit'), write = options.write ?? ((text: string) => console.log(text));
  let count = 0;
  return {
    kind: 'console', development: true,
    async deliver(envelope, signal) {
      signal.throwIfAborted();
      if (count >= maximum) throw new Error('Development message limit reached');
      const text = line(envelope);
      count++;
      write(text);
    },
  };
}

/** In memory and bounded (default 100): for tests of mail's consumers. Refuses once full. */
export function recordingTransport(options: { max?: number } = {}): MailTransport & { readonly sent: readonly MailEnvelope[] } {
  const maximum = limit(options.max, 100, 10000, 'recording limit'), sent: MailEnvelope[] = [];
  return {
    kind: 'recording', development: true, sent,
    async deliver(envelope, signal) {
      signal.throwIfAborted();
      if (sent.length >= maximum) throw new Error('Recording transport is full');
      sent.push(Object.freeze({ ...envelope }));
    },
  };
}
