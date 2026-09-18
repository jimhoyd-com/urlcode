import {rolesScreen,sessionsScreen,auditScreen,healthScreen,casesScreen,registrationsScreen} from './admin-screens.ts';
import {createAdminPresentation} from './admin-copy.ts';
import {userDirectory} from './admin-users.ts';
import {adminPage as renderPage} from './admin-presentation.ts';
import {escapeHtml,icon} from '@jimhoyd/urlcode-ui';
import type {IconName} from '@jimhoyd/urlcode-ui';
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
import { maskEmail, sessionFilters, userFilters, userFilterKeys, auditFilters, nextPage, selectedNames, selectedAccounts, usersCsv } from './admin-reporting.ts';
import type { RuntimeExtension, ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import type { AuthService, AuthPrincipal, Presentation } from '@jimhoyd/urlcode-auth';
import { AuthHttp, AuthHttpError, csrfField, formField as baseField, httpFailure, jsonResponse, readFields, wantsJson, hasPermission } from '@jimhoyd/urlcode-auth';
export interface AdminExtensionOptions {
    sendAccountAdministration?:(message:AdminAccountDelivery&{signal:AbortSignal})=>Promise<void>;
    sendRecovery?: (message: ManualRecoveryDelivery) => Promise<void>;
    presentation?: Presentation;
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
const schema = { type: 'object', additionalProperties: false, properties: {} };
const permissions = ['auth.users.reveal', 'auth.audit.export', 'auth.health.read', 'auth.cases.read', 'auth.cases.manage', 'auth.users.impersonate', 'auth.users.export', 'auth.users.create', 'auth.users.read', 'auth.users.manage', 'auth.audit.read', 'auth.sessions.manage', 'auth.roles.read'];
const masked = maskEmail;
function renderForm(action: string, csrf: string, fields: string, label: string): string { return `<form class="ui-form-grid" method="post" action="${escapeHtml(action)}">${csrfField(csrf)}${fields}<button type="submit">${escapeHtml(label)}</button></form>`; }
const form = renderForm, formField = baseField;
export function adminExtension(options: AdminExtensionOptions): RuntimeExtension {
    const authMount = options.authMount || '/account';
    if (!/^\/[A-Za-z0-9/_-]*$/.test(authMount) || authMount.includes('//'))
        throw new Error('Invalid auth mount');
    return { name: 'admin', version: '1', projectSha256: options.projectSha256, targets: ['node'], schema, credentialHeaders: ['cookie', 'authorization', 'x-csrf-token'],
        activate(_config, context) {
            if (context.mounts.length !== 1)
                throw new Error('Admin requires exactly one mount');
            const readHealth = options.health ? createHealthReader(options.health) : undefined;
            const mount = context.mounts[0]!, http = new AuthHttp({ origin: context.origin, csrfKey: options.csrfKey }), service = options.service;
            const accounts=createAdminAccount({service,...(options.sendAccountAdministration?{sendAccountAdministration:options.sendAccountAdministration}:{})},http,mount);
            const recovery = createAdminRecovery({ service, ...(options.sendRecovery ? { sendRecovery: options.sendRecovery } : {}) }, http, mount);
            function requirePermission(principal: AuthPrincipal, permission: string): void {
                if (!hasPermission(principal, permission))
                    throw new AuthHttpError(403, 'Permission required');
            }
            function navigation(principal: AuthPrincipal, text: (source: string) => string, tr: (key: string) => string, current: string): string {
                const link = (path:string,label:string,symbol:IconName) => `<a class="ui-nav-link" href="${escapeHtml(mount+path)}"${(path==='/'?(current==='/'||current==='/dashboard'):current===path||current.startsWith(path+'/'))?' aria-current="page"':''}>${icon(symbol)}<span>${label}</span></a>`;
                const contents=`<nav aria-label="${tr('page.admin')}">${link('/',tr('nav.overview'),'home')}${([['users','Users','auth.users.read','users'],['sessions','Sessions','auth.sessions.manage','monitor'],['registrations','Registration','auth.users.manage','mail'],['roles','Roles','auth.roles.read','shield'],['audit','Audit','auth.audit.read','list'],['cases','Cases','auth.cases.read','circle-alert'],['health','Service health','auth.health.read','activity']] as const).filter(([_path,_label,permission])=>hasPermission(principal,permission!)).map(([path,label,,symbol])=>link('/'+path,escapeHtml(text(label)),symbol)).join('')}${accounts.enabled()&&hasPermission(principal,'auth.users.manage')?link('/account-operations',tr('adminOps.title'),'settings'):''}${recovery.enabled()&&hasPermission(principal,'auth.cases.read')?link('/recovery-cases',tr('manualRecovery.title'),'key'):''}</nav><div class="ui-sidebar-footer"><a class="ui-nav-link" href="${escapeHtml(authMount+'/account')}">${icon('user')}<span>${tr('nav.account')}</span></a><a class="ui-nav-link" href="${escapeHtml(authMount+'/step-up')}">${icon('lock')}<span>${tr('action.confirm')}</span></a></div>`;
                return `<aside class="ui-sidebar"><a class="ui-brand" href="${escapeHtml(mount)}"><span aria-hidden="true">U</span><strong>URLCode</strong></a><div class="ui-desktop-navigation"><p class="ui-muted">${tr('page.admin')}</p>${contents}</div><details class="ui-mobile-navigation"><summary>${icon('list')}<span>${tr('page.admin')}</span></summary>${contents}</details></aside>`;
            }
            return { async handle(request: ExtensionRequest) {
                    let presentation = (options.presentation ?? defaultPresentation).resolve({ ...(request.query.get('lang') ? { queryLocale: request.query.get('lang')! } : {}), ...(request.headers.get('accept-language') ? { acceptLanguage: request.headers.get('accept-language')! } : {}) });
                    const tr = (key: string, values?: Readonly<Record<string, string | number>>) => escapeHtml(presentation.text(key, values));
                    const pageResponse = (...args: Parameters<typeof renderPage>) => renderPage(...[args[0], args[1], args[2], args[3], args[4], presentation] as Parameters<typeof renderPage>);
                    const formField = (name: string, label: string, type = 'text', autocomplete = 'off', required = true) => baseField(name, presentation?.textSource(label) ?? label, type, autocomplete, required);
                    const form = (action: string, csrf: string, fields: string, button: string) => renderForm(action, csrf, fields, presentation?.textSource(button) ?? button);
                    try {
                        const token = http.session(request), principal = token ? await service.authenticate(token) : null;
                        if (!token || !principal || principal.impersonatorId || !permissions.some(permission => hasPermission(principal, permission)))
                            throw new AuthHttpError(404, 'Not found');
                        const accountLocale = (await service.getUser(principal.id))?.profile?.locale;
                        if (accountLocale)
                            presentation = (options.presentation ?? defaultPresentation).resolve({ accountLocale, ...(request.query.get('lang') ? { queryLocale: request.query.get('lang')! } : {}), ...(request.headers.get('accept-language') ? { acceptLanguage: request.headers.get('accept-language')! } : {}) });
                        const path = request.path.slice(mount.length) || '/';
                        if (!['GET', 'HEAD', 'POST'].includes(request.method))
                            return jsonResponse(405, { error: 'Method not allowed' }, [['allow', 'GET, HEAD, POST']]);
                        const csrf = http.token(token), nav = navigation(principal, source => presentation?.textSource(source) ?? source, tr, path);
                        const accountResult=await accounts.handle(request,principal,token,presentation,nav);if(accountResult)return accountResult;
                        const recoveryResult = await recovery.handle(request, principal, token, presentation, nav);
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
                                return wantsJson(request) ? jsonResponse(200, { permissions: granted, csrf, ...(users ? { accounts: stats, accountsShown: users.users.length, moreAccounts: !!users.next } : {}), ...(recent ? { recentEvents: recent.events } : {}) }) : pageResponse('Administration', nav + (hasPermission(principal, 'auth.users.impersonate') && options.notifyImpersonation ? `<details class="ui-card ui-danger-zone"><summary>${escapeHtml(presentation.textSource('Start ten-minute support impersonation'))}</summary>`+form(mount + '/impersonate', csrf, formField('accountId', 'Account ID') + formField('reason', 'Reason'), 'Start ten-minute support impersonation')+'</details>' : '') + `<p class="ui-muted">${tr("copy.selectASectionOnlyPermittedOperationsAreShownConfigurationRemainsInVersionControlledProjectFiles")}</p>` + (stats ? dashboardSummary(stats,mount,principal,presentation) : '') + (stats ? `<details class="ui-card"><summary id="daily-heading">${tr("copy.authenticationActivityLast30UTCDays")}</summary><p class="ui-muted">${tr("copy.recordedAccountCreationsSuccessfulSignInsAndFailedSignInsTheseFiguresDescribeAuthenticationActivityDeploymentH")}</p><div class="ui-table-wrap" tabindex="0" role="region" aria-label="${tr("copy.dailyAuthenticationCounts")}"><table class="ui-table"><caption>${tr("copy.dailyAuthenticationCounts")}</caption><thead><tr><th scope="col">${tr("copy.uTCDay")}</th><th scope="col">${tr("copy.signUps")}</th><th scope="col">${tr("copy.signIns")}</th><th scope="col">${tr("copy.failedSignIns")}</th></tr></thead><tbody>${stats.daily.map(day => `<tr><th scope="row">${escapeHtml(day.day)}</th><td>${tr('number.value', { value: day.signUps })}</td><td>${tr('number.value', { value: day.signIns })}</td><td>${tr('number.value', { value: day.failedSignIns })}</td></tr>`).join('')}</tbody></table></div><div class="ui-table-wrap" tabindex="0" role="region" aria-label="${tr("copy.authenticationMethodsOverTheSame30Days")}"><table class="ui-table"><caption>${tr("copy.authenticationMethodsOverTheSame30Days")}</caption><thead><tr><th scope="col">${tr("copy.method")}</th><th scope="col">${tr("copy.signUps")}</th><th scope="col">${tr("copy.signIns")}</th><th scope="col">${tr("copy.failedSignIns")}</th></tr></thead><tbody>${[...methodCounts].map(([method, total]) => `<tr><th scope="row">${escapeHtml(method)}</th><td>${tr('number.value', { value: total.signUps })}</td><td>${tr('number.value', { value: total.signIns })}</td><td>${tr('number.value', { value: total.failedSignIns })}</td></tr>`).join('')}</tbody></table></div></details>` : '') + (recent ? `<section class="ui-card"><div class="ui-section-heading"><h2>${tr("copy.recentEvents")}</h2><a href="${escapeHtml(mount+'/audit')}">${tr('nav.audit')}</a></div><ul class="ui-activity">${recent.events.slice(0,8).map(event => `<li><span>${escapeHtml(event.action)}</span><time class="ui-muted" datetime="${escapeHtml(new Date(event.created).toISOString())}">${escapeHtml(new Date(event.created).toISOString().replace('T',' ').slice(0,16))} UTC</time></li>`).join('')||`<li class="ui-empty">${escapeHtml(presentation.textSource('No account activity recorded.'))}</li>`}</ul></section>` : ''));
                            }
                            if (path === '/health') {
                                requirePermission(principal, 'auth.health.read');
                                const health = readHealth ? await readHealth() : null;
                                if (wantsJson(request))
                                    return jsonResponse(health || !readHealth ? 200 : 503, { configured: !!readHealth, health });
                                return pageResponse('Service health', nav + healthScreen({health,configured:!!readHealth,mount,csrf,principal,presentation,query:request.query}));
                            }
                            if (path === '/cases') {
                                requirePermission(principal, 'auth.cases.read');
                                const result = await service.listCases({ limit: 50, ...(request.query.get('after') ? { after: request.query.get('after')! } : {}) });
                                if (wantsJson(request))
                                    return jsonResponse(200, { ...result, csrf });
                                return pageResponse('Support cases', nav + casesScreen({result,mount,csrf,principal,presentation,query:request.query}));
                            }
                            if (path === '/registrations') {
                                requirePermission(principal, 'auth.users.manage');
                                const result = await service.listRegistrationRequests({ limit: 50, ...(request.query.get('after') ? { after: request.query.get('after')! } : {}) });
                                if (wantsJson(request))
                                    return jsonResponse(200, { ...result, requests: result.requests.map(item => ({ ...item, email: masked(item.email) })), csrf });
                                return pageResponse('Registration requests', nav + registrationsScreen({result,mount,csrf,principal,presentation,query:request.query,canInvite:!!options.sendInvitation}));
                            }
                            if (path === '/users/detail') {
                                requirePermission(principal, 'auth.users.read');
                                const account = await service.getUser(request.query.get('id') || '');
                                if (!account)
                                    throw new AuthHttpError(404, 'Account not found');
                                const activity = hasPermission(principal, 'auth.audit.read') ? await service.listAudit({ limit: 20, subject: account.id }) : undefined;
                                const notes = hasPermission(principal, 'auth.audit.read') ? await service.listAudit({limit:50,subject:account.id,action:'admin.note'}) : undefined;
                                const user = { ...account, email: masked(account.email) }, sessions = hasPermission(principal, 'auth.sessions.manage') ? await service.listSessions(user.id) : undefined;
                                if (wantsJson(request))
                                    return jsonResponse(200, { user, ...(sessions ? { sessions } : {}), ...(activity ? { activity: activity.events } : {}), csrf });
                                return pageResponse('Account details', nav + accountDetail({user,principal,mount,csrf,presentation,...(sessions?{sessions}:{}),...(activity?{activity}:{}),...(notes?{notes}:{}),operations:accounts.enabled(),recovery:recovery.enabled()}));
                            }
                            if (path === '/users') {
                                requirePermission(principal, 'auth.users.read');
                                const result = await service.listUsers(userFilters(request.query)), users = result.users.map(user => ({ ...user, email: masked(user.email) }));
                                if (wantsJson(request))
                                    return jsonResponse(200, { users, ...(result.next ? { next: result.next } : {}), csrf });
                                return pageResponse('Users', nav + userDirectory({users,...(result.next?{next:result.next}:{}),query:request.query,principal,mount,csrf,presentation,canSendSetup:!!options.sendSetup}));
                            }
                            if (path === '/roles') {
                                requirePermission(principal, 'auth.roles.read');
                                const roles = service.getRoles();
                                if (wantsJson(request))
                                    return jsonResponse(200, { roles, csrf });
                                return pageResponse('Roles', nav + rolesScreen({roles,mount,csrf,principal,presentation,query:request.query}));
                            }
                            if (path === '/sessions') {
                                requirePermission(principal, 'auth.sessions.manage');
                                const accountId = request.query.get('accountId');
                                const result = await service.listAllSessions(sessionFilters(request.query));
                                if (wantsJson(request))
                                    return jsonResponse(200, { ...result, sessions: result.sessions.map(session => ({ ...session, ...('email' in session ? { email: masked(String(session.email)) } : {}) })), csrf });
                                return pageResponse('Sessions', nav + sessionsScreen({result,mount,csrf,principal,presentation,query:request.query}));
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
                                return pageResponse('Audit', nav + auditScreen({result,mount,csrf,principal,presentation,query:request.query}));
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
                            return wantsJson(request)?jsonResponse(200,{saved:true}):pageResponse('Note saved',nav+`<p>${escapeHtml(presentation.textSource('Administrator note saved.'))}</p>`);
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
                            return wantsJson(request) ? jsonResponse(200, result) : pageResponse('Bulk update completed', nav + `<p>${tr('message.bulkUpdated', { count: result.affected })}</p>`);
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
                            return wantsJson(request) ? jsonResponse(200, result) : pageResponse('Account identifier', nav + `<dl><dt>${tr('field.accountId')}</dt><dd>${escapeHtml(result.id)}</dd><dt>${tr('copy.email')}</dt><dd>${escapeHtml(result.email)}</dd></dl>`);
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
                            const controller = new AbortController();
                            let timer: ReturnType<typeof setTimeout> | undefined;
                            try {
                                await Promise.race([options.sendSetup({ email: created.user.email, token: created.setupToken, signal: controller.signal }), new Promise<void>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Setup delivery timeout')); }, 5000); })]);
                            }
                            finally {
                                if (timer)
                                    clearTimeout(timer);
                            }
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
                            const controller = new AbortController();
                            let timer: ReturnType<typeof setTimeout> | undefined;
                            try {
                                await Promise.race([options.notifyImpersonation({ email: result.user.email, actorId: principal.id, reason: fields.reason, signal: controller.signal }), new Promise<void>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Notification timeout')); }, 5000); })]);
                            }
                            catch (error) {
                                await service.logout(result.token);
                                throw error;
                            }
                            finally {
                                if (timer)
                                    clearTimeout(timer);
                            }
                            return jsonResponse(303, { impersonating: true }, [['location', authMount + '/account'], ...http.sessionHeaders(result.token)]);
                        }
                        else if (path === '/registrations/approve') {
                            requirePermission(principal, 'auth.users.manage');
                            await service.approveRegistration({ actorToken: token, requestId: fields.requestId || '', reason: fields.reason });
                        }
                        else if (path === '/invitations') {
                            requirePermission(principal, 'auth.users.create');
                            if (!options.sendInvitation)
                                throw new AuthHttpError(503, 'Invitation delivery unavailable');
                            const issued = await service.invite({ actorToken: token, email: fields.email || '' });
                            const controller = new AbortController();
                            let timer: ReturnType<typeof setTimeout> | undefined;
                            try {
                                await Promise.race([options.sendInvitation({ email: fields.email || '', token: issued.token, signal: controller.signal }), new Promise<void>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Delivery timeout')); }, 5000); })]);
                            }
                            finally {
                                if (timer)
                                    clearTimeout(timer);
                            }
                        }
                        else if (path === '/users/roles') {
                            requirePermission(principal, 'auth.users.manage');
                            const roles = (fields.roles || '').split(',').map(role => role.trim()).filter(Boolean);
                            await service.adminSetRoles({ actorToken: token, accountId: fields.accountId || '', roles, reason: fields.reason });
                        }
                        else if (path === '/users/status') {
                            requirePermission(principal, 'auth.users.manage');
                            if (fields.status !== 'active' && fields.status !== 'locked')
                                throw new AuthHttpError(400, 'Invalid status');
                            await service.adminSetStatus({ actorToken: token, accountId: fields.accountId || '', status: fields.status, reason: fields.reason });
                        }
                        else if (path === '/sessions/revoke') {
                            requirePermission(principal, 'auth.sessions.manage');
                            await service.adminRevokeSessions({ actorToken: token, accountId: fields.accountId || '', reason: fields.reason });
                        }
                        else
                            throw new AuthHttpError(404, 'Not found');
                        return wantsJson(request) ? jsonResponse(200, { updated: true }) : pageResponse('Update completed', nav + `<section class="ui-card"><p role="status">${tr("message.operationCompleted")}</p><a class="ui-button-secondary" href="${escapeHtml(mount)}">${escapeHtml(presentation.textSource('Return to overview'))}</a></section>`);
                    }
                    catch (error) {
                        return httpFailure(error, request, presentation);
                    }
                } };
        } };
}
