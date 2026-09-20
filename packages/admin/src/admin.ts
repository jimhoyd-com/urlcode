import {rolesScreen,sessionsScreen,auditScreen,healthScreen,casesScreen,registrationsScreen} from './admin-screens.ts';
import {createAdminPresentation} from './admin-copy.ts';
import {userDirectory} from './admin-users.ts';
import {postForm,withDeadline} from '@jimhoyd/urlcode-ui';
import type {IconName,LocalePreferences} from '@jimhoyd/urlcode-ui';
import {failureResponse,markup,presentationSource,requireKit,screenResponse} from './admin-ui.ts';
import type {ScreenOptions,UiHost} from './admin-ui.ts';
import type {ViewModel} from '@jimhoyd/urlcode-ui';
import {dashboardSummary} from './admin-dashboard.ts';
import {accountDetail} from './admin-detail.ts';
import { exportUserRange } from './admin-user-export.ts';
import {createAdminAccount} from './admin-account.ts';
import type {AdminAccountDelivery} from '@jimhoyd/urlcode-auth';
import { createAdminRecovery } from './admin-recovery.ts';
import type { ManualRecoveryDelivery } from '@jimhoyd/urlcode-auth';
import { exportAuditRange } from './admin-audit-export.ts';
import { createHealthReader } from './admin-health.ts';
import type { AdminHealthProvider } from './admin-health.ts';
import { maskEmail, sessionFilters, userFilters, userFilterKeys, auditFilters, selectedNames, selectedAccounts, usersCsv } from './admin-reporting.ts';
import type { RuntimeExtension, ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import type { AuthService, AuthPrincipal, Presentation } from '@jimhoyd/urlcode-auth';
import { AuthHttp, AuthHttpError, formField as baseField, jsonResponse, readFields, wantsJson, hasPermission } from '@jimhoyd/urlcode-auth';
import { adminHookContracts, adminHooksSchema, loadAdminHooks } from './admin-hooks.ts';
export interface AdminExtensionOptions {
    sendAccountAdministration?:(message:AdminAccountDelivery&{signal:AbortSignal})=>Promise<void>;
    sendRecovery?: (message: ManualRecoveryDelivery) => Promise<void>;
    presentation?: Presentation;
    /** The `ui` extension from `createUiExtension`, declared before admin in the project and the host file. Every console screen renders through its kit; activation refuses without it. */
    ui: UiHost;
    health?: AdminHealthProvider;
    service: AuthService;
    csrfKey: Uint8Array;
    projectSha256: string;
    authMount?: string;
    notifyImpersonation?: (message: {
        email: string;
        actorId: string;
        reason: string;
        signal: AbortSignal;
    }) => Promise<void>;
    sendSetup?: (message: {
        email: string;
        token: string;
        signal: AbortSignal;
    }) => Promise<void>;
    sendInvitation?: (message: {
        email: string;
        token: string;
        signal: AbortSignal;
    }) => Promise<void>;
}
const defaultPresentation = createAdminPresentation();
const schema = { type: 'object', additionalProperties: false, properties: { hooks: adminHooksSchema } };
const permissions = ['auth.users.reveal', 'auth.audit.export', 'auth.health.read', 'auth.cases.read', 'auth.cases.manage', 'auth.users.impersonate', 'auth.users.export', 'auth.users.create', 'auth.users.read', 'auth.users.manage', 'auth.audit.read', 'auth.sessions.manage', 'auth.roles.read'];
export function adminExtension(options: AdminExtensionOptions): RuntimeExtension {
    const authMount = options.authMount || '/account';
    if (!/^\/[A-Za-z0-9/_-]*$/.test(authMount) || authMount.includes('//'))
        throw new Error('Invalid auth mount');
    return { name: 'admin', version: '1', projectSha256: options.projectSha256, targets: ['node'], schema, hooks: adminHookContracts, credentialHeaders: ['cookie', 'authorization', 'x-csrf-token'],
        async activate(config, context) {
            if (context.mounts.length !== 1)
                throw new Error('Admin requires exactly one mount');
            requireKit(options.ui);
            // Fails fast during activation: a missing/broken hook module or an
            // unsupported `sandbox: true` throws here, never on first request.
            const hooks = await loadAdminHooks(config, context.root);
            const readHealth = options.health ? createHealthReader(options.health) : undefined;
            const mount = context.mounts[0]!, http = new AuthHttp({ origin: context.origin, csrfKey: options.csrfKey }), service = options.service;
            const accounts=createAdminAccount({service,...(options.sendAccountAdministration?{sendAccountAdministration:options.sendAccountAdministration}:{})},http,mount);
            const recovery = createAdminRecovery({ service, ...(options.sendRecovery ? { sendRecovery: options.sendRecovery } : {}) }, http, mount);
            function requirePermission(principal: AuthPrincipal, permission: string): void {
                if (!hasPermission(principal, permission))
                    throw new AuthHttpError(403, 'Permission required');
            }
            function navigation(principal: AuthPrincipal, text: (source: string) => string, tr: (key: string) => string, current: string): NonNullable<ScreenOptions['shell']> {
                const isCurrent=(path:string)=>path==='/'?(current==='/'||current==='/dashboard'):current===path||current.startsWith(path+'/');
                const items:{href:string;label:string;current:boolean;icon:IconName}[]=[{href:mount+'/',label:tr('nav.overview'),current:isCurrent('/'),icon:'home'},...([['users','Users','auth.users.read','users'],['sessions','Sessions','auth.sessions.manage','monitor'],['registrations','Registration','auth.users.manage','mail'],['roles','Roles','auth.roles.read','shield'],['audit','Audit','auth.audit.read','list'],['cases','Cases','auth.cases.read','circle-alert'],['health','Service health','auth.health.read','activity']] as const).filter(([_path,_label,permission])=>hasPermission(principal,permission!)).map(([path,label,,symbol])=>({href:mount+'/'+path,label:text(label),current:isCurrent('/'+path),icon:symbol})),...(accounts.enabled()&&hasPermission(principal,'auth.users.manage')?[{href:mount+'/account-operations',label:tr('adminOps.title'),current:isCurrent('/account-operations'),icon:'settings' as const}]:[]),...(recovery.enabled()&&hasPermission(principal,'auth.cases.read')?[{href:mount+'/recovery-cases',label:tr('manualRecovery.title'),current:isCurrent('/recovery-cases'),icon:'key' as const}]:[])];
                const menu={label:tr('nav.account'),items:[{href:authMount+'/account',label:tr('nav.account')},{href:authMount+'/step-up',label:tr('action.confirm')}]};
                // The kit builds the sidebar, the page header and the skip target from these links: one representation of the console shell, not two.
                return {nav:items,menu};
            }
            return { async handle(request: ExtensionRequest) {
                    // Activation proved the kit is there; it is still read per request, never captured, so a reloaded ui extension is picked up.
                    const source = presentationSource(options.presentation, options.ui, defaultPresentation);
                    let preferences: LocalePreferences = { ...(request.query.get('lang') ? { queryLocale: request.query.get('lang')! } : {}), ...(request.headers.get('accept-language') ? { acceptLanguage: request.headers.get('accept-language')! } : {}) };
                    let presentation = source.resolve(preferences);
                    const render = (): ScreenOptions => ({ presentation, ui: options.ui });
                    const tr = (key: string, values?: Readonly<Record<string, string | number>>) => presentation.text(key, values);
                    const formField = (name: string, label: string, type = 'text', autocomplete = 'off', required = true) => baseField(name, presentation.textSource(label), type, autocomplete, required);
                    const form = (action: string, csrf: string, fields: string, button: string) => postForm({ action, csrf, fields, label: presentation.textSource(button), className: 'ui-form-grid' });
                    try {
                        const token = http.session(request), principal = token ? await service.authenticate(token) : null;
                        if (!token || !principal || principal.impersonatorId || !permissions.some(permission => hasPermission(principal, permission)))
                            throw new AuthHttpError(404, 'Not found');
                        const accountLocale = (await service.getUser(principal.id))?.profile?.locale;
                        if (accountLocale) { preferences = { accountLocale, ...preferences }; presentation = source.resolve(preferences); }
                        const path = request.path.slice(mount.length) || '/';
                        if (!['GET', 'HEAD', 'POST'].includes(request.method))
                            return jsonResponse(405, { error: 'Method not allowed' }, [['allow', 'GET, HEAD, POST']]);
                        const csrf = http.token(token), shell = navigation(principal, value => presentation.textSource(value), tr, path);
                        const screen = (title: string, name: string, view: ViewModel, status?: number, headers?: [string, string][]) => screenResponse(title, { name: 'admin/' + name, view }, { ...render(), shell, status, headers });
                        const status = (title: string, message: string, href: string | null = null, label: string | null = null) => screen(title, 'status', { alert: false, message, href, label });
                        const accountResult=await accounts.handle(request,principal,token,{...render(),shell});if(accountResult)return accountResult;
                        const recoveryResult = await recovery.handle(request, principal, token, {...render(),shell});
                        if (recoveryResult)
                            return recoveryResult;
                        if (request.method !== 'POST') {
                            if (path === '/' || path === '/dashboard') {
                                const granted = permissions.filter(permission => hasPermission(principal, permission));
                                const stats = hasPermission(principal, 'auth.users.read') ? await service.dashboard() : undefined;
                                const users = hasPermission(principal, 'auth.users.read') ? await service.listUsers({ limit: 50 }) : undefined;
                                const methodCounts = new Map<string, {
                                    signUps: number;
                                    signIns: number;
                                    failedSignIns: number;
                                }>();
                                for (const day of stats?.daily ?? [])
                                    for (const entry of day.methods) {
                                        const total = methodCounts.get(entry.method) ?? { signUps: 0, signIns: 0, failedSignIns: 0 };
                                        total.signUps += entry.signUps;
                                        total.signIns += entry.signIns;
                                        total.failedSignIns += entry.failedSignIns;
                                        methodCounts.set(entry.method, total);
                                    }
                                const recent = hasPermission(principal, 'auth.audit.read') ? await service.listAudit({ limit: 20 }) : undefined;
                                if (wantsJson(request)) return jsonResponse(200, { permissions: granted, csrf, ...(users ? { accounts: stats, accountsShown: users.users.length, moreAccounts: !!users.next } : {}), ...(recent ? { recentEvents: recent.events } : {}) });
                                const number = (value: number) => tr('number.value', { value }), counts = (total: { signUps: number; signIns: number; failedSignIns: number }) => ({ signUps: number(total.signUps), signIns: number(total.signIns), failedSignIns: number(total.failedSignIns) });
                                return screen('Administration', 'dashboard', {
                                    impersonation: hasPermission(principal, 'auth.users.impersonate') && options.notifyImpersonation ? { summary: presentation.textSource('Start ten-minute support impersonation'), form: markup(form(mount + '/impersonate', csrf, formField('accountId', 'Account ID') + formField('reason', 'Reason'), 'Start ten-minute support impersonation')) } : null,
                                    intro: tr('copy.selectASectionOnlyPermittedOperationsAreShownConfigurationRemainsInVersionControlledProjectFiles'),
                                    summary: stats ? markup(dashboardSummary(stats, mount, principal, presentation)) : null,
                                    activity: stats ? { heading: presentation.textSource('View activity totals'), description: tr('copy.recordedAccountCreationsSuccessfulSignInsAndFailedSignInsTheseFiguresDescribeAuthenticationActivityDeploymentH'), dailyCaption: tr('copy.dailyAuthenticationCounts'), methodsCaption: tr('copy.authenticationMethodsOverTheSame30Days'), dayHeading: tr('copy.uTCDay'), methodHeading: tr('copy.method'), signUps: tr('copy.signUps'), signIns: tr('copy.signIns'), failedSignIns: tr('copy.failedSignIns'), days: stats.daily.map(day => ({ day: day.day, ...counts(day) })), methods: [...methodCounts].map(([method, total]) => ({ method, ...counts(total) })) } : null,
                                    recent: recent ? { heading: tr('copy.recentEvents'), auditHref: mount + '/audit', auditLabel: tr('nav.audit'), events: recent.events.slice(0, 8).map(event => ({ action: event.action, datetime: new Date(event.created).toISOString(), label: new Date(event.created).toISOString().replace('T', ' ').slice(0, 16) })), empty: presentation.textSource('No account activity recorded.') } : null,
                                });
                            }
                            if (path === '/health') {
                                requirePermission(principal, 'auth.health.read');
                                const health = readHealth ? await readHealth() : null;
                                if (wantsJson(request))
                                    return jsonResponse(health || !readHealth ? 200 : 503, { configured: !!readHealth, health });
                                const view = healthScreen({health,configured:!!readHealth,mount,csrf,principal,presentation,query:request.query}); return screenResponse('Service health', view, { ...render(), shell });
                            }
                            if (path === '/cases') {
                                requirePermission(principal, 'auth.cases.read');
                                const result = await service.listCases({ limit: 50, ...(request.query.get('after') ? { after: request.query.get('after')! } : {}) });
                                if (wantsJson(request))
                                    return jsonResponse(200, { ...result, csrf });
                                return screenResponse('Support cases', casesScreen({result,mount,csrf,principal,presentation,query:request.query}), { ...render(), shell });
                            }
                            if (path === '/registrations') {
                                requirePermission(principal, 'auth.users.manage');
                                const result = await service.listRegistrationRequests({ limit: 50, ...(request.query.get('after') ? { after: request.query.get('after')! } : {}) });
                                if (wantsJson(request))
                                    return jsonResponse(200, { ...result, requests: result.requests.map(item => ({ ...item, email: maskEmail(item.email) })), csrf });
                                return screenResponse('Registration requests', registrationsScreen({result,mount,csrf,principal,presentation,query:request.query,canInvite:!!options.sendInvitation}), { ...render(), shell });
                            }
                            if (path === '/users/detail') {
                                requirePermission(principal, 'auth.users.read');
                                const account = await service.getUser(request.query.get('id') || '');
                                if (!account)
                                    throw new AuthHttpError(404, 'Account not found');
                                const activity = hasPermission(principal, 'auth.audit.read') ? await service.listAudit({ limit: 20, subject: account.id }) : undefined;
                                const notes = hasPermission(principal, 'auth.audit.read') ? await service.listAudit({limit:50,subject:account.id,action:'admin.note'}) : undefined;
                                const user = { ...account, email: maskEmail(account.email) }, sessions = hasPermission(principal, 'auth.sessions.manage') ? await service.listSessions(user.id) : undefined;
                                if (wantsJson(request))
                                    return jsonResponse(200, { user, ...(sessions ? { sessions } : {}), ...(activity ? { activity: activity.events } : {}), csrf });
                                return screenResponse('Account details', accountDetail({user,principal,mount,csrf,presentation,...(sessions?{sessions}:{}),...(activity?{activity}:{}),...(notes?{notes}:{}),operations:accounts.enabled(),recovery:recovery.enabled()}), { ...render(), shell });
                            }
                            if (path === '/users') {
                                requirePermission(principal, 'auth.users.read');
                                const result = await service.listUsers(userFilters(request.query)), users = result.users.map(user => ({ ...user, email: maskEmail(user.email) }));
                                if (wantsJson(request))
                                    return jsonResponse(200, { users, ...(result.next ? { next: result.next } : {}), csrf });
                                return screenResponse('Users', userDirectory({users,...(result.next?{next:result.next}:{}),query:request.query,principal,mount,csrf,presentation,canSendSetup:!!options.sendSetup}), { ...render(), shell });
                            }
                            if (path === '/roles') {
                                requirePermission(principal, 'auth.roles.read');
                                const roles = service.getRoles();
                                if (wantsJson(request))
                                    return jsonResponse(200, { roles, csrf });
                                return screenResponse('Roles', rolesScreen({roles,mount,csrf,principal,presentation,query:request.query}), { ...render(), shell });
                            }
                            if (path === '/sessions') {
                                requirePermission(principal, 'auth.sessions.manage');
                                const result = await service.listAllSessions(sessionFilters(request.query));
                                if (wantsJson(request))
                                    return jsonResponse(200, { ...result, sessions: result.sessions.map(session => ({ ...session, ...('email' in session ? { email: maskEmail(String(session.email)) } : {}) })), csrf });
                                return screenResponse('Sessions', sessionsScreen({result,mount,csrf,principal,presentation,query:request.query}), { ...render(), shell });
                            }
                            if (path === '/audit/export') {
                                requirePermission(principal, 'auth.audit.read');
                                requirePermission(principal, 'auth.audit.export');
                                return jsonResponse(200, await exportAuditRange(service, token, request.query), [['content-disposition', 'attachment; filename="audit-range.json"']]);
                            }
                            if (path === '/audit') {
                                requirePermission(principal, 'auth.audit.read');
                                const result = await service.listAudit(auditFilters(request.query));
                                if (wantsJson(request))
                                    return jsonResponse(200, result);
                                return screenResponse('Audit', auditScreen({result,mount,csrf,principal,presentation,query:request.query}), { ...render(), shell });
                            }
                            throw new AuthHttpError(404, 'Not found');
                        }
                        const fields = readFields(request, [...selectedNames(request.body, request.headers.get('content-type')), 'accountIds', 'confirmation', ...userFilterKeys, 'after', 'accountId', 'roles', 'status', 'reason', 'requestId', 'email', 'action', 'caseId', 'sessionId']);
                        http.verify(request, fields);
                        if (!fields.reason?.trim() || fields.reason.length > 256)
                            throw new AuthHttpError(400, 'A reason is required');
                        if (Date.now() - principal.authenticatedAt > 5 * 60 * 1000)
                            throw new AuthHttpError(403, 'Confirm your identity before this action');
                        if (path === '/users/note') {
                            requirePermission(principal, 'auth.users.manage');
                            await service.adminAddNote({actorToken:token,accountId:fields.accountId||'',reason:fields.reason});
                            return wantsJson(request)?jsonResponse(200,{saved:true}):status('Note saved',presentation.textSource('Administrator note saved.'));
                        }
                        if (path === '/users/bulk') {
                            if (!['lock', 'unlock', 'revoke-sessions'].includes(fields.action || ''))
                                throw new AuthHttpError(400, 'Invalid bulk action');
                            const action = fields.action as 'lock' | 'unlock' | 'revoke-sessions';
                            requirePermission(principal, action === 'revoke-sessions' ? 'auth.sessions.manage' : 'auth.users.manage');
                            const accountIds = selectedAccounts(fields);
                            if (fields.confirmation !== action.toUpperCase() + ' ' + accountIds.length)
                                throw new AuthHttpError(400, 'Typed confirmation must match the action and selected count');
                            const result = await service.adminBulk({ actorToken: token, accountIds, action, reason: fields.reason });
                            return wantsJson(request) ? jsonResponse(200, result) : status('Bulk update completed', tr('message.bulkUpdated', { count: result.affected }));
                        }
                        if (path === '/users/export-range') {
                            requirePermission(principal, 'auth.users.export');
                            requirePermission(principal, 'auth.users.read');
                            const filters = new URLSearchParams();
                            for (const key of userFilterKeys) if (fields[key]) filters.set(key, fields[key]);
                            const body = await exportUserRange(service, token, filters, fields.reason || '');
                            const base = jsonResponse(200, {});
                            return { ...base, headers: [...base.headers.filter(([name]) => name !== 'content-type'), ['content-type', 'text/csv; charset=utf-8'], ['content-disposition', 'attachment; filename="accounts-filtered.csv"']] as [string, string][], body };
                        }
                        if (path === '/users/export-page') {
                            requirePermission(principal, 'auth.users.export');
                            requirePermission(principal, 'auth.users.read');
                            const filterValues = new URLSearchParams();
                            for (const key of [...userFilterKeys, 'after'])
                                if (fields[key])
                                    filterValues.set(key, fields[key]);
                            const page = await service.listUsers(userFilters(filterValues));
                            const users = [];
                            for (const user of page.users) {
                                const exported = await service.adminExport({ actorToken: token, accountId: user.id, reason: fields.reason });
                                users.push({ ...exported.user, ...('observedLastSeen' in user ? { observedLastSeen: user.observedLastSeen } : {}) });
                            }
                            const base = jsonResponse(200, {});
                            return { ...base, headers: [...base.headers.filter(([name]) => name !== 'content-type'), ['content-type', 'text/csv; charset=utf-8'], ['content-disposition', 'attachment; filename="accounts-page.csv"'], ...(page.next ? [['x-next-cursor', page.next] as [
                                            string,
                                            string
                                        ]] : [])], body: usersCsv(users) };
                        }
                        if (path === '/users/reveal') {
                            requirePermission(principal, 'auth.users.read');
                            requirePermission(principal, 'auth.users.reveal');
                            const result = await service.adminReveal({ actorToken: token, accountId: fields.accountId || '', reason: fields.reason });
                            return wantsJson(request) ? jsonResponse(200, result) : screen('Account identifier', 'reveal', { idLabel: tr('field.accountId'), id: result.id, emailLabel: tr('copy.email'), email: result.email });
                        }
                        if (path === '/users/export') {
                            requirePermission(principal, 'auth.users.export');
                            return jsonResponse(200, await service.adminExport({ actorToken: token, accountId: fields.accountId || '', reason: fields.reason }), [['content-disposition', 'attachment; filename="account-export.json"']]);
                        }
                        else if (path === '/users/create') {
                            requirePermission(principal, 'auth.users.create');
                            if (!options.sendSetup)
                                throw new AuthHttpError(503, 'Setup delivery unavailable');
                            const created = await service.adminCreateUser({ actorToken: token, email: fields.email || '', reason: fields.reason });
                            await withDeadline(signal => options.sendSetup!({ email: created.user.email, token: created.setupToken, signal }), 5000, 'Setup delivery timeout');
                        }
                        else if (path === '/sessions/revoke-one') {
                            requirePermission(principal, 'auth.sessions.manage');
                            await service.adminRevokeSession({ actorToken: token, sessionId: fields.sessionId || '', reason: fields.reason });
                        }
                        else if (path === '/cases/create') {
                            requirePermission(principal, 'auth.cases.manage');
                            if (!['reset-factors', 'lock', 'unlock', 'roles'].includes(fields.action || ''))
                                throw new AuthHttpError(400, 'Invalid case action');
                            await service.createCase({ actorToken: token, accountId: fields.accountId || '', action: fields.action as 'reset-factors' | 'lock' | 'unlock' | 'roles', ...(fields.roles ? { roles: fields.roles.split(',').map(role => role.trim()).filter(Boolean) } : {}), reason: fields.reason });
                        }
                        else if (path === '/cases/note') {
                            requirePermission(principal, 'auth.cases.manage');
                            await service.addCaseNote({ actorToken: token, caseId: fields.caseId || '', note: fields.reason });
                        }
                        else if (path === '/cases/close') {
                            requirePermission(principal, 'auth.cases.manage');
                            await service.closeCase({ actorToken: token, caseId: fields.caseId || '', reason: fields.reason });
                        }
                        else if (path === '/cases/approve') {
                            requirePermission(principal, 'auth.cases.manage');
                            await service.approveCase({ actorToken: token, caseId: fields.caseId || '', reason: fields.reason });
                        }
                        else if (path === '/impersonate') {
                            requirePermission(principal, 'auth.users.impersonate');
                            if (!options.notifyImpersonation)
                                throw new AuthHttpError(503, 'Impersonation notification is required');
                            const result = await service.createImpersonation({ actorToken: token, accountId: fields.accountId || '', reason: fields.reason });
                            try {
                                await withDeadline(signal => options.notifyImpersonation!({ email: result.user.email, actorId: principal.id, reason: fields.reason!, signal }), 5000, 'Notification timeout');
                            }
                            catch (error) {
                                await service.logout(result.token);
                                throw error;
                            }
                            return jsonResponse(303, { impersonating: true }, [['location', authMount + '/account'], ...http.sessionHeaders(result.token)]);
                        }
                        else if (path === '/registrations/approve') {
                            requirePermission(principal, 'auth.users.manage');
                            const approved = await service.approveRegistration({ actorToken: token, requestId: fields.requestId || '', reason: fields.reason });
                            if (hooks.onRegistrationApproved)
                                await hooks.onRegistrationApproved({ requestId: fields.requestId || '', accountId: approved.id, email: approved.email, actorId: principal.id, reason: fields.reason || '' });
                        }
                        else if (path === '/invitations') {
                            requirePermission(principal, 'auth.users.create');
                            if (!options.sendInvitation)
                                throw new AuthHttpError(503, 'Invitation delivery unavailable');
                            const issued = await service.invite({ actorToken: token, email: fields.email || '' });
                            await withDeadline(signal => options.sendInvitation!({ email: fields.email || '', token: issued.token, signal }), 5000, 'Delivery timeout');
                        }
                        else if (path === '/users/roles') {
                            requirePermission(principal, 'auth.users.manage');
                            const roles = (fields.roles || '').split(',').map(role => role.trim()).filter(Boolean);
                            const accountId = fields.accountId || '';
                            if (hooks.beforeRoleChange) {
                                const current = await service.getUser(accountId);
                                const verdict = await hooks.beforeRoleChange({ accountId, currentRoles: current?.roles ?? [], requestedRoles: roles, actorId: principal.id, reason: fields.reason || '' });
                                if (!verdict?.allow)
                                    throw new AuthHttpError(403, verdict?.reason || 'Role change rejected by project hook');
                            }
                            await service.adminSetRoles({ actorToken: token, accountId, roles, reason: fields.reason });
                        }
                        else if (path === '/users/status') {
                            requirePermission(principal, 'auth.users.manage');
                            if (fields.status !== 'active' && fields.status !== 'locked')
                                throw new AuthHttpError(400, 'Invalid status');
                            await service.adminSetStatus({ actorToken: token, accountId: fields.accountId || '', status: fields.status, reason: fields.reason });
                            if (hooks.onAccountStatusChanged)
                                await hooks.onAccountStatusChanged({ accountId: fields.accountId || '', status: fields.status, actorId: principal.id, reason: fields.reason || '' });
                        }
                        else if (path === '/sessions/revoke') {
                            requirePermission(principal, 'auth.sessions.manage');
                            await service.adminRevokeSessions({ actorToken: token, accountId: fields.accountId || '', reason: fields.reason });
                        }
                        else
                            throw new AuthHttpError(404, 'Not found');
                        return wantsJson(request) ? jsonResponse(200, { updated: true }) : status('Update completed', tr('message.operationCompleted'), mount, presentation.textSource('Return to overview'));
                    }
                    catch (error) {
                        return failureResponse(error, request, render());
                    }
                } };
        } };
}
