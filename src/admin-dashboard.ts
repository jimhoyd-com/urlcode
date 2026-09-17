import {escapeHtml,hasPermission} from '@jimhoyd/urlcode-auth';
import type {AuthService,AuthPrincipal,PresentationContext} from '@jimhoyd/urlcode-auth';
export function dashboardSummary(stats:Awaited<ReturnType<AuthService['dashboard']>>,mount:string,principal:AuthPrincipal,presentation:PresentationContext):string {
 const text=(value:string)=>escapeHtml(presentation.textSource(value));
 const items:[string,number,string,string][]=[['Accounts',stats.users,'/users','auth.users.read'],['Active accounts',stats.users-stats.locked-stats.pendingDeletion,'/users?status=active','auth.users.read'],['Locked accounts',stats.locked,'/users?status=locked','auth.users.read'],['Pending deletion',stats.pendingDeletion,'/users?status=pending-delete','auth.users.read'],['Sessions',stats.sessions,'/sessions','auth.sessions.manage'],['Waiting for approval',stats.waitlist,'/registrations','auth.users.manage']];
 const totals=`<ul>${items.filter(([, , ,permission])=>hasPermission(principal,permission)).map(([label,count,path])=>`<li><a href="${escapeHtml(mount+path)}">${text(label)}: ${count}</a></li>`).join('')}</ul>`;
 const days=stats.daily.slice(-30),peak=Math.max(1,...days.flatMap(day=>[day.signUps,day.signIns,day.failedSignIns]));
 const colors=['#2563eb','#15803d','#b91c1c'];
 const lines=(['signUps','signIns','failedSignIns'] as const).map((key,index)=>`<polyline fill="none" stroke="${colors[index]}" stroke-width="2" points="${days.map((day,i)=>`${20+i*20},${140-Math.round(Math.max(0,day[key])/peak*120)}`).join(' ')}"/>`).join('');
 return `<p>${escapeHtml(presentation.text('message.adminTotals',{users:stats.users,locked:stats.locked,pending:stats.pendingDeletion,sessions:stats.sessions,waitlist:stats.waitlist}))}</p>`+totals+`<svg viewBox="0 0 620 160" role="img" aria-labelledby="auth-chart-title auth-chart-description"><title id="auth-chart-title">${text('Authentication activity')}</title><desc id="auth-chart-description">${text('Thirty UTC days. Blue: sign-ups; green: sign-ins; red: failed sign-ins. Exact values follow in the daily table.')}</desc>${lines}</svg>`;
}
