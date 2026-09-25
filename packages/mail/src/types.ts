// The mail contract every consumer (auth, forms, operators) builds against. Consumers import these with
// `import type` only, so installing mail is never a runtime dependency of a package that merely uses it.

/**
 * What a template slot may carry. The kind is the security boundary: a security notice declares only `page-link`
 * slots, and mail refuses a query or fragment there, so a credential cannot ride in a notice.
 */
export type MailSlotKind =
  /** Absolute URL on the canonical activation origin; no query, no fragment, no userinfo; at most 2048 chars. */
  | 'page-link'
  /** The same, but a query is allowed (it carries a credential); no fragment; at most 4096 chars. */
  | 'token-link'
  /** /^[A-Za-z0-9-]{4,64}$/: a one-time code. */
  | 'code'
  /** At most 8192 chars; no control characters except \n and \t (\r is refused). */
  | 'text';

export interface MailTemplate {
  /** At most 160 chars, no control characters and no {slots}: subjects are static, so a value can never reach a header. */
  readonly subject: string;
  /** Plain text, at most 16384 chars. Every {slot} in the text is declared in slots, and every declared slot appears. */
  readonly text: string;
  /** Slot names /^[A-Za-z]{1,32}$/, at most 8. */
  readonly slots: Readonly<Record<string, MailSlotKind>>;
}

/** What an extension contributes through `contributes: { mail: ... }`: English source copy. */
export interface MailContribution {
  /**
   * The contributing extension's own name, /^[a-z][a-z0-9-]{0,63}$/. mail refuses, at host composition, a namespace
   * that differs from the contributor's name core stamps (`from`), so an extension cannot contribute under another's.
   */
  readonly namespace: string;
  /** Keys /^[a-z][a-z0-9-]{0,63}$/, at most 128 per namespace. */
  readonly templates: Readonly<Record<string, MailTemplate>>;
}

export interface MailMessage {
  /** '<namespace>.<key>'. A consumer sends only templates in its own namespace (a documented rule, not enforced). */
  readonly template: string;
  /** One mailbox. */
  readonly to: string;
  /** Exactly the template's slots: none missing and none extra. */
  readonly values: Readonly<Record<string, string>>;
  /** BCP 47 tag. An invalid or unknown tag falls back to the configured default; it never throws. */
  readonly locale?: string;
  /** The caller's cancellation, combined with mail's own deadline. */
  readonly signal?: AbortSignal;
}

export type MailErrorCode =
  | 'unavailable' | 'inactive' | 'busy' | 'timeout' | 'aborted' | 'closed' | 'delivery-failed'
  | 'invalid-recipient'
  | 'unknown-template' | 'invalid-values' | 'unknown-recipient';

const statuses: Readonly<Record<MailErrorCode, 400 | 500 | 503>> = {
  unavailable: 503, inactive: 503, busy: 503, timeout: 503, aborted: 503, closed: 503, 'delivery-failed': 503,
  'invalid-recipient': 400,
  'unknown-template': 500, 'invalid-values': 500, 'unknown-recipient': 500,
};
const messages: Readonly<Record<MailErrorCode, string>> = {
  unavailable: 'Email delivery is not configured',
  inactive: 'Email delivery is not active yet',
  busy: 'Email delivery is busy',
  timeout: 'Email delivery timed out',
  aborted: 'Email delivery was aborted',
  closed: 'Email delivery is closed',
  'delivery-failed': 'Email delivery failed',
  'invalid-recipient': 'Invalid email recipient',
  'unknown-template': 'Unknown email template',
  'invalid-values': 'Invalid email template values',
  'unknown-recipient': 'Unknown mail recipient',
};
/** Only a well-formed name is ever echoed, so a caller's mistake cannot put an address or a value into a message. */
const echoable = /^[a-z][a-z0-9-]{0,63}(?:\.[a-z][a-z0-9-]{0,63})?$/;

/** A refused or failed send. The message is a fixed string per code plus the template key: never an address, never a value. */
export class MailError extends Error {
  readonly code: MailErrorCode;
  readonly status: 400 | 500 | 503;
  constructor(code: MailErrorCode, subject?: string, options?: { cause?: unknown }) {
    super(messages[code] + (subject !== undefined && echoable.test(subject) ? `: ${subject}` : ''), options);
    this.name = 'MailError';
    this.code = code;
    this.status = statuses[code];
  }
}

/** Export contract version 1: what `ctx.get('mail')` returns. */
export interface MailExports {
  readonly version: 1;
  /** True once the runtime has activated mail (it then knows the canonical origin and has loaded copy overrides). */
  readonly active: boolean;
  /**
   * Authoritative once active: false before activation, false with `transport: null`, and false when no transport
   * was given and the activation origin is not loopback on the node target.
   */
  readonly available: boolean;
  /** Whether '<namespace>.<key>' was contributed. Known at host time. */
  has(template: string): boolean;
  /** The address of an operator-named recipient (mail({recipients})). Throws MailError 'unknown-recipient'. Known at host time. */
  recipient(name: string): string;
  /** Renders and delivers one message. Resolves once the transport has accepted it. */
  send(message: MailMessage): Promise<void>;
}

export interface MailEnvelope {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** '<namespace>.<key>'. */
  readonly template: string;
  /** The locale of the copy that was rendered ('en' for the contributed source). */
  readonly locale: string;
}
export interface MailTransportContext {
  /** The route project directory (`<site>/app`). */
  readonly projectRoot: string;
  /** The site directory (host.mjs's directory). */
  readonly site: string;
  readonly target: 'node' | 'aws' | 'vercel';
}
export interface MailTransport {
  /** 'ses' | 'outbox' | 'console' | 'recording' | an operator label, /^[a-z][a-z0-9-]{0,31}$/. */
  readonly kind: string;
  /** Development transports are refused on every target except node, and need no `from`. */
  readonly development: boolean;
  /** Called at each mail activation, before any send. */
  prepare?(context: MailTransportContext): Promise<void>;
  deliver(envelope: MailEnvelope, signal: AbortSignal): Promise<void>;
  close?(): void | Promise<void>;
}

export interface SesCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
export interface SesEmailInput {
  FromEmailAddress: string;
  Destination: { ToAddresses: string[] };
  Content: { Simple: { Subject: { Data: string; Charset: 'UTF-8' }; Body: { Text: { Data: string; Charset: 'UTF-8' } } } };
}
export interface SesEmailCommand { input: SesEmailInput }
export interface SesTransportOptions {
  /** /^[a-z]{2}(?:-[a-z]+)+-\d$/ */
  region: string;
  credentials?: SesCredentials | (() => Promise<SesCredentials>);
  /** Trusted injection for tests; production uses the AWS SDK with bounded retries. */
  send?: (command: SesEmailCommand, options: { abortSignal: AbortSignal }) => Promise<unknown>;
}
