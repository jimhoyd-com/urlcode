/**
 * The console screens as kit templates, under the `admin` namespace. A
 * template only places a view model the extension computes: every value is
 * escaped by the renderer, and the `Markup` slots (forms with their CSRF
 * field, table rows, charts, icons) are built by trusted package code. A
 * project may shadow any of these by name; it cannot change a flow, what a
 * form validates, which permission gates a control, what is escaped or what
 * a page sends in headers.
 */
import {Markup} from '@jimhoyd/urlcode-ui';
import type {ExtensionTemplates,ViewModel} from '@jimhoyd/urlcode-ui';
export interface AdminTemplate {readonly source:string;readonly sample:ViewModel}
const m=(html:string)=>new Markup(html);
const declare=(name:string,body:string)=>`{{!-- viewModel: admin/${name}@1 --}}${body}`;
const form=()=>m('<form method="post"></form>');
const next='{{#if nextHref}}<p><a class="ui-button-secondary" href="{{href nextHref}}">{{nextLabel}}</a></p>{{/if}}';
const empty=(key:string)=>`<section class="ui-card"><p class="ui-empty">{{${key}}}</p></section>`;
const counts='<td>{{signUps}}</td><td>{{signIns}}</td><td>{{failedSignIns}}</td>';
const activityTable=(caption:string,rows:string,first:string,key:string)=>`<div class="ui-table-wrap" tabindex="0" role="region" aria-label="{{activity.${caption}}}"><table class="ui-table"><caption>{{activity.${caption}}}</caption><thead><tr><th scope="col">{{activity.${first}}}</th><th scope="col">{{activity.signUps}}</th><th scope="col">{{activity.signIns}}</th><th scope="col">{{activity.failedSignIns}}</th></tr></thead><tbody>{{#each activity.${rows}}}<tr><th scope="row">{{${key}}}</th>${counts}</tr>{{/each}}</tbody></table></div>`;
const screens:Record<string,{body:string;sample:ViewModel}>={
 dashboard:{
  body:`{{#if impersonation}}<details class="ui-card ui-danger-zone"><summary>{{impersonation.summary}}</summary>{{impersonation.form}}</details>{{/if}}{{#if summary}}{{summary}}{{/if}}{{#if activity}}<details class="ui-card"><summary id="daily-heading">{{activity.heading}}</summary>${activityTable('dailyCaption','days','dayHeading','day')}${activityTable('methodsCaption','methods','methodHeading','method')}</details>{{/if}}{{#if recent}}<section class="ui-card"><div class="ui-section-heading"><h2>{{recent.heading}}</h2><a href="{{href recent.auditHref}}">{{recent.auditLabel}}</a></div><ul class="ui-activity">{{#if recent.events}}{{#each recent.events}}<li><span>{{action}}</span><time class="ui-muted" datetime="{{datetime}}">{{label}} UTC</time></li>{{/each}}{{else}}<li class="ui-empty">{{recent.empty}}</li>{{/if}}</ul></section>{{/if}}`,
  sample:{impersonation:{summary:'Start ten-minute support impersonation',form:form()},intro:'Select a section.',summary:m('<div class="ui-metrics"></div>'),activity:{heading:'Authentication activity, last 30 UTC days',description:'Recorded account creations, sign-ins and failed sign-ins.',dailyCaption:'Daily authentication counts',methodsCaption:'Authentication methods over the same 30 days',dayHeading:'UTC day',methodHeading:'Method',signUps:'Sign-ups',signIns:'Sign-ins',failedSignIns:'Failed sign-ins',days:[{day:'2030-01-01',signUps:'1',signIns:'2',failedSignIns:'0'}],methods:[{method:'password',signUps:'1',signIns:'2',failedSignIns:'0'}]},recent:{heading:'Recent events',auditHref:'/admin/audit',auditLabel:'Audit',events:[{action:'session.created',datetime:'2030-01-01T00:00:00.000Z',label:'2030-01-01 00:00'}],empty:'No account activity recorded.'}},
 },
 users:{
  body:`{{#if setup}}<details class="ui-card"><summary>{{setup.summary}}</summary>{{setup.form}}</details>{{/if}}<section class="ui-card ui-filter-card">{{filters}}</section><section class="ui-card"><div class="ui-section-heading"><span class="ui-muted">{{caption}}</span><span class="ui-badge">{{count}}</span></div><div class="ui-table-wrap" tabindex="0" role="region" aria-label="{{caption}}"><table class="ui-table"><caption class="ui-sr-only">{{caption}}</caption><thead><tr><th scope="col">{{columns.select}}</th><th scope="col">{{columns.account}}</th><th scope="col">{{columns.status}}</th><th scope="col">{{columns.lastSeen}}</th><th scope="col">{{columns.roles}}</th><th scope="col">{{columns.actions}}</th></tr></thead><tbody>{{#if rows}}{{rows}}{{else}}<tr><td colspan="6" class="ui-empty">{{empty}}</td></tr>{{/if}}</tbody></table></div><p class="ui-muted">{{caveat}}</p>{{#if nextHref}}<div class="ui-toolbar"><a class="ui-button" href="{{href nextHref}}">{{nextLabel}}</a></div>{{/if}}</section>{{#if bulk}}<details class="ui-card"><summary>{{bulk.summary}}</summary>{{bulk.form}}</details>{{/if}}{{#if exports}}<details class="ui-card"><summary>{{exports.summary}}</summary><div class="ui-form-grid">{{exports.forms}}</div></details>{{/if}}`,
  sample:{setup:{summary:'Create account and send setup link',form:form()},filters:m('<form method="get"></form>'),heading:'Users',count:'1',caption:'Accounts (email addresses masked)',columns:{select:'Select',account:'Account',status:'Status',lastSeen:'Last seen',roles:'Roles',actions:'Actions'},rows:m('<tr><td></td><td>a***@example.test</td><td>active</td><td>—</td><td></td><td></td></tr>'),empty:'No matching accounts. Try changing your filters.',caveat:'Activity data begins when the feature is activated.',nextHref:'/admin/users?after=cursor',nextLabel:'Next',bulk:{summary:'Bulk action',form:form()},exports:{summary:m('<span>Export accounts</span>'),forms:form()}},
 },
 'user-detail':{
  body:`<div class="ui-toolbar"><a href="{{href backHref}}">{{backIcon}}<span>{{backLabel}}</span></a><span class="ui-badge">{{status}}</span></div><nav class="ui-toolbar" aria-label="{{sectionsLabel}}">{{#each sections}}<a href="{{href href}}">{{label}}</a>{{/each}}</nav>{{#each panels}}<section class="ui-card" id="detail-{{id}}" aria-labelledby="heading-{{id}}"><h2 id="heading-{{id}}">{{heading}}</h2>{{content}}</section>{{/each}}`,
  sample:{backHref:'/admin/users',backIcon:m('<svg aria-hidden="true"></svg>'),backLabel:'Back to users',status:'active',sectionsLabel:'Account sections',sections:[{href:'#detail-overview',label:'Overview'}],panels:[{id:'overview',heading:'Overview',content:m('<dl></dl>')}]},
 },
 sessions:{
  body:`<section class="ui-card ui-filter-card">{{filters}}</section><section class="ui-card"><p class="ui-muted">{{count}}</p>{{#if table}}{{table}}{{else}}<p class="ui-empty">{{empty}}</p>{{/if}}${next}</section>{{#if revokeAll}}<details class="ui-card ui-danger-zone"><summary>{{revokeAll.summary}}</summary><p class="ui-muted">{{revokeAll.help}}</p>{{revokeAll.form}}</details>{{/if}}`,
  sample:{filtersHeading:'Filter sessions',intro:'Review active sessions. Revoking a session signs that device out.',filters:m('<form method="get"></form>'),count:'1 session on this page',table:m('<div class="ui-table-wrap"></div>'),empty:'No active sessions match these filters.',nextHref:null,nextLabel:'Next',revokeAll:{summary:'Revoke all sessions',help:'The user can sign in again unless their account is locked.',form:form()}},
 },
 roles:{
  body:`<section class="ui-card">{{table}}<p class="ui-muted">{{note}}</p></section>{{#if assign}}<section class="ui-card"><h2>{{assign.heading}}</h2>{{assign.form}}</section>{{/if}}`,
  sample:{intro:'Review the permissions each role grants. Assign reviewed roles to an account below.',note:'Role definitions are read-only here.',table:m('<div class="ui-table-wrap"></div>'),assign:{heading:'Assign roles',form:form()}},
 },
 audit:{
  body:`<section class="ui-card ui-filter-card">{{filters}}</section><section class="ui-card">{{#if table}}{{table}}{{else}}<p class="ui-empty">{{empty}}</p>{{/if}}${next}</section>{{#if export}}<details class="ui-card"><summary>{{export.summary}}</summary>{{export.form}}</details>{{/if}}`,
  sample:{filtersHeading:'Filter audit events',intro:'Review recorded security events. Use filters to narrow the time range or account.',filters:m('<form method="get"></form>'),table:m('<div class="ui-table-wrap"></div>'),empty:'No audit events match these filters.',nextHref:null,nextLabel:'Next',export:{summary:m('<span>Export audit events</span>'),form:m('<form method="get"></form>')}},
 },
 health:{
  body:`{{#if unavailable}}${empty('unavailable')}{{else}}<section class="ui-card"><dl class="ui-definition-grid">{{#each facts}}<dt>{{term}}</dt><dd>{{value}}</dd>{{/each}}</dl></section><section class="ui-card">{{components}}</section><section class="ui-card"><h2>{{alertsHeading}}</h2>{{#if alerts}}<ul class="ui-list">{{#each alerts}}<li>{{this}}</li>{{/each}}</ul>{{else}}<p class="ui-empty">{{noAlerts}}</p>{{/if}}</section>{{/if}}`,
  sample:{unavailable:null,intro:'Reported observations from this host and its configured integrations.',facts:[{term:'Runtime version',value:m('<code>1.0.0</code>')}],components:m('<div class="ui-table-wrap"></div>'),alertsHeading:'Alerts',alerts:['Notification sender reported a failure.'],noAlerts:'No alerts reported.'},
 },
 cases:{
  body:`{{#if cases}}<ul class="ui-list">{{#each cases}}<li class="ui-card"><div class="ui-section-heading"><h2><code>{{action}}</code></h2><span class="ui-badge">{{status}}</span></div><dl class="ui-definition-grid"><dt>{{accountLabel}}</dt><dd>{{accountId}}</dd><dt>{{reasonLabel}}</dt><dd>{{reason}}</dd></dl>{{#if notes}}<ul class="ui-list">{{#each notes}}<li><p>{{note}}</p><small class="ui-muted">{{actorId}}</small></li>{{/each}}</ul>{{/if}}{{actions}}</li>{{/each}}</ul>{{else}}${empty('empty')}{{/if}}{{#if create}}<details class="ui-card"><summary>{{create.summary}}</summary>{{create.form}}</details>{{/if}}${next}`,
  sample:{accountLabel:'Account ID',reasonLabel:'Reason',cases:[{action:'unlock',status:'pending',accountId:'account',reason:'Restore access with review',notes:[{note:'Checked with the account holder.',actorId:'actor'}],actions:m('<details></details>')}],empty:'No support cases to review.',create:{summary:'Create a support case',form:form()},nextHref:null,nextLabel:'Next'},
 },
 registrations:{
  body:`{{#if requests}}<ul class="ui-list">{{#each requests}}<li class="ui-card"><h2>{{email}}</h2>{{form}}</li>{{/each}}</ul>{{else}}${empty('empty')}{{/if}}${next}{{#if invite}}<section class="ui-card"><h2>{{invite.heading}}</h2>{{invite.form}}</section>{{/if}}`,
  sample:{requests:[{email:'a***@example.test',form:form()}],empty:'No registration requests are waiting for approval.',nextHref:null,nextLabel:'Next',invite:{heading:'Send invitation',form:form()}},
 },
 'recovery-cases':{
  body:`<p class="ui-muted">{{intro}}</p>{{#if cases}}<ul class="ui-list">{{#each cases}}<li class="ui-card"><h2><code>{{id}}</code></h2><dl class="ui-definition-grid">{{#each facts}}<dt>{{term}}</dt><dd>{{value}}</dd>{{/each}}</dl><p>{{reason}}</p><ul>{{#each notes}}<li>{{actor}}: {{note}}</li>{{/each}}</ul>{{forms}}</li>{{/each}}</ul>{{else}}${empty('empty')}{{/if}}{{#if create}}<details class="ui-card"><summary>{{create.summary}}</summary>{{create.form}}</details>{{/if}}{{#if nextHref}}<a href="{{href nextHref}}">{{nextLabel}}</a>{{/if}}`,
  sample:{intro:'Manual recovery requires independent assessment of the evidence.',cases:[{id:'case',facts:[{term:'Account',value:'account'}],reason:'Lost every factor',notes:[{actor:'actor',note:'Reviewed the evidence.'}],forms:form()}],empty:'No manual recovery cases to review.',create:{summary:'Create a recovery case',form:form()},nextHref:null,nextLabel:'Next'},
 },
 'account-operations':{
  body:`{{#if bulk}}<section class="ui-card"><p>{{bulk.info}}</p>{{bulk.form}}</section>{{/if}}{{#if account}}<section class="ui-card"><p class="ui-muted">{{account.idLabel}}: <code>{{account.accountId}}</code></p><p>{{account.info}}</p><dl class="ui-definition-grid">{{#each account.facts}}<dt>{{term}}</dt><dd>{{value}}</dd>{{/each}}</dl></section><ul class="ui-list">{{account.methods}}</ul>{{#if account.empty}}<p class="ui-empty">{{account.empty}}</p>{{/if}}<p><a class="ui-button-secondary" href="{{href account.caseHref}}">{{account.caseLabel}}</a></p>{{account.actions}}{{/if}}`,
  sample:{bulk:null,account:{idLabel:'Account ID',accountId:'account',info:'Review sign-in methods before changing account access.',facts:[{term:'Password',value:'Yes'}],methods:m('<li class="ui-card"></li>'),empty:null,caseHref:'/admin/cases',caseLabel:'Open a two-administrator case',actions:m('<details></details>')}},
 },
 reveal:{
  body:`<dl><dt>{{idLabel}}</dt><dd>{{id}}</dd><dt>{{emailLabel}}</dt><dd>{{email}}</dd></dl>`,
  sample:{idLabel:'Account ID',id:'account',emailLabel:'Email',email:'ada@example.test'},
 },
 status:{
  body:`<section class="ui-card"><p role="{{#if alert}}alert{{else}}status{{/if}}"{{#if alert}} class="error"{{/if}}>{{message}}</p>{{#if href}}<a class="ui-button-secondary" href="{{href href}}">{{label}}</a>{{/if}}</section>`,
  sample:{alert:false,message:'Operation completed.',href:'/admin',label:'Return to overview'},
 },
};
/** Template sources with their view model samples, keyed by full template name. */
export const adminTemplates:Readonly<Record<string,AdminTemplate>>=Object.freeze(Object.fromEntries(Object.entries(screens).map(([name,screen])=>[`admin/${name}`,Object.freeze({source:declare(name,screen.body),sample:screen.sample})])));
export const adminTemplateNames:readonly string[]=Object.freeze(Object.keys(adminTemplates));
/**
 * What the host hands to `createUiExtension({ extensions: [adminUiTemplates] })`. It also carries the view
 * model samples, so `urlcode-ui --extensions @jimhoyd/urlcode-admin` lists, ejects, previews and
 * drift-checks these screens from this one export. No `catalogue`: these templates place a view model the
 * console computes and use no copy key, and `adminCatalogue` is composed onto the kit's presentation by
 * `createAdminPresentation` rather than registered in it, so the kit's copy coverage does not cover it.
 */
export const adminUiTemplates:ExtensionTemplates&{readonly name:'admin';readonly templates:Readonly<Record<string,string>>;readonly samples:Readonly<Record<string,ViewModel>>}=Object.freeze({
 name:'admin',
 templates:Object.freeze(Object.fromEntries(Object.entries(adminTemplates).map(([name,template])=>[name,template.source]))),
 samples:Object.freeze(Object.fromEntries(Object.entries(adminTemplates).map(([name,template])=>[name,template.sample]))),
});
