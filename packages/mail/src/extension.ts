// The one definition of the mail extension: `urlcode extensions add mail` runs `scaffold`, and the site's host.mjs
// (`composeHost`) runs `host`. The static fields are what `npm run build:addons` writes into urlcode.json.
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import { createMail, mailAuthoring, mailConfigSchema } from './mail.ts';
import type { MailContribution, MailTransport } from './types.ts';

/** Operator choices passed in host.mjs: `mail({transport: sesTransport({region}), from, recipients})`. */
export interface MailHostOptions {
  /**
   * Delivery. Omitted: outboxTransport({directory: '<site>/data/outbox'}) when the activation origin is loopback on
   * the node target; on any other origin delivery is off (available false) until host.mjs names a transport.
   * null disables delivery everywhere: available is false and send() rejects 'unavailable'.
   */
  transport?: MailTransport | null;
  /** The mailbox messages are sent from. Required for a non-development transport; default 'no-reply@localhost'. */
  from?: string;
  /** Operator-named recipients (consumers ask by name, so YAML never holds an address). At most 32. */
  recipients?: Readonly<Record<string, string>>;
  /** Deliveries in flight across all consumers, 1..64, default 8. When full, send() rejects 'busy' at once. */
  maxConcurrent?: number;
  /** Per-message deadline in ms, 1000..30000, default 5000. */
  deadlineMs?: number;
}

function scaffold(): ScaffoldResult {
  return {
    config: {},
    routes: {},
    // Core creates new parents with mode 0700, so the outbox directory is private.
    files: [{ path: 'data/outbox/.keep', content: '', mode: 0o600 }],
    notes: [
      'On a loopback origin mail writes messages to data/outbox. On any other origin delivery is off until host.mjs passes mail({transport: sesTransport({region}), from}) or outboxTransport({directory}).',
      'Override or translate any contributed message in mail/copy/<locale>.json and list it under extensions.mail.config.copy.',
    ],
  };
}

export default defineExtension<MailHostOptions>({
  name: 'mail',
  description: 'Plain-text transactional email: templates contributed by other extensions, one operator transport.',
  requires: [],
  schema: mailConfigSchema,
  authoring: mailAuthoring,
  agent: {
    description: 'Local, revision-pinned references for agents configuring the mail extension.',
    references: [{ name: 'mail extension guide', description: 'Transports, recipients, copy files and template slot kinds.', path: 'README.md' }],
  },
  scaffold,
  host(context, options) {
    const contributions = context.contributions<MailContribution>('mail');
    const mail = createMail({ ...options, projectSha256: context.projectSha256, site: context.site, contributions });
    return { registration: mail.registration, exports: mail.exports, close: () => mail.close() };
  },
});
