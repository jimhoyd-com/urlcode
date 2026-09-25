#!/usr/bin/env node
import { verifyDeployment } from './deployment-check.ts';
import { parseArgs } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createBackup, restoreBackup } from './backup.ts';
import { internal } from './auth-core.ts';
import type { AuthService } from './auth-core.ts';
import { loadAuthHooks } from './lifecycle-hooks.ts';
async function input(): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of process.stdin) {
        const bytes = Buffer.from(part as Uint8Array);
        size += bytes.length;
        if (size > 1048576)
            throw new Error('Input exceeds limit');
        chunks.push(bytes);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid input');
    return value as Record<string, unknown>;
}
function string(value: unknown): string {
    if (typeof value !== 'string' || !value)
        throw new Error('Required input missing');
    return value;
}
/**
 * The project's auth lifecycle hooks, attached for the commands that create or delete accounts, so they fire from the
 * CLI exactly as from the site. The project is read with core's loader; one that cannot be read refuses the command
 * unless the operator passes --no-project-hooks.
 */
async function attachProjectHooks(service: AuthService, project: string): Promise<void> {
    const { loadDocument } = await import('@jimhoyd/urlcode');
    const loaded = await loadDocument(project), hooks = loaded.document.extensions?.auth?.config?.hooks as Readonly<Record<string, unknown>> | undefined;
    internal(service).attachLifecycleHooks(await loadAuthHooks(hooks, loaded.root));
}
let service: AuthService | undefined;
try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'operator-file': { type: 'string' }, project: { type: 'string' }, 'no-project-hooks': { type: 'boolean' }, help: { type: 'boolean' } } });
    const command = positionals[0];
    if (values.help || !command)
        process.stdout.write('urlcode-auth bootstrap|users|sessions|revoke|import|rotate-key|purge|cleanup|configuration|doctor|validate --operator-file /absolute/operator/auth.mjs\nurlcode-auth bootstrap|import|purge also fire the project\'s lifecycle hooks: --project <app dir> (default: app/ beside the operator file), or --no-project-hooks\nurlcode-auth api-key-issue|api-key-list|api-key-revoke --operator-file /absolute/operator/auth.mjs (JSON name/scopes/expiresInMs/quota/userId, or id, on stdin)\nurlcode-auth auth-baseline (offline synthetic checks)\nurlcode-auth verify-deployment (JSON origin/authMount on stdin)\nurlcode-auth backup|restore (JSON paths on stdin)\nSecrets and operation data use bounded JSON stdin, never argv. Operator module default-exports an AuthService.\n');
    else {
        if (positionals.length !== 1)
            throw new Error('Invalid command');
        let output: unknown;
        if (command === 'auth-baseline') {
            if (values['operator-file']) throw new Error('Baseline accepts no operator files');
            const { runAuthBaseline } = await import('./auth-baseline.ts');
            const result = await runAuthBaseline(); output = result; if (!result.passed) process.exitCode = 1;
        }
        else if (command === 'verify-deployment') {
            const data = await input();
            const result = await verifyDeployment({ origin: string(data.origin), authMount: string(data.authMount), ...(data.allowDevelopment === true ? { allowDevelopment: true } : {}), ...(data.allowTurnstile === true ? { allowTurnstile: true } : {}) });
            output = result;
            if (!result.passed) process.exitCode = 1;
        }
        else if (command === 'backup' || command === 'restore') {
            const data = await input(), destination = string(data.destination), projectRoot = string(data.projectRoot);
            output = command === 'backup' ? await createBackup({ database: string(data.database), destination, projectRoot }) : await restoreBackup({ backup: string(data.backup), destination, projectRoot });
        }
        else {
            if (!['bootstrap', 'users', 'sessions', 'revoke', 'import', 'rotate-key', 'purge', 'cleanup', 'configuration', 'doctor', 'validate', 'api-key-issue', 'api-key-list', 'api-key-revoke'].includes(command))
                throw new Error('Invalid command');
            if (!values['operator-file'] || !isAbsolute(values['operator-file']))
                throw new Error('Provide an absolute operator file');
            const file = await realpath(values['operator-file']), info = await stat(file);
            if (!info.isFile() || info.size > 1048576)
                throw new Error('Invalid operator file');
            service = (await import(pathToFileURL(file).href) as {
                default: AuthService;
            }).default;
            if (!service || typeof service.close !== 'function' || typeof service.bootstrapAdmin !== 'function')
                throw new Error('Invalid operator service');
            if (['bootstrap', 'import', 'purge'].includes(command) && !values['no-project-hooks'])
                await attachProjectHooks(service, values.project ? resolve(values.project) : join(dirname(file), 'app'));
            const data = ['bootstrap', 'sessions', 'revoke', 'import', 'api-key-issue', 'api-key-revoke'].includes(command) ? await input() : {};
            if (command === 'bootstrap')
                output = (await service.bootstrapAdmin({ email: string(data.email), password: string(data.password) })).user;
            else if (command === 'users')
                output = await service.listUsers({ limit: 100 });
            else if (command === 'rotate-key')
                output = await service.rotateEncryptionKey();
            else if (command === 'purge')
                output = await service.purgeDeleted();
            else if (command === 'cleanup')
                output = await service.cleanup({ limit: 1000 });
            else if (command === 'configuration')
                output = { revision: await service.getConfigurationRevision(), registration: service.getRegistrationMode(), security: service.getSecurityPolicy(), roles: service.getRoles() };
            else if (command === 'validate') {
                const { validateAuthService } = await import('./auth-baseline.ts');
                output = await validateAuthService(service);
            }
            else if (command === 'doctor') {
                // Undrained outbox events reach the audit log only while a host with the audit extension runs.
                const full = internal(service), auditBacklog = await full.auditOutbox.backlog();
                output = { database: 'ready', registration: service.getRegistrationMode(), security: service.getSecurityPolicy(), accounts: (await full.dashboard()).users, auditBacklog, ...(auditBacklog > 0 ? { warnings: [`${auditBacklog} audit event(s) wait in auth's outbox; they reach the audit log when a host with the audit extension runs`] } : {}), liveProviders: 'unverified' };
            }
            else if (command === 'import') {
                if (!Array.isArray(data.users))
                    throw new Error('Users array required');
                const users = data.users.map((user: unknown) => {
                    if (!user || typeof user !== 'object' || Array.isArray(user))
                        throw new Error('Invalid user');
                    const row = user as Record<string, unknown>;
                    if (Object.keys(row).some(key => !['email', 'passwordHash', 'emailVerified'].includes(key)) || row.emailVerified !== undefined && typeof row.emailVerified !== 'boolean')
                        throw new Error('Invalid user field');
                    return { email: string(row.email), passwordHash: string(row.passwordHash), ...(typeof row.emailVerified === 'boolean' ? { emailVerified: row.emailVerified } : {}) };
                });
                output = await service.importUsers(users);
            }
            else if (command === 'sessions')
                output = await service.listSessions(string(data.accountId));
            else if (command === 'api-key-issue') {
                if (!Array.isArray(data.scopes) || data.scopes.some(scope => typeof scope !== 'string'))
                    throw new Error('Scopes array required');
                if (data.quota !== undefined && (!data.quota || typeof data.quota !== 'object' || Array.isArray(data.quota)))
                    throw new Error('Quota object required');
                if (data.userId !== undefined && typeof data.userId !== 'string')
                    throw new Error('userId must be a string');
                // The service validates the quota's bounds and fields (invalid_api_key_quota) and that userId names an
                // active user (invalid_api_key_user).
                output = await service.issueApiKey({ name: string(data.name), scopes: data.scopes, ...(typeof data.expiresInMs === 'number' ? { expiresInMs: data.expiresInMs } : {}), ...(data.quota !== undefined ? { quota: data.quota as { requests: number; window: number } } : {}), ...(typeof data.userId === 'string' ? { userId: data.userId } : {}) });
            }
            else if (command === 'api-key-list')
                output = await service.listApiKeys();
            else if (command === 'api-key-revoke') {
                await service.revokeApiKey(string(data.id));
                output = { revoked: true };
            }
            else {
                await service.revokeSessions(string(data.accountId));
                output = { revoked: true };
            }
        }
        process.stdout.write(JSON.stringify(output) + '\n');
    }
}
catch {
    process.stderr.write('Auth operation failed; check command, operator configuration and input.\n');
    process.exitCode = 1;
}
finally {
    try {
        await service?.close();
    }
    catch {
        process.stderr.write('Auth cleanup failed.\n');
        process.exitCode = 1;
    }
}
