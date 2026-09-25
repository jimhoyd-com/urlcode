import {escapeHtml,hiddenField as hidden} from '@jimhoyd/urlcode-ui';
import {extensionHookContext,jsonResponse,readFields,wantsJson} from '@jimhoyd/urlcode/extensions';
import type {ExtensionRequest,HandlerResult} from '@jimhoyd/urlcode/extensions';
import type {AdminAccountAction,AdminAccountRequestInput,AuthAccount,AuthExports} from '@jimhoyd/urlcode-auth';
import {AdminHttpError,formField,markup,screenResponse} from './admin-ui.ts';
import type {ScreenOptions} from './admin-ui.ts';
const actions:AdminAccountAction[]=['verify-email','force-password-reset','schedule-deletion','cancel-deletion','remove-passkey','remove-external','request-email-change','assign-roles','resend-verification'];
/**
 * The account-operations screen: a view and its form. Auth stages the operation, delivers every notice or token
 * message (the credential never reaches admin), runs the role-change hook and applies the change, all through
 * `auth.administration.users`; this module only collects the input and the typed confirmation.
 */
export function createAdminAccount(auth:AuthExports,mount:string){
 const enabled=()=>auth.administration.capabilities.accountOperations;
 return {enabled,async handle(request:ExtensionRequest,account:AuthAccount,csrf:string,render:ScreenOptions):Promise<HandlerResult|undefined>{
  if(request.path.slice(mount.length)!=='/account-operations')return;
  if(!enabled())throw new AdminHttpError(404,'Not found');
  if(!account.has('auth.users.read'))throw new AdminHttpError(403,'Permission required');
  const {copy}=render,tr=(key:string,values?:Record<string,string|number>)=>copy.t('admin.ops.'+key.replace(/-([a-z])/g,(_match,letter:string)=>letter.toUpperCase()),values),html=(key:string,values?:Record<string,string|number>)=>escapeHtml(tr(key,values));
  const form=(action:AdminAccountAction,ids:string,fields='')=>{const destructive=['force-password-reset','schedule-deletion','remove-passkey','remove-external'].includes(action);return `<details class="ui-card${destructive?' ui-danger-zone':''}"><summary>${html('action.'+action)}</summary><form class="ui-form-grid" method="post" action="${escapeHtml(mount+'/account-operations')}">${hidden('csrf',csrf)}${hidden('action',action)}${hidden('accountIds',ids)}${fields}${formField('reason',tr('reason'))}${formField('confirmation',tr('confirm',{value:action.toUpperCase()+' '+ids.split(',').length}))}<div class="ui-actions"><button${destructive?' class="ui-button-destructive"':''} type="submit">${html('action.'+action)}</button></div></form></details>`;};
  if(request.method==='GET'||request.method==='HEAD'){
   const ids=request.query.getAll('accountId');if(ids.length>1)throw new AdminHttpError(400,'One account ID required');const accountId=ids[0];
   const screen=(view:{bulk:{info:string;form:ReturnType<typeof markup>}|null;account:Record<string,unknown>|null})=>screenResponse('Account administration',{name:'admin/account-operations',view:view as Parameters<typeof screenResponse>[1]['view']},render);
   if(!accountId)return screen({bulk:{info:tr('bulkInfo'),form:markup(`<form class="ui-form-grid" method="post" action="${escapeHtml(mount+'/account-operations')}">${hidden('csrf',csrf)}${formField('accountIds',tr('ids'))}<label>${html('actionLabel')}<select name="action"><option value="assign-roles">${html('action.assign-roles')}</option><option value="resend-verification">${html('action.resend-verification')}</option></select></label>${formField('roles',tr('roles'),'text','off',false)}${formField('reason',tr('reason'))}${formField('confirmation',tr('bulkConfirm'))}<div class="ui-actions"><button type="submit">${html('apply')}</button></div></form>`)},account:null});
   const methods=await auth.administration.users.authentication(account.actor,{accountId,reason:'Viewed account authentication methods'});
   if(wantsJson(request))return jsonResponse(200,{...methods,csrf});
   const manage=account.has('auth.users.manage');
   const dates=(method:{added?:number;lastUsed?:number})=>`<span class="ui-muted">${escapeHtml(copy.s('Added'))}: ${escapeHtml(method.added?new Date(method.added).toISOString():copy.s('Not recorded'))}; ${escapeHtml(copy.s('Last used'))}: ${escapeHtml(method.lastUsed?new Date(method.lastUsed).toISOString():copy.s('Not recorded'))}</span>`;
   const methodItems=methods.passkeys.map(method=>`<li class="ui-card"><strong>${html('passkey')}</strong> <code>${escapeHtml(method.id)}</code> ${dates(method)} ${method.secondFactor?html('secondFactor'):manage?form('remove-passkey',accountId,hidden('credentialId',method.id)):''}</li>`).join('')+methods.external.map(method=>`<li class="ui-card"><strong>${escapeHtml(method.provider)}</strong> ${dates(method)}${manage?form('remove-external',accountId,hidden('externalId',method.id)):''}</li>`).join('');
   return screen({bulk:null,account:{idLabel:copy.s('Account ID'),accountId,info:tr('info'),facts:[{term:tr('password'),value:tr(methods.password?'yes':'no')},{term:tr('totp'),value:tr(methods.totp?'yes':'no')}],methods:markup(methodItems),empty:!methods.passkeys.length&&!methods.external.length?copy.s('No passkeys or external sign-in methods recorded.'):null,caseHref:mount+'/cases',caseLabel:tr('factorCase'),actions:markup(manage?['verify-email','resend-verification','force-password-reset','schedule-deletion','cancel-deletion'].map(action=>form(action as AdminAccountAction,accountId)).join('')+form('request-email-change',accountId,formField('email',tr('email'),'email'))+form('assign-roles',accountId,formField('roles',tr('roles'))):'')}});
  }
  if(request.method!=='POST')throw new AdminHttpError(405,'GET, HEAD or POST required');
  if(!account.has('auth.users.manage'))throw new AdminHttpError(403,'Permission required');
  const fields=readFields(request,{fields:['csrf','action','accountIds','roles','email','credentialId','externalId','reason','confirmation']});
  if(!fields.reason?.trim()||fields.reason.length>256)throw new AdminHttpError(400,'A reason is required');
  if(!account.fresh)throw new AdminHttpError(403,'Confirm your identity before this action');
  const action=fields.action as AdminAccountAction;if(!actions.includes(action))throw new AdminHttpError(400,'Invalid account action');
  const accountIds=(fields.accountIds||'').split(',').map(id=>id.trim()).filter(Boolean);if(fields.confirmation!==action.toUpperCase()+' '+accountIds.length)throw new AdminHttpError(400,'Typed confirmation must match action and count');
  const base={accountIds,reason:fields.reason};let input:AdminAccountRequestInput;
  if(action==='assign-roles')input={...base,action,roles:(fields.roles||'').split(',').map(role=>role.trim()).filter(Boolean)};
  else if(action==='request-email-change')input={...base,action,email:fields.email||''};
  else if(action==='remove-passkey')input={...base,action,credentialId:fields.credentialId||''};
  else if(action==='remove-external')input={...base,action,externalId:fields.externalId||''};
  else input={...base,action};
  const result=await auth.administration.users.administer(account.actor,{...input,context:extensionHookContext(request)});
  return wantsJson(request)?jsonResponse(200,result):screenResponse('Account administration completed',{name:'admin/status',view:{alert:false,message:tr('affected',{count:result.affected}),href:mount+'/users',label:copy.s('Back to users')}},render);
 }};
}
