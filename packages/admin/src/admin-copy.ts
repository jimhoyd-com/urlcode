import {createPresentation} from '@jimhoyd/urlcode-ui';
import type {PresentationOptions,Presentation,LocalePreferences} from '@jimhoyd/urlcode-ui';
import {createPresentation as createAuthPresentation} from '@jimhoyd/urlcode-auth';
/** Console copy belongs to admin. Shared UI contains no account or operator workflows. */
export const adminCatalogue=Object.freeze({
 'adminUi.activityPeriod':'Last 30 days',
 'adminUi.activityDetails':'View activity totals',
 'adminUi.searchAccounts':'Search accounts',
 'adminUi.searchPlaceholder':'Email, name or account ID',
 'adminUi.createAccount':'Create account',
 'adminUi.sendSetup':'Send setup link',
 'adminUi.exportPage':'Export page (CSV)',
 'adminUi.exportAll':'Export all (CSV)',
 'adminUi.chartDescription':'Thirty UTC days of sign-ups, sign-ins and failed sign-ins. Failed sign-ins use a dashed line. Exact values follow in the daily table.',
 'adminUi.noSessions':'No active sessions match these filters.',
 'adminUi.noAudit':'No audit events match these filters.',
 'adminUi.noCases':'No support cases to review.',
 'adminUi.noRegistrations':'No registration requests are waiting for approval.',
 'adminUi.noNotes':'No administrator notes yet.',
 'adminUi.noActivity':'No account activity recorded.',
 'adminUi.noAlerts':'No alerts reported.',
 'adminUi.noMethods':'No passkeys or external sign-in methods recorded.',
 'adminUi.noRecovery':'No manual recovery cases to review.',
 'adminUi.noGrants':'No additional permissions',
 'adminUi.noTerms':'No consent record is stored for this account.',
 'adminUi.sessionIntro':'Review active sessions. Revoking a session signs that device out.',
 'adminUi.auditIntro':'Review recorded security events. Use filters to narrow the time range or account.',
 'adminUi.rolesIntro':'Review the permissions each role grants. Assign reviewed roles to an account below.',
 'adminUi.methodIntro':'Review sign-in methods before changing account access.',
 'adminUi.auditExport':'Export audit events',
 'adminUi.sessionFilters':'Filter sessions',
 'adminUi.auditFilters':'Filter audit events',
 'adminUi.expires':'Expires',
 'adminUi.device':'Device',
 'adminUi.permissions':'Permissions',
 'adminUi.accountActions':'Account actions',
 'adminUi.revokeExplanation':'The user can sign in again unless their account is locked.',
 'adminUi.resetFilters':'Reset filters',
 'adminUi.advancedFilters':'Advanced filters',
 'adminUi.exportAccounts':'Export accounts',
 'adminUi.noAccounts':'No matching accounts. Try changing your filters.',
 'adminUi.returnOverview':'Return to overview',
 'adminUi.returnUsers':'Back to users',
 'adminUi.reviewCase':'Review case',
 'adminUi.createCase':'Create a support case',
 'adminUi.noteHelp':'Notes are recorded in the audit trail. Do not include credentials or recovery secrets.',
 'adminUi.healthIntro':'Reported observations from this host and its configured integrations.',
 'adminUi.confirmFresh':'Sensitive actions require a recent sign-in and a reason.',
 'adminUi.actor':'Actor account ID',
 'adminUi.subject':'Subject account ID',
 'adminUi.action':'Event action',
 'adminUi.from':'From UTC (YYYY-MM-DDTHH:mmZ)',
 'adminUi.to':'To UTC (YYYY-MM-DDTHH:mmZ)',
 'adminUi.noticeSender':'Notification sender reported a failure.',
 'adminUi.noticeProvider':'A provider credential is approaching expiry.',
 'adminUi.noticePresentation':'The configured presentation needs an update.',
 'adminUi.noticeTranslation':'Some translations are incomplete.',
});
/**
 * Existing auth presentations still work; this factory also makes admin-owned copy translatable.
 * `base` composes an existing presentation (the kit's, which carries the auth catalogue and the
 * project's copy) with the admin catalogue instead of building the auth presentation here. An `adminUi.*`
 * id the base resolves for the request's locale (the project translated it in its copy) wins over the bundled
 * admin English; otherwise the admin catalogue answers.
 */
export function createAdminPresentation(options:Omit<PresentationOptions,'defaults'>&{base?:Presentation|undefined}={}):Presentation {
 const entries=Object.entries(options.catalogues??{});
 const isAdmin=(key:string)=>Object.hasOwn(adminCatalogue,key);
 const {base:given,...rest}=options;
 const base=given??createAuthPresentation({...rest,catalogues:Object.fromEntries(entries.map(([locale,catalogue])=>[locale,Object.fromEntries(Object.entries(catalogue).filter(([key])=>!isAdmin(key)))]))});
 const own=createPresentation({...rest,defaults:adminCatalogue,catalogues:Object.fromEntries(entries.map(([locale,catalogue])=>[locale,Object.fromEntries(Object.entries(catalogue).filter(([key])=>isAdmin(key)))]))});
 const sources=new Map<string,string>(Object.entries(adminCatalogue).map(([key,value])=>[value,key]));
 return Object.freeze({...base,english:Object.freeze({...base.english,...adminCatalogue}),coverage(locale:string){const auth=base.coverage(locale),admin=own.coverage(locale);return {missing:[...auth.missing,...admin.missing.filter(isAdmin)],mismatched:[...auth.mismatched,...admin.mismatched.filter(isAdmin)]};},resolve(preferences?:LocalePreferences){const context=base.resolve(preferences),copy=own.resolve(preferences);const supplied=(key:string)=>Boolean(given)&&context.has(key);return Object.freeze({...context,has(key:string){return isAdmin(key)?copy.has(key):context.has(key);},textSource(source:string){const key=sources.get(source);return key?this.text(key):context.textSource(source);},text(key:string,values?:Readonly<Record<string,string|number>>){return isAdmin(key)?supplied(key)?context.text(key,values):copy.text(key,values):context.text(key,values);}});}});
}
