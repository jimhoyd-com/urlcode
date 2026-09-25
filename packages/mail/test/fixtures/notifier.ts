// A synthetic consumer of mail, shaped like a real one (forms notify): it contributes one template through
// `contributes.mail`, reads MailExports through `ctx.get('mail')` with type-only imports, and sends to an
// operator-named recipient when its mount receives a POST.
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { HandlerResult, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import type { MailContribution, MailExports } from '../../src/index.ts';

export const notifierMail: MailContribution = {
  namespace: 'notifier',
  templates: { ping: { subject: 'Ping received', text: 'Someone pinged {page}.\n\nNote: {note}', slots: { page: 'page-link', note: 'text' } } },
};
const schema = { type: 'object', additionalProperties: false, properties: {} } as const;
const text = (status: number, body: string): HandlerResult => ({ status, headers: [['content-type', 'text/plain; charset=utf-8']], body });

export default defineExtension<Record<string, never>>({
  name: 'notifier',
  description: 'Test fixture: sends one contributed template through mail.',
  requires: ['mail'],
  contributes: { mail: notifierMail },
  schema,
  host(context) {
    const mail = context.get<MailExports>('mail');
    const registration: RuntimeExtension = {
      name: 'notifier', version: '1', projectSha256: context.projectSha256, targets: ['node'], schema,
      activate(_config, activation) {
        if (!mail.has('notifier.ping')) throw new Error('notifier needs its mail template');
        const to = mail.recipient('ops');
        return {
          async handle(request) {
            if (request.method !== 'POST') return { status: 405, headers: [['allow', 'POST']], body: 'Method not allowed' };
            if (!mail.available) return text(503, 'Email delivery is not configured');
            try {
              await mail.send({ template: 'notifier.ping', to, values: { page: new URL(request.path, activation.origin).href, note: new TextDecoder().decode(request.body) } });
            } catch (error) { return text((error as { status?: number }).status ?? 500, 'Could not notify'); }
            return text(202, 'Notified');
          },
        };
      },
    };
    return { registration };
  },
});
