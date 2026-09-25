import {adminTemplateNames} from './admin-templates.ts';
import {rolesScreen,sessionsScreen,auditScreen,healthScreen,casesScreen,registrationsScreen} from './admin-screens.ts';
import {adminCopy} from './admin-copy.ts';
import type {AdminCopy} from './admin-copy.ts';
import {userDirectory} from './admin-users.ts';
import {postForm} from '@jimhoyd/urlcode-ui';
import type {IconName,LocalePreferences,ViewModel} from '@jimhoyd/urlcode-ui';
import type {UiExtension} from '@jimhoyd/urlcode-ui/host';
import {AdminHttpError,failureResponse,formField as baseField,markup,screenResponse} from './admin-ui.ts';
import type {ScreenOptions} from './admin-ui.ts';
import {dashboardSummary} from './admin-dashboard.ts';
import {accountDetail} from './admin-detail.ts';
import {createAdminAccount} from './admin-account.ts';
import {createAdminRecovery} from './admin-recovery.ts';
import {exportAuditRange} from './admin-audit-export.ts';
import {createHealthReader} from './admin-health.ts';
import type {AdminHealthProvider} from './admin-health.ts';
import {maskEmail,sessionFilters,userFilters,userFilterKeys,auditFilters,selectedField,selectedAccounts,usersCsv} from './admin-reporting.ts';
import {extensionHookContext,jsonResponse,readFields,wantsJson} from '@jimhoyd/urlcode/extensions';
import type {RuntimeExtension,ExtensionRequest,HandlerResult} from '@jimhoyd/urlcode/extensions';
import type {AuthAccount,AuthExports} from '@jimhoyd/urlcode-auth';
import type {AuditExports} from '@jimhoyd/urlcode-audit';
export interface AdminOptions {
    auth: AuthExports;
    ui: UiExtension;
    audit: AuditExports;
    health?: AdminHealthProvider | undefined;
    projectSha256: string;
}
/** The `extensions.admin.config` schema: admin has no configuration of its own. */
export const adminConfigSchema = { type: 'object', additionalProperties: false, properties: {} };
/** Audit permissions: granted by roles like auth's, checked by admin (audit carries no authorization of its own). */
const auditPermissions = ['audit.read', 'audit.export'] as const;
export const adminAuthoring = Object.freeze({
    description: 'The administration console is part of the application, while auth keeps ownership of permissions, freshness checks, lifecycle hooks and transactional account operations, and audit keeps the log. Customize the console copy and screens before replacing behavior.',
    surfaces: Object.freeze([
        { kind: 'copy' as const, name: 'administration copy', description: 'Change console wording through the admin.* keys of the UI catalogue.', path: 'ui/copy/<locale>.json' },
        { kind: 'template' as const, name: 'administration screens', description: 'Override one admin/* screen when its structure must change; keep permissions and mutation behavior package-owned.', path: 'ui/templates/admin/<screen>.html', command: 'urlcode-ui list --project . --extensions @jimhoyd/urlcode-admin' },
        { kind: 'hook' as const, name: 'account lifecycle', description: 'Role, registration and account-status hooks are auth\'s: they fire for the console and every other caller.', path: 'extensions.auth.config.hooks' },
    ]),
    fastChecks: Object.freeze(['urlcode-ui doctor --project . --extensions @jimhoyd/urlcode-auth,@jimhoyd/urlcode-admin --copy ui/copy --templates ui/templates --stylesheet ui/extra.css', 'urlcode validate --local', 'urlcode test']),
});
/** The console registration: `/admin/*` behind auth's session policy, reading the account auth resolved for the request. */
export function createAdmin(options: AdminOptions): RuntimeExtension {
    const { auth, ui, audit } = options;
    return { name: 'admin', version: '1', projectSha256: options.projectSha256, targets: ['node'], schema: adminConfigSchema, authoring: adminAuthoring,
        activate(_config, context) {
            if (context.mounts.length !== 1)
                throw new Error('Admin requires exactly one mount');
            const mount = context.mounts[0]!;
            // Auth's policy is the console's only way in: it resolves the session, verifies CSRF and sets the principal.
            if (!context.principalMounts?.includes(mount))
                throw new Error(`${mount}/* must carry an auth policy (auth: {onDeny: 404})`);
            if (!ui.active)
                throw new Error('The ui extension is not active: admin renders only through the urlcode-ui kit');
            const missing = adminTemplateNames.filter(name => !ui.kit.info(name));
            if (missing.length)
                throw new Error(`The ui kit lacks the admin templates (${missing.length} of ${adminTemplateNames.length} missing, first ${missing[0]}): compose ui through composeHost, which registers what admin contributes, or pass adminUiTemplates to createUiExtension({extensions})`);
            if (!auth.active)
                throw new Error('The auth extension is not active');
            if (!audit.active)
                throw new Error('The audit extension is not active');
            const readHealth = options.health ? createHealthReader(options.health) : undefined;
            const gate = [...auth.permissions, ...auditPermissions];
            const accounts = createAdminAccount(auth, mount), recovery = createAdminRecovery(auth, mount);
            const administration = () => auth.administration;
            function requirePermission(account: AuthAccount, permission: string): void {
                if (!account.has(permission))
                    throw new AdminHttpError(403, 'Permission required');
            }
            /** Auth's step-up page, returning to this console path (or the console's root when the path cannot be a return target). */
            function stepUp(current: string): string {
                try { return auth.urls.stepUp(mount + current); }
                catch { return auth.urls.stepUp(mount + '/'); }
            }
            function navigation(account: AuthAccount, copy: AdminCopy, current: string): NonNullable<ScreenOptions['shell']> {
                const isCurrent = (path: string) => path === '/' ? (current === '/' || current === '/dashboard') : current === path || current.startsWith(path + '/');
                const sections: readonly (readonly [string, string, string, IconName])[] = [['users', 'admin.nav.users', 'auth.users.read', 'users'], ['sessions', 'admin.nav.sessions', 'auth.sessions.manage', 'monitor'], ['registrations', 'admin.nav.registration', 'auth.users.manage', 'mail'], ['roles', 'admin.nav.roles', 'auth.roles.read', 'shield'], ['audit', 'admin.nav.audit', 'audit.read', 'list'], ['cases', 'admin.nav.cases', 'auth.cases.read', 'circle-alert'], ['health', 'admin.nav.health', 'auth.health.read', 'activity']];
                const items: { href: string; label: string; current: boolean; icon: IconName }[] = [{ href: mount + '/', label: copy.t('admin.nav.overview'), current: isCurrent('/'), icon: 'home' }, ...sections.filter(([, , permission]) => account.has(permission)).map(([path, key, , symbol]) => ({ href: mount + '/' + path, label: copy.t(key), current: isCurrent('/' + path), icon: symbol })), ...(accounts.enabled() && account.has('auth.users.manage') ? [{ href: mount + '/account-operations', label: copy.t('admin.ops.title'), current: isCurrent('/account-operations'), icon: 'settings' as const }] : []), ...(recovery.enabled() && account.has('auth.cases.read') ? [{ href: mount + '/recovery-cases', label: copy.t('admin.recovery.title'), current: isCurrent('/recovery-cases'), icon: 'key' as const }] : [])];
                const menu = { label: copy.t('admin.nav.account'), items: [{ href: auth.urls.account(), label: copy.t('admin.nav.account') }, { href: stepUp(current), label: copy.t('admin.action.confirm') }] };
                // The kit builds the sidebar, the page header and the skip target from these links: one representation of the console shell, not two.
                return { nav: items, menu };
            }
            return { async handle(request: ExtensionRequest): Promise<HandlerResult> {
                    const account = auth.account(request);
                    const preferences: LocalePreferences = { ...(account?.locale ? { accountLocale: account.locale } : {}), ...(request.query.get('lang') ? { queryLocale: request.query.get('lang')! } : {}), ...(request.headers.get('accept-language') ? { acceptLanguage: request.headers.get('accept-language')! } : {}) };
                    // Read per request, never captured: a reloaded ui extension is picked up.
                    const copy = adminCopy(ui.kit.resolveContext(preferences));
                    const path = request.path.slice(mount.length) || '/';
                    const render: ScreenOptions = { copy, ui, ...(account ? { stepUp: { href: stepUp(path), label: copy.t('admin.action.confirm') } } : {}) };
                    const tr = (key: string, values?: Readonly<Record<string, string | number>>) => copy.t(key, values);
                    const formField = (name: string, label: string, type = 'text', autocomplete = 'off', required = true) => baseField(name, copy.s(label), type, autocomplete, required);
                    const form = (action: string, csrf: string, fields: string, button: string) => postForm({ action, csrf, fields, label: copy.s(button), className: 'ui-form-grid' });
                    try {
                        // The console's existence is not revealed: no account, a support session or no console permission is 404.
                        if (!account || account.impersonated || !gate.some(permission => account.has(permission)))
                            throw new AdminHttpError(404, 'Not found');
                        if (!['GET', 'HEAD', 'POST'].includes(request.method))
                            return jsonResponse(405, { error: 'Method not allowed' }, [['allow', 'GET, HEAD, POST']]);
                        const csrf = auth.csrf.token(request), shell = navigation(account, copy, path), actor = account.actor;
                        const options: ScreenOptions = { ...render, shell };
                        const screen = (title: string, name: string, view: ViewModel, status?: number, headers?: [string, string][]) => screenResponse(title, { name: 'admin/' + name, view }, { ...options, status, headers });
                        const status = (title: string, message: string, href: string | null = null, label: string | null = null) => screen(title, 'status', { alert: false, message, href, label });
                        const accountResult = await accounts.handle(request, account, csrf, options);
                        if (accountResult)
                            return accountResult;
                        const recoveryResult = await recovery.handle(request, account, csrf, options);
                        if (recoveryResult)
                            return recoveryResult;
                        const input = { mount, csrf, account, copy, query: request.query };
                        if (request.method !== 'POST') {
                            if (path === '/' || path === '/dashboard') {
                                const granted = gate.filter(permission => account.has(permission));
                                const stats = account.has('auth.users.read') ? await administration().dashboard(actor) : undefined;
                                const users = account.has('auth.users.read') ? await administration().users.list(actor, { limit: 50 }) : undefined;
                                const methodCounts = new Map<string, { signUps: number; signIns: number; failedSignIns: number }>();
                                for (const day of stats?.daily ?? [])
                                    for (const entry of day.methods) {
                                        const total = methodCounts.get(entry.method) ?? { signUps: 0, signIns: 0, failedSignIns: 0 };
                                        total.signUps += entry.signUps;
                                        total.signIns += entry.signIns;
                                        total.failedSignIns += entry.failedSignIns;
                                        methodCounts.set(entry.method, total);
                                    }
                                // Recent means newest first (#746).
                                const recent = account.has('audit.read') ? await audit.query({ limit: 20, order: 'desc' }) : undefined;
                                if (wantsJson(request)) return jsonResponse(200, { permissions: granted, csrf, ...(users ? { accounts: stats, accountsShown: users.users.length, moreAccounts: !!users.next } : {}), ...(recent ? { recentEvents: recent.events } : {}) });
                                const number = (value: number) => tr('admin.number.value', { value }), counts = (total: { signUps: number; signIns: number; failedSignIns: number }) => ({ signUps: number(total.signUps), signIns: number(total.signIns), failedSignIns: number(total.failedSignIns) });
                                return screen('Administration', 'dashboard', {
                                    impersonation: account.has('auth.users.impersonate') && administration().capabilities.impersonation ? { summary: copy.s('Start ten-minute support impersonation'), form: markup(form(mount + '/impersonate', csrf, formField('accountId', 'Account ID') + formField('reason', 'Reason'), 'Start ten-minute support impersonation')) } : null,
                                    intro: tr('admin.copy.selectASectionOnlyPermittedOperationsAreShownConfigurationRemainsInVersionControlledProjectFiles'),
                                    summary: stats ? markup(dashboardSummary(stats, mount, account, copy)) : null,
                                    activity: stats ? { heading: copy.s('View activity totals'), description: tr('admin.copy.recordedAccountCreationsSuccessfulSignInsAndFailedSignInsTheseFiguresDescribeAuthenticationActivityDeploymentH'), dailyCaption: tr('admin.copy.dailyAuthenticationCounts'), methodsCaption: tr('admin.copy.authenticationMethodsOverTheSame30Days'), dayHeading: tr('admin.copy.uTCDay'), methodHeading: tr('admin.copy.method'), signUps: tr('admin.copy.signUps'), signIns: tr('admin.copy.signIns'), failedSignIns: tr('admin.copy.failedSignIns'), days: stats.daily.map(day => ({ day: day.day, ...counts(day) })), methods: [...methodCounts].map(([method, total]) => ({ method, ...counts(total) })) } : null,
                                    recent: recent ? { heading: tr('admin.copy.recentEvents'), auditHref: mount + '/audit', auditLabel: tr('admin.nav.audit'), events: recent.events.slice(0, 8).map(event => ({ action: event.action, datetime: new Date(event.at).toISOString(), label: new Date(event.at).toISOString().replace('T', ' ').slice(0, 16) })), empty: copy.s('No account activity recorded.') } : null,
                                });
                            }
                            if (path === '/health') {
                                requirePermission(account, 'auth.health.read');
                                const health = readHealth ? await readHealth() : null;
                                if (wantsJson(request))
                                    return jsonResponse(health || !readHealth ? 200 : 503, { configured: !!readHealth, health });
                                return screenResponse('Service health', healthScreen({ ...input, health, configured: !!readHealth }), options);
                            }
                            if (path === '/cases') {
                                requirePermission(account, 'auth.cases.read');
                                const result = await administration().cases.list(actor, { limit: 50, ...(request.query.get('after') ? { after: request.query.get('after')! } : {}) });
                                if (wantsJson(request))
                                    return jsonResponse(200, { ...result, csrf });
                                return screenResponse('Support cases', casesScreen({ ...input, result }), options);
                            }
                            if (path === '/registrations') {
                                requirePermission(account, 'auth.users.manage');
                                const result = await administration().registrations.list(actor, { limit: 50, ...(request.query.get('after') ? { after: request.query.get('after')! } : {}) });
                                if (wantsJson(request))
                                    return jsonResponse(200, { ...result, requests: result.requests.map(item => ({ ...item, email: maskEmail(item.email) })), csrf });
                                return screenResponse('Registration requests', registrationsScreen({ ...input, result, canInvite: administration().capabilities.invitations }), options);
                            }
                            if (path === '/users/detail') {
                                requirePermission(account, 'auth.users.read');
                                const found = await administration().users.get(actor, request.query.get('id') || '');
                                if (!found)
                                    throw new AdminHttpError(404, 'Account not found');
                                const activity = account.has('audit.read') ? await audit.query({ subject: found.id, limit: 20, order: 'desc' }) : undefined;
                                const notes = account.has('audit.read') ? await audit.query({ subject: found.id, action: 'admin.note', limit: 50, order: 'desc' }) : undefined;
                                const user = { ...found, email: maskEmail(found.email) }, sessions = account.has('auth.sessions.manage') ? await administration().users.sessions(actor, user.id) : undefined;
                                if (wantsJson(request))
                                    return jsonResponse(200, { user, ...(sessions ? { sessions } : {}), ...(activity ? { activity: activity.events } : {}), csrf });
                                return screenResponse('Account details', accountDetail({ user, account, mount, csrf, copy, ...(sessions ? { sessions } : {}), ...(activity ? { activity } : {}), ...(notes ? { notes } : {}), operations: accounts.enabled(), recovery: recovery.enabled() }), options);
                            }
                            if (path === '/users') {
                                requirePermission(account, 'auth.users.read');
                                const result = await administration().users.list(actor, userFilters(request.query)), users = result.users.map(user => ({ ...user, email: maskEmail(user.email) }));
                                if (wantsJson(request))
                                    return jsonResponse(200, { users, ...(result.next ? { next: result.next } : {}), csrf });
                                return screenResponse('Users', userDirectory({ ...input, users, ...(result.next ? { next: result.next } : {}), canSendSetup: administration().capabilities.delivery }), options);
                            }
                            if (path === '/roles') {
                                requirePermission(account, 'auth.roles.read');
                                const roles = await administration().roles(actor);
                                if (wantsJson(request))
                                    return jsonResponse(200, { roles, csrf });
                                return screenResponse('Roles', rolesScreen({ ...input, roles }), options);
                            }
                            if (path === '/sessions') {
                                requirePermission(account, 'auth.sessions.manage');
                                const result = await administration().sessions.list(actor, sessionFilters(request.query));
                                if (wantsJson(request))
                                    return jsonResponse(200, { ...result, sessions: result.sessions.map(session => ({ ...session, email: maskEmail(session.email) })), csrf });
                                return screenResponse('Sessions', sessionsScreen({ ...input, result }), options);
                            }
                            if (path === '/audit/export') {
                                requirePermission(account, 'audit.read');
                                requirePermission(account, 'audit.export');
                                const exportReason = request.query.get('reason') || '';
                                if (!exportReason.trim() || exportReason.length > 256)
                                    throw new AdminHttpError(400, 'A reason is required');
                                if (!account.fresh)
                                    throw new AdminHttpError(403, 'Confirm your identity before this action');
                                return jsonResponse(200, await exportAuditRange(audit, auth, account, request.query, exportReason), [['content-disposition', 'attachment; filename="audit-range.json"']]);
                            }
                            if (path === '/audit') {
                                requirePermission(account, 'audit.read');
                                const result = await audit.query(auditFilters(request.query));
                                if (wantsJson(request))
                                    return jsonResponse(200, result);
                                return screenResponse('Audit', auditScreen({ ...input, result }), options);
                            }
                            throw new AdminHttpError(404, 'Not found');
                        }
                        const fields = readFields(request, { fields: ['csrf', 'accountIds', 'confirmation', ...userFilterKeys, 'after', 'accountId', 'roles', 'status', 'reason', 'requestId', 'email', 'action', 'caseId', 'sessionId'], patterns: [selectedField] });
                        if (!fields.reason?.trim() || fields.reason.length > 256)
                            throw new AdminHttpError(400, 'A reason is required');
                        // A UX pre-check: auth's store refuses a stale proof inside every mutation's transaction too.
                        if (!account.fresh)
                            throw new AdminHttpError(403, 'Confirm your identity before this action');
                        const context = extensionHookContext(request), reason = fields.reason;
                        if (path === '/users/note') {
                            requirePermission(account, 'auth.users.manage');
                            await administration().users.addNote(actor, { accountId: fields.accountId || '', reason });
                            return wantsJson(request) ? jsonResponse(200, { saved: true }) : status('Note saved', copy.s('Administrator note saved.'));
                        }
                        if (path === '/users/bulk') {
                            if (!['lock', 'unlock', 'revoke-sessions'].includes(fields.action || ''))
                                throw new AdminHttpError(400, 'Invalid bulk action');
                            const action = fields.action as 'lock' | 'unlock' | 'revoke-sessions';
                            requirePermission(account, action === 'revoke-sessions' ? 'auth.sessions.manage' : 'auth.users.manage');
                            const accountIds = selectedAccounts(fields);
                            if (fields.confirmation !== action.toUpperCase() + ' ' + accountIds.length)
                                throw new AdminHttpError(400, 'Typed confirmation must match the action and selected count');
                            const result = await administration().users.bulk(actor, { accountIds, action, reason, context });
                            return wantsJson(request) ? jsonResponse(200, result) : status('Bulk update completed', tr('admin.message.bulkUpdated', { count: result.affected }));
                        }
                        if (path === '/users/export-range') {
                            requirePermission(account, 'auth.users.export');
                            requirePermission(account, 'auth.users.read');
                            const filters = new URLSearchParams();
                            for (const key of userFilterKeys) if (fields[key]) filters.set(key, fields[key]);
                            const { limit: _limit, ...query } = userFilters(filters);
                            const rows = await administration().users.exportRange(actor, { query, reason });
                            return { status: 200, headers: [...jsonResponse(200, {}).headers.filter(([name]) => name !== 'content-type'), ['content-type', 'text/csv; charset=utf-8'], ['content-disposition', 'attachment; filename="accounts-filtered.csv"']], body: usersCsv(rows, 5000) };
                        }
                        if (path === '/users/export-page') {
                            requirePermission(account, 'auth.users.export');
                            requirePermission(account, 'auth.users.read');
                            const filterValues = new URLSearchParams();
                            for (const key of [...userFilterKeys, 'after'])
                                if (fields[key])
                                    filterValues.set(key, fields[key]);
                            const page = await administration().users.list(actor, userFilters(filterValues));
                            const users = [];
                            for (const user of page.users) {
                                const exported = await administration().users.export(actor, { accountId: user.id, reason });
                                users.push({ ...exported.user, ...(user.observedLastSeen !== undefined ? { observedLastSeen: user.observedLastSeen } : {}) });
                            }
                            return { status: 200, headers: [...jsonResponse(200, {}).headers.filter(([name]) => name !== 'content-type'), ['content-type', 'text/csv; charset=utf-8'], ['content-disposition', 'attachment; filename="accounts-page.csv"'], ...(page.next ? [['x-next-cursor', page.next] as [string, string]] : [])], body: usersCsv(users) };
                        }
                        if (path === '/users/reveal') {
                            requirePermission(account, 'auth.users.read');
                            requirePermission(account, 'auth.users.reveal');
                            const result = await administration().users.reveal(actor, { accountId: fields.accountId || '', reason });
                            return wantsJson(request) ? jsonResponse(200, result) : screen('Account identifier', 'reveal', { idLabel: tr('admin.field.accountId'), id: result.id, emailLabel: tr('admin.copy.email'), email: result.email });
                        }
                        if (path === '/users/export') {
                            requirePermission(account, 'auth.users.export');
                            return jsonResponse(200, await administration().users.export(actor, { accountId: fields.accountId || '', reason }), [['content-disposition', 'attachment; filename="account-export.json"']]);
                        }
                        if (path === '/impersonate') {
                            requirePermission(account, 'auth.users.impersonate');
                            const started = await administration().impersonate(actor, { accountId: fields.accountId || '', reason });
                            return jsonResponse(303, { impersonating: true }, [['location', started.location], ...started.headers]);
                        }
                        if (path === '/users/create') {
                            requirePermission(account, 'auth.users.create');
                            await administration().users.create(actor, { email: fields.email || '', reason, context });
                        }
                        else if (path === '/sessions/revoke-one') {
                            requirePermission(account, 'auth.sessions.manage');
                            await administration().sessions.revoke(actor, { sessionId: fields.sessionId || '', reason });
                        }
                        else if (path === '/cases/create') {
                            requirePermission(account, 'auth.cases.manage');
                            if (!['reset-factors', 'lock', 'unlock', 'roles'].includes(fields.action || ''))
                                throw new AdminHttpError(400, 'Invalid case action');
                            const roles = fields.roles ? fields.roles.split(',').map(role => role.trim()).filter(Boolean) : undefined;
                            await administration().cases.create(actor, { accountId: fields.accountId || '', action: fields.action as 'reset-factors' | 'lock' | 'unlock' | 'roles', ...(roles ? { roles } : {}), reason, context });
                        }
                        else if (path === '/cases/note') {
                            requirePermission(account, 'auth.cases.manage');
                            await administration().cases.note(actor, { caseId: fields.caseId || '', note: reason });
                        }
                        else if (path === '/cases/close') {
                            requirePermission(account, 'auth.cases.manage');
                            await administration().cases.close(actor, { caseId: fields.caseId || '', reason });
                        }
                        else if (path === '/cases/approve') {
                            requirePermission(account, 'auth.cases.manage');
                            await administration().cases.approve(actor, { caseId: fields.caseId || '', reason, context });
                        }
                        else if (path === '/registrations/approve') {
                            requirePermission(account, 'auth.users.manage');
                            await administration().registrations.approve(actor, { requestId: fields.requestId || '', reason, context });
                        }
                        else if (path === '/invitations') {
                            requirePermission(account, 'auth.users.create');
                            await administration().registrations.invite(actor, { email: fields.email || '' });
                        }
                        else if (path === '/users/roles') {
                            requirePermission(account, 'auth.users.manage');
                            await administration().users.setRoles(actor, { accountId: fields.accountId || '', roles: (fields.roles || '').split(',').map(role => role.trim()).filter(Boolean), reason, context });
                        }
                        else if (path === '/users/status') {
                            requirePermission(account, 'auth.users.manage');
                            if (fields.status !== 'active' && fields.status !== 'locked')
                                throw new AdminHttpError(400, 'Invalid status');
                            await administration().users.setStatus(actor, { accountId: fields.accountId || '', status: fields.status, reason, context });
                        }
                        else if (path === '/sessions/revoke') {
                            requirePermission(account, 'auth.sessions.manage');
                            await administration().users.revokeSessions(actor, { accountId: fields.accountId || '', reason });
                        }
                        else
                            throw new AdminHttpError(404, 'Not found');
                        return wantsJson(request) ? jsonResponse(200, { updated: true }) : status('Update completed', tr('admin.message.operationCompleted'), mount, copy.s('Return to overview'));
                    }
                    catch (error) {
                        return failureResponse(error, request, render);
                    }
                } };
        } };
}
