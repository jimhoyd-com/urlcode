import {escapeHtml,field,icon,hiddenField,postForm} from '@jimhoyd/urlcode-ui';
import type {AuthAccount,AuthCase,AuthSession} from '@jimhoyd/urlcode-auth';
import type {AuditPage} from '@jimhoyd/urlcode-audit';
import type {AdminCopy} from './admin-copy.ts';
import type {AdminHealthSnapshot} from './admin-health.ts';
import {maskEmail,nextPage} from './admin-reporting.ts';
import {markup} from './admin-ui.ts';
import type {Screen} from './admin-ui.ts';
interface Input {mount:string;csrf:string;account:AuthAccount;copy:AdminCopy;query:URLSearchParams}
/** Escaped helpers build the `Markup` slots; plain `text`/`tr` values go into the view and the renderer escapes them. */
function tools(input:Input){
 const text=(source:string)=>input.copy.s(source);
 const tr=(key:string)=>input.copy.t(key);
 const html=(source:string)=>escapeHtml(text(source));
 const url=(path:string)=>escapeHtml(input.mount+path);
 const filter=(name:string,label:string,required=false)=>field({name,label:text(label),required,value:input.query.get(name)||''});
 const form=(path:string,body:string,label:string,destructive=false)=>postForm({action:input.mount+path,csrf:input.csrf,fields:body,label:text(label),destructive,className:'ui-form-grid'});
 const reason=()=>field({name:'reason',label:text('Reason'),description:text('Sensitive actions require a recent sign-in and a reason.')});
 const table=(caption:string,headings:string[],rows:string)=>`<div class="ui-table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(caption)}"><table class="ui-table"><caption>${escapeHtml(caption)}</caption><thead><tr>${headings.map(heading=>`<th scope="col">${escapeHtml(heading)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
 return {text,tr,html,url,filter,form,hidden:hiddenField,reason,table};
}
export function adminTime(value:number|string):string {
 const date=new Date(value);return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(date.toISOString().slice(0,16).replace('T',' '))} UTC</time>`;
}
export function rolesScreen(input:Input&{roles:Readonly<Record<string,readonly string[]>>}):Screen {
 const {text,tr,html,url,form,reason,table}=tools(input);
 const rows=Object.entries(input.roles).map(([name,grants])=>`<tr><th scope="row">${escapeHtml(name)}</th><td>${grants.length?grants.map(grant=>`<code>${escapeHtml(grant)}</code>`).join('<br>'):`<span class="ui-muted">${html('No additional permissions')}</span>`}</td><td>${input.account.has('auth.users.read')?`<a href="${url('/users?role='+encodeURIComponent(name))}">${escapeHtml(tr('admin.nav.users'))}</a>`:''}</td></tr>`).join('');
 return {name:'admin/roles',view:{intro:text('Review the permissions each role grants. Assign reviewed roles to an account below.'),note:tr('admin.copy.roleDefinitionsAreReadOnlyHere'),table:markup(table(tr('admin.nav.roles'),[text('Role name'),text('Permissions'),text('Accounts')],rows)),assign:input.account.has('auth.users.manage')?{heading:text('Assign roles'),form:markup(form('/users/roles',field({name:'accountId',label:text('Account ID')})+field({name:'roles',label:text('Role names separated by commas')})+reason(),'Assign roles'))}:null}};
}
export function sessionsScreen(input:Input&{result:{sessions:(AuthSession&{accountId:string;email:string})[];next?:string}}):Screen {
 const {text,tr,html,url,form,reason,hidden,filter,table}=tools(input);
 const rows=input.result.sessions.map(session=>`<tr><td>${input.account.has('auth.users.read')?`<a href="${url('/users/detail?id='+encodeURIComponent(session.accountId))}">${escapeHtml(maskEmail(session.email))}</a>`:escapeHtml(maskEmail(session.email))}<small class="ui-muted ui-account-id">${escapeHtml(session.accountId)}</small></td><td>${escapeHtml(session.deviceLabel||text('Unknown device'))}</td><td>${adminTime(session.created)}</td><td>${adminTime(session.expires)}</td><td><details><summary>${html('Revoke this session')}</summary><p class="ui-muted">${html('The user can sign in again unless their account is locked.')}</p>${form('/sessions/revoke-one',hidden('sessionId',session.id)+reason(),'Revoke this session',true)}</details></td></tr>`).join('');
 const accountId=input.query.get('accountId');
 const filters=`<form class="ui-form-grid" method="get" action="${url('/sessions')}">${filter('accountId','Account ID')}${filter('device','Device')}${filter('createdFrom','Created from UTC')}${filter('createdTo','Created to UTC')}<div class="ui-actions"><button type="submit">${escapeHtml(tr('admin.action.findSessions'))}</button><a class="ui-button-secondary" href="${url('/sessions')}">${html('Reset filters')}</a></div></form>`;
 return {name:'admin/sessions',view:{filtersHeading:text('Filter sessions'),intro:text('Review active sessions. Revoking a session signs that device out.'),filters:markup(filters),count:input.copy.t('admin.message.sessionsOnPage',{count:input.result.sessions.length}),table:rows?markup(table(tr('admin.nav.sessions'),[text('Account'),text('Device'),text('Created'),text('Expires'),text('Actions')],rows)):null,empty:text('No active sessions match these filters.'),nextHref:input.result.next?nextPage(input.mount+'/sessions',input.query,input.result.next,['accountId','device','createdFrom','createdTo']):null,nextLabel:tr('action.next'),revokeAll:accountId&&input.result.sessions.length?{summary:text('Revoke all sessions'),help:text('The user can sign in again unless their account is locked.'),form:markup(form('/sessions/revoke',hidden('accountId',accountId)+reason(),'Revoke all sessions',true))}:null}};
}
/** The audit log through AuditExports: newest first by default, every source, with the ingest sequence. */
export function auditScreen(input:Input&{result:AuditPage}):Screen {
 const {text,tr,html,url,filter,hidden,table,reason}=tools(input);
 const order=input.query.get('order')==='asc'?'asc':'desc';
 const filters=()=>filter('source','Event source')+filter('actor','Actor account ID')+filter('subject','Subject account ID')+filter('action','Event action')+filter('from','From UTC (YYYY-MM-DDTHH:mmZ)')+filter('to','To UTC (YYYY-MM-DDTHH:mmZ)')+`<label>${html('Order')}<select name="order"><option value="desc"${order==='desc'?' selected':''}>${html('Newest first')}</option><option value="asc"${order==='asc'?' selected':''}>${html('Oldest first')}</option></select></label>`;
 const rows=input.result.events.map(event=>`<tr><td>${adminTime(event.at)}</td><td><code>${escapeHtml(event.source)}</code></td><td><code>${escapeHtml(event.action)}</code></td><td>${escapeHtml(event.actor)}</td><td>${escapeHtml(event.subject)}</td><td><code>${escapeHtml(event.seq)}</code></td></tr>`).join('');
 const form=`<form class="ui-form-grid" method="get" action="${url('/audit')}">${filters()}<div class="ui-actions"><button type="submit">${escapeHtml(tr('admin.copy.filterAudit'))}</button><a class="ui-button-secondary" href="${url('/audit')}">${html('Reset filters')}</a></div></form>`;
 const exportForm=`<form class="ui-form-grid" method="get" action="${url('/audit/export')}">${['source','actor','subject','action'].map(key=>hidden(key,input.query.get(key)||'')).join('')}${filter('from','From UTC (YYYY-MM-DDTHH:mmZ)',true)}${filter('to','To UTC (YYYY-MM-DDTHH:mmZ)',true)}${reason()}<div class="ui-actions"><button class="ui-button-secondary" type="submit">${escapeHtml(tr('admin.action.exportAudit'))}</button></div></form>`;
 return {name:'admin/audit',view:{filtersHeading:text('Filter audit events'),intro:text('Review recorded security events. Use filters to narrow the time range or account.'),filters:markup(form),table:rows?markup(table(tr('admin.copy.recentSecurityEvents'),[tr('admin.copy.time'),text('Source'),tr('admin.copy.action'),tr('admin.copy.actor'),tr('admin.copy.subject'),text('Sequence')],rows)):null,empty:text('No audit events match these filters.'),nextHref:input.result.next?nextPage(input.mount+'/audit',input.query,input.result.next,['source','actor','subject','action','from','to','order']):null,nextLabel:tr('action.next'),export:input.account.has('audit.export')?{summary:markup(icon('download')+`<span>${html('Export audit events')}</span>`),form:markup(exportForm)}:null}};
}
export function healthScreen(input:Input&{health:AdminHealthSnapshot|null;configured:boolean}):Screen {
 const {text,tr,table}=tools(input),health=input.health;
 const base={intro:text('Reported observations from this host and its configured integrations.'),alertsHeading:tr('admin.health.alerts'),noAlerts:text('No alerts reported.')};
 if(!health)return {name:'admin/health',view:{unavailable:input.configured?tr('admin.health.unavailableStatus'):tr('admin.health.unavailable'),...base,facts:[],components:markup(''),alerts:[]}};
 const status=(value:string)=>`<span class="ui-badge" data-status="${escapeHtml(value)}">${escapeHtml(tr('admin.health.'+(value==='unavailable'?'unavailableStatus':value)))}</span>`;
 const components:[string,string][]=[[tr('admin.health.runtime'),health.runtime.status],[tr('admin.health.readiness'),health.runtime.readiness],[tr('admin.health.sender'),health.sender],...health.providers.map(provider=>[tr('admin.health.provider')+': '+provider.id,provider.status] as [string,string])];
 const messages={'sender-failed':'Notification sender reported a failure.','provider-expiring':'A provider credential is approaching expiry.','presentation-outdated':'The configured presentation needs an update.','translation-incomplete':'Some translations are incomplete.'};
 const rows=components.map(([label,value])=>`<tr><th scope="row">${escapeHtml(label)}</th><td>${status(value)}</td></tr>`).join('');
 return {name:'admin/health',view:{unavailable:null,...base,facts:[{term:tr('admin.health.updated'),value:markup(adminTime(health.checkedAt))},{term:tr('admin.health.version'),value:markup(`<code>${escapeHtml(health.runtime.version)}</code>`)},{term:tr('admin.health.routes'),value:markup(escapeHtml(input.copy.t('admin.number.value',{value:health.runtime.routes})))}],components:markup(table(tr('admin.health.component'),[tr('admin.health.component'),tr('admin.health.status')],rows)),alerts:health.alerts.map(alert=>text(messages[alert]))}};
}
export function casesScreen(input:Input&{result:{cases:AuthCase[];next?:string}}):Screen {
 const {text,tr,html,form,hidden,reason}=tools(input),manage=input.account.has('auth.cases.manage');
 const cases=input.result.cases.map(item=>({action:item.action,status:item.status,accountId:item.accountId,reason:item.reason,notes:(item.notes??[]).map(note=>({note:note.note,actorId:note.actorId})),actions:markup((manage?`<details><summary>${html('Add note')}</summary>${form('/cases/note',hidden('caseId',item.id)+reason(),'Add note')}</details>`:'')+(manage&&item.status==='pending'?`<details><summary>${html('Close without applying')}</summary>${form('/cases/close',hidden('caseId',item.id)+reason(),'Close without applying')}</details>`:'')+(manage&&item.status==='pending'&&item.makerId!==input.account.id?`<details class="ui-danger-zone"><summary>${html('Approve and apply')}</summary>${form('/cases/approve',hidden('caseId',item.id)+reason(),'Approve and apply',true)}</details>`:''))}));
 const actions=['reset-factors','lock','unlock','roles'];
 return {name:'admin/cases',view:{accountLabel:text('Account ID'),reasonLabel:text('Reason'),cases,empty:text('No support cases to review.'),create:manage?{summary:text('Create a support case'),form:markup(form('/cases/create',field({name:'accountId',label:text('Account ID')})+`<label>${html('Action: reset-factors, lock, unlock or roles')}<select name="action">${actions.map(action=>`<option value="${action}">${escapeHtml(action)}</option>`).join('')}</select></label>`+field({name:'roles',label:text('Roles (for roles action)'),required:false})+reason(),'Create case for a second administrator'))}:null,nextHref:input.result.next?input.mount+'/cases?after='+encodeURIComponent(input.result.next):null,nextLabel:tr('action.next')}};
}
export function registrationsScreen(input:Input&{result:{requests:{id:string;email:string;created:number}[];next?:string};canInvite:boolean}):Screen {
 const {text,tr,form,hidden,reason}=tools(input);
 return {name:'admin/registrations',view:{requests:input.result.requests.map(item=>({email:maskEmail(item.email),form:markup(form('/registrations/approve',hidden('requestId',item.id)+reason(),'Approve account'))})),empty:text('No registration requests are waiting for approval.'),nextHref:input.result.next?input.mount+'/registrations?after='+encodeURIComponent(input.result.next):null,nextLabel:tr('action.next'),invite:input.canInvite&&input.account.has('auth.users.create')?{heading:text('Send invitation'),form:markup(form('/invitations',field({name:'email',label:text('Email address'),type:'email'})+reason(),'Send invitation'))}:null}};
}
