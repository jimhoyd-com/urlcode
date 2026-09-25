/**
 * Auth requires audit and mail (and uses abuse): these build the real extensions the way a host does, mail with a
 * recording transport so a test reads what auth sent. `companions` activates them for suites that call auth's
 * `activate` directly; `siteCompanions` returns unactivated registrations for suites that run a whole runtime, whose
 * project must declare them (kitYaml does).
 */
import type { TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAbuse } from '@jimhoyd/urlcode-abuse';
import type { AbuseChallengeProvider, AbuseExports } from '@jimhoyd/urlcode-abuse';
import { createAudit } from '@jimhoyd/urlcode-audit';
import type { AuditExports } from '@jimhoyd/urlcode-audit';
import { createMail, recordingTransport } from '@jimhoyd/urlcode-mail';
import type { MailEnvelope, MailExports, MailTransport } from '@jimhoyd/urlcode-mail';
import type { RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { createAuth } from '../../src/auth.ts';
import type { AuthExtensionOptions, AuthRuntime } from '../../src/auth.ts';
import { authMail } from '../../src/mail-templates.ts';
import { cleanup } from '../cleanup.ts';

export interface CompanionOptions {
    /** false: mail with `transport: null` (delivery unavailable). A transport: that transport. Default: a recording one. */
    transport?: MailTransport | false;
    /** Host abuse too, with this challenge verifier and clock. */
    abuse?: { challenge?: AbuseChallengeProvider; now?: () => number } | true;
    /** Locales mail has a copy of every auth template for (subjects prefixed `[<locale>]`), so envelopes show the locale auth asked for. */
    locales?: readonly string[];
}
export interface Companions {
    audit: AuditExports;
    mail: MailExports;
    abuse?: AbuseExports;
    /** What the recording transport delivered, oldest first. */
    sent: readonly MailEnvelope[];
    /** audit, mail (and abuse): the registrations a runtime activates before auth. */
    registrations: RuntimeExtension[];
}
/** Unactivated audit, mail (and abuse) under `root`, closed with the test. */
export async function siteCompanions(t: TestContext, root: string, projectSha256: string, options: CompanionOptions = {}): Promise<Companions> {
    const audit = await createAudit({ projectSha256, database: join(root, `audit-${randomBytes(6).toString('hex')}.sqlite`) });
    cleanup(t, () => audit.close());
    const recording = options.transport === undefined ? recordingTransport() : undefined;
    const mail = createMail({ projectSha256, site: root, contributions: [authMail], transport: options.transport === false ? null : options.transport ?? recording! });
    cleanup(t, () => mail.close());
    const registrations = [audit.registration, mail.registration];
    let abuse: AbuseExports | undefined;
    if (options.abuse) {
        const settings = options.abuse === true ? {} : options.abuse;
        const hosted = await createAbuse({ projectSha256, database: join(root, `abuse-${randomBytes(6).toString('hex')}.sqlite`), key: randomBytes(32), ...(settings.challenge ? { challenge: settings.challenge } : {}), ...(settings.now ? { now: settings.now } : {}) });
        cleanup(t, () => hosted.close());
        registrations.push(hosted.registration);
        abuse = hosted.exports;
    }
    return { audit: audit.exports, mail: mail.exports, ...(abuse ? { abuse } : {}), sent: recording?.sent ?? [], registrations };
}
/** Audit, mail (and abuse) activated for `origin`, as the runtime activates them before auth. */
export async function companions(t: TestContext, root: string, projectSha256: string, origin = 'https://example.test', options: CompanionOptions = {}): Promise<Companions> {
    const hosted = await siteCompanions(t, root, projectSha256, options), copy: Record<string, string> = {};
    for (const locale of options.locales ?? []) {
        await mkdir(join(root, 'mail', 'copy'), { recursive: true });
        await writeFile(join(root, 'mail', 'copy', locale + '.json'), JSON.stringify(Object.fromEntries(Object.entries(authMail.templates).map(([key, template]) => ['auth.' + key, { subject: `[${locale}] ${template.subject}`, text: template.text }]))));
        copy[locale] = `mail/copy/${locale}.json`;
    }
    for (const registration of hosted.registrations) {
        const instance = await registration.activate(registration.name === 'mail' && options.locales ? { copy } : {}, { origin, target: 'node', projectSha256, mounts: [], root });
        cleanup(t, () => instance.close?.());
    }
    return hosted;
}
/** Auth with activated audit and mail for `options.projectSha256`: the registration, its exports and the sent mail. */
export async function authFor(t: TestContext, root: string, options: Omit<AuthExtensionOptions, 'audit' | 'mail' | 'abuse'>, origin = 'https://example.test', companionOptions: CompanionOptions = {}): Promise<AuthRuntime & Companions> {
    const hosted = await companions(t, root, options.projectSha256, origin, companionOptions);
    return { ...hosted, ...createAuth({ ...options, audit: hosted.audit, mail: hosted.mail, ...(hosted.abuse ? { abuse: hosted.abuse } : {}) }) };
}
/** The last message sent to `to` with `template` ('auth.<key>'), or a failure naming what was sent. */
export function lastSent(sent: readonly MailEnvelope[], template: string, to?: string): MailEnvelope {
    const found = [...sent].reverse().find(envelope => envelope.template === template && (to === undefined || envelope.to === to));
    if (!found)
        throw new Error(`No ${template} message${to ? ' to ' + to : ''}; sent: ${sent.map(envelope => envelope.template + ' to ' + envelope.to).join(', ') || 'none'}`);
    return found;
}
/** The first URL in a message body. */
export function linkIn(envelope: MailEnvelope, index = 0): URL {
    const links = envelope.text.match(/https?:\/\/\S+/g) ?? [];
    if (!links[index])
        throw new Error(`No link ${index} in ${envelope.template}`);
    return new URL(links[index]!);
}
/** `authExtension(options)` for these companions: auth's registration with their audit, mail (and abuse). */
export function withCompanions(hosted: Companions): (options: Omit<AuthExtensionOptions, 'audit' | 'mail' | 'abuse'>) => RuntimeExtension {
    return options => createAuth({ ...options, audit: hosted.audit, mail: hosted.mail, ...(hosted.abuse ? { abuse: hosted.abuse } : {}) }).registration;
}
