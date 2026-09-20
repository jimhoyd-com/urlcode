import type { AdminAccountDelivery } from './admin-account-operations.ts';
import { createEmailCopy } from './email-copy.ts';
import type { EmailCopy, EmailTemplateKey } from './email-copy.ts';
import type { ManualRecoveryDelivery } from './manual-recovery.ts';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { open, realpath, stat, readdir } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { normalizeEmail } from './auth-core.ts';
export interface TokenMessage {
    email: string;
    token: string;
    purpose: 'verify-email' | 'reset-password' | 'cancel-deletion' | 'invitation' | 'verify-email-change' | 'cancel-email-change';
    signal: AbortSignal;
    locale?: string;
}
export interface EmailCodeMessage {
    email: string;
    flowId: string;
    code: string;
    signal: AbortSignal;
    locale?: string;
}
export interface SignupCodeMessage {
    email: string;
    code: string;
    signal: AbortSignal;
    locale?: string;
}
export interface FactorRecoveryMessage {
    email: string;
    verificationToken: string;
    cancelToken: string;
    signal: AbortSignal;
    locale?: string;
}
export type TokenSender = (message: TokenMessage) => Promise<void>;
export interface SecurityNotice {
    email: string;
    event: 'new-device' | 'password-changed' | 'email-changed' | 'registration-attempt';
    signal: AbortSignal;
    locale?: string;
}
/** A callable sendToken adapter; notify carries no credential or arbitrary markup. */
export interface EmailSender extends TokenSender {
    sendEmailCode(message: EmailCodeMessage): Promise<void>;
    sendSignupCode(message: SignupCodeMessage): Promise<void>;
    sendFactorRecovery(message: FactorRecoveryMessage): Promise<void>;
    sendManualRecovery(message: ManualRecoveryDelivery & { locale?: string }): Promise<void>;
    notify(message: SecurityNotice): Promise<void>;
    sendAccountAdministration(message: AdminAccountDelivery & { signal: AbortSignal; locale?: string }): Promise<void>;
    close(): void;
}
interface Delivery {
    email: string;
    subject: string;
    text: string;
}
interface SenderLocation {
    origin: string;
    authMount: string;
    emailCopy?: EmailCopy;
}
const events = { 'registration-attempt': 'Someone tried to create an account with your email address. Your existing account was not changed.', 'new-device': 'A new device signed in to your account.', 'password-changed': 'Your account password changed.', 'email-changed': 'Your account email address changed.' } as const;
function location(options: SenderLocation, development = false): {
    origin: string;
    mount: string;
    emailCopy: EmailCopy;
} {
    const origin = new URL(options.origin);
    if (origin.origin !== options.origin || origin.username || origin.password || !(origin.protocol === 'https:' || development && origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))
        throw new Error('Sender requires a canonical HTTPS origin');
    if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(options.authMount) || options.authMount.length > 256)
        throw new Error('Sender requires an explicit auth mount');
    return { origin: origin.origin, mount: options.authMount, emailCopy: options.emailCopy ?? createEmailCopy() };
}
function sender(where: {
    origin: string;
    mount: string;
    emailCopy: EmailCopy;
}, deliver: (message: Delivery, signal: AbortSignal) => Promise<void>, cleanup = () => { }): EmailSender {
    let closed = false, active = 0;
    async function send(message: Delivery, signal: AbortSignal) {
        if (closed)
            throw new Error('Sender is closed');
        if (active >= 4)
            throw new Error('Sender is busy');
        signal.throwIfAborted();
        active++;
        const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, 5000);
        signal.addEventListener('abort', abort, { once: true });
        let rejectAbort: () => void = () => { };
        try {
            await Promise.race([deliver(message, controller.signal), new Promise<never>((_resolve, reject) => {
                    rejectAbort = () => reject(new Error('Email delivery aborted'));
                    controller.signal.addEventListener('abort', rejectAbort, { once: true });
                    if (controller.signal.aborted)
                        rejectAbort();
                })]);
        }
        finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            controller.signal.removeEventListener('abort', rejectAbort);
            active--;
        }
    }
    const notice = (email: string, key: EmailTemplateKey, values: Record<string,string>, signal: AbortSignal, locale?: string) => send({ email: normalizeEmail(email), ...where.emailCopy.render(key, values, locale) }, signal);
    const result: EmailSender = Object.assign(async (message: TokenMessage) => {
        if (!message || !['verify-email', 'reset-password', 'cancel-deletion', 'invitation', 'verify-email-change', 'cancel-email-change'].includes(message.purpose) || typeof message.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(message.token)) throw new Error('Invalid token delivery');
        const paths = { 'verify-email':'/verify', 'reset-password':'/reset', 'cancel-deletion':'/cancel-deletion', invitation:'/register', 'verify-email-change':'/verify-email-change', 'cancel-email-change':'/cancel-email-change' };
        const url = new URL(where.mount + paths[message.purpose], where.origin); url.searchParams.set('token',message.token);
        await notice(message.email,message.purpose,{link:url.href},message.signal,message.locale);
    }, {
        async sendEmailCode(message: EmailCodeMessage) {
            if (!message || typeof message.code !== 'string' || !/^\d{6}$/.test(message.code) || typeof message.flowId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(message.flowId)) throw new Error('Invalid email code delivery');
            const url = new URL(where.mount + '/email-code',where.origin);url.searchParams.set('flowId',message.flowId);
            await notice(message.email,'sign-in-code',{link:url.href,code:message.code},message.signal,message.locale);
        },
        async sendSignupCode(message: SignupCodeMessage) {
            if (!message || typeof message.code !== 'string' || !/^\d{6}$/.test(message.code)) throw new Error('Invalid signup code delivery');
            await notice(message.email,'signup-code',{link:new URL(where.mount+'/signup',where.origin).href,code:message.code},message.signal,message.locale);
        },
        async sendFactorRecovery(message: FactorRecoveryMessage) {
            if (!message || typeof message.verificationToken !== 'string' || typeof message.cancelToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(message.verificationToken) || !/^[A-Za-z0-9_-]{43}$/.test(message.cancelToken)) throw new Error('Invalid factor recovery delivery');
            const url=new URL(where.mount+'/recover-factor/confirm',where.origin),cancel=new URL(where.mount+'/recover-factor/cancel',where.origin);
            url.searchParams.set('token',message.verificationToken);cancel.searchParams.set('token',message.cancelToken);
            await notice(message.email,'factor-recovery',{link:url.href,cancelLink:cancel.href},message.signal,message.locale);
        },
        async sendManualRecovery(message: ManualRecoveryDelivery & { locale?: string }) {
            if (!message || typeof message.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(message.token)) throw new Error('Invalid manual recovery delivery');
            const email=normalizeEmail(message.email),oldEmail=normalizeEmail(message.oldEmail),url=new URL(where.mount+'/restore-access',where.origin);url.searchParams.set('token',message.token);
            await notice(oldEmail,'manual-recovery-warning',{},message.signal,message.locale);
            await notice(email,'manual-recovery',{link:url.href},message.signal,message.locale);
        },
        async sendAccountAdministration(message: AdminAccountDelivery & { signal: AbortSignal; locale?: string }) {
            if (!message || !['token','notice'].includes(message.kind)) throw new Error('Invalid account administration delivery');
            if (message.kind === 'token') return result({ email: message.email, token: message.token, purpose: message.purpose, signal: message.signal, ...(message.locale ? { locale: message.locale } : {}) });
            if (!['verify-email','force-password-reset','schedule-deletion','cancel-deletion','remove-passkey','remove-external','request-email-change','assign-roles','resend-verification'].includes(message.action)) throw new Error('Invalid administration notice');
            await notice(message.email,('admin-'+message.action) as EmailTemplateKey,{link:where.origin+where.mount+'/account'},message.signal,message.locale);
        },
        async notify(message: SecurityNotice) {
            if (!message || !Object.hasOwn(events,message.event)) throw new Error('Invalid security notice');
            await notice(message.email,message.event,{link:where.origin+where.mount+'/account'},message.signal,message.locale);
        },
        close() { if (closed) return; closed=true; cleanup(); }
    });
    return result;
}
export interface SesSenderOptions extends SenderLocation {
    region: string;
    from: string;
    credentials?: SesCredentials | (() => Promise<SesCredentials>);
    /** Trusted injection for tests; production uses the AWS SDK with bounded retries. */
    transport?: (command: SesEmailCommand, options: {
        abortSignal: AbortSignal;
    }) => Promise<unknown>;
}
export interface SesCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
export interface SesEmailInput {
    FromEmailAddress: string;
    Destination: { ToAddresses: string[] };
    Content: { Simple: { Subject: { Data: string; Charset: 'UTF-8' }; Body: { Text: { Data: string; Charset: 'UTF-8' } } } };
}
export interface SesEmailCommand { input: SesEmailInput }
interface SesModule {
    SESv2Client: new (options: { region: string; maxAttempts: number; credentials?: SesSenderOptions['credentials'] }) => { send(command: unknown, options: { abortSignal: AbortSignal }): Promise<unknown>; destroy(): void };
    SendEmailCommand: new (input: SesEmailInput) => SesEmailCommand;
}
function loadSes(): SesModule {
    try { return createRequire(import.meta.url)('@aws-sdk/client-sesv2') as SesModule; }
    catch { throw new Error('SES delivery requires the optional @aws-sdk/client-sesv2 package'); }
}
export function createSesSender(options: SesSenderOptions): EmailSender {
    const where = location(options), from = normalizeEmail(options.from);
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(options.region))
        throw new Error('Invalid SES region');
    const sdk = options.transport ? undefined : loadSes();
    const client = sdk ? new sdk.SESv2Client({ region: options.region, maxAttempts: 2, ...(options.credentials ? { credentials: options.credentials } : {}) }) : undefined;
    return sender(where, async (message, signal) => {
        const input: SesEmailInput = { FromEmailAddress: from, Destination: { ToAddresses: [message.email] }, Content: { Simple: { Subject: { Data: message.subject, Charset: 'UTF-8' }, Body: { Text: { Data: message.text, Charset: 'UTF-8' } } } } };
        const command = sdk ? new sdk.SendEmailCommand(input) : { input };
        await (options.transport ?? ((value, init) => client!.send(value, init)))(command, { abortSignal: signal });
    }, () => client?.destroy());
}
export type DevelopmentSenderOptions = SenderLocation & {
    allowDevelopment: true;
    maxMessages?: number;
} & ({
    directory: string;
    projectRoot: string;
    allowConsoleTokens?: never;
    write?: never;
} | {
    allowConsoleTokens: true;
    write?: (message: string) => void;
    directory?: never;
    projectRoot?: never;
});
/** Development only. File output uses exclusive 0600 notices in an existing private directory outside the project. */
export async function createDevelopmentSender(options: DevelopmentSenderOptions): Promise<EmailSender> {
    if (options.allowDevelopment !== true)
        throw new Error('Development delivery requires explicit allowDevelopment');
    const where = location(options, true), maximum = options.maxMessages ?? 100;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1000)
        throw new Error('Invalid development notice limit');
    let directory: string | undefined;
    if (options.directory !== undefined) {
        directory = await realpath(options.directory);
        const project = await realpath(options.projectRoot!);
        const rel = relative(project, directory);
        if (!rel || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')))
            throw new Error('Development notices must be outside the project');
        const info = await stat(directory);
        if (!info.isDirectory() || process.platform !== 'win32' && (info.mode & 0o077) !== 0)
            throw new Error('Development notice directory must be private');
    }
    else if (options.allowConsoleTokens !== true)
        throw new Error('Console tokens require explicit allowConsoleTokens');
    let count = 0;
    return sender(where, async (message, signal) => {
        signal.throwIfAborted();
        if (count >= maximum)
            throw new Error('Development notice limit reached');
        count++;
        const text = JSON.stringify({ development: true, ...message }) + '\n';
        if (Buffer.byteLength(text) > 4096)
            throw new Error('Development notice too large');
        if (directory) {
            if ((await readdir(directory)).length >= maximum)
                throw new Error('Development notice directory limit reached');
            signal.throwIfAborted();
            const file = await open(join(directory, randomUUID() + '.json'), 'wx', 0o600);
            try {
                await file.writeFile(text);
                await file.sync();
            }
            finally {
                await file.close();
            }
        }
        else {
            signal.throwIfAborted();
            (options.write ?? console.log)(text);
        }
    });
}
