import {escapeHtml,hiddenField as hidden,withDeadline} from '@jimhoyd/urlcode-ui';
import {markup,screenResponse} from './admin-ui.ts';
import type {ScreenOptions} from './admin-ui.ts';
import type {ExtensionRequest,ExtensionInstance} from '@jimhoyd/urlcode/extensions';
import {AuthHttp,AuthHttpError,csrfField,formField,hasPermission,jsonResponse,readFields,wantsJson} from '@jimhoyd/urlcode-auth';
import type {AuthPrincipal,AdminAccountService,AdminAccountRequest,AdminAccountAction,AdminAccountDelivery} from '@jimhoyd/urlcode-auth';
interface AdminAccountOptions {service:AdminAccountService;sendAccountAdministration?:(message:AdminAccountDelivery&{signal:AbortSignal})=>Promise<void>}
const actions:AdminAccountAction[]=['verify-email','force-password-reset','schedule-deletion','cancel-deletion','remove-passkey','remove-external','request-email-change','assign-roles','resend-verification'];
export function createAdminAccount(options:AdminAccountOptions,http:AuthHttp,mount:string){
 let callbacks=0,batches=0;
 return {enabled:()=>!!options.sendAccountAdministration,async handle(request:ExtensionRequest,principal:AuthPrincipal,actorToken:string,render:ScreenOptions):Promise<Awaited<ReturnType<ExtensionInstance['handle']>>|undefined>{
  if(request.path.slice(mount.length)!=='/account-operations')return;
  if(!options.sendAccountAdministration)throw new AuthHttpError(404,'Not found');
  if(principal.impersonatorId||!hasPermission(principal,'auth.users.read'))throw new AuthHttpError(403,'Permission required');
  const {presentation}=render,tr=(key:string,values?:Record<string,string|number>)=>presentation.text('adminOps.'+key.replace(/-([a-z])/g,(_match,letter:string)=>letter.toUpperCase()),values),html=(key:string,values?:Record<string,string|number>)=>escapeHtml(tr(key,values)),csrf=http.token(actorToken);
  const form=(action:AdminAccountAction,ids:string,fields='')=>{const destructive=['force-password-reset','schedule-deletion','remove-passkey','remove-external'].includes(action);return `<details class="ui-card${destructive?' ui-danger-zone':''}"><summary>${html('action.'+action)}</summary><form class="ui-form-grid" method="post" action="${escapeHtml(mount+'/account-operations')}">${csrfField(csrf)}${hidden('action',action)}${hidden('accountIds',ids)}${fields}${formField('reason',tr('reason'))}${formField('confirmation',tr('confirm',{value:action.toUpperCase()+' '+ids.split(',').length}))}<div class="ui-actions"><button${destructive?' class="ui-button-destructive"':''} type="submit">${html('action.'+action)}</button></div></form></details>`;};
  if(request.method==='GET'||request.method==='HEAD'){
   const ids=request.query.getAll('accountId');if(ids.length>1)throw new AuthHttpError(400,'One account ID required');const accountId=ids[0];
   const screen=(view:{bulk:{info:string;form:ReturnType<typeof markup>}|null;account:Record<string,unknown>|null})=>screenResponse(tr('title'),{name:'admin/account-operations',view:view as Parameters<typeof screenResponse>[1]['view']},render);
   if(!accountId)return screen({bulk:{info:tr('bulkInfo'),form:markup(`<form class="ui-form-grid" method="post" action="${escapeHtml(mount+'/account-operations')}">${csrfField(csrf)}${formField('accountIds',tr('ids'))}<label>${html('actionLabel')}<select name="action"><option value="assign-roles">${html('action.assign-roles')}</option><option value="resend-verification">${html('action.resend-verification')}</option></select></label>${formField('roles',tr('roles'),'text','off',false)}${formField('reason',tr('reason'))}${formField('confirmation',tr('bulkConfirm'))}<div class="ui-actions"><button type="submit">${html('apply')}</button></div></form>`)},account:null});
   const methods=await options.service.inspectAccountAuthentication({actorToken,accountId,reason:'Viewed account authentication methods'});
   if(wantsJson(request))return jsonResponse(200,{...methods,csrf});
   const manage=hasPermission(principal,'auth.users.manage');
   const dates=(method:{added?:number;lastUsed?:number})=>`<span class="ui-muted">${escapeHtml(presentation.textSource('Added'))}: ${escapeHtml(method.added?new Date(method.added).toISOString():presentation.textSource('Not recorded'))}; ${escapeHtml(presentation.textSource('Last used'))}: ${escapeHtml(method.lastUsed?new Date(method.lastUsed).toISOString():presentation.textSource('Not recorded'))}</span>`;
   const methodItems=methods.passkeys.map(method=>`<li class="ui-card"><strong>${html('passkey')}</strong> <code>${escapeHtml(method.id)}</code> ${dates(method)} ${method.secondFactor?html('secondFactor'):manage?form('remove-passkey',accountId,hidden('credentialId',method.id)):''}</li>`).join('')+methods.external.map(method=>`<li class="ui-card"><strong>${escapeHtml(method.provider)}</strong> ${dates(method)}${manage?form('remove-external',accountId,hidden('externalId',method.id)):''}</li>`).join('');
   return screen({bulk:null,account:{idLabel:presentation.textSource('Account ID'),accountId,info:tr('info'),facts:[{term:tr('password'),value:tr(methods.password?'yes':'no')},{term:tr('totp'),value:tr(methods.totp?'yes':'no')}],methods:markup(methodItems),empty:!methods.passkeys.length&&!methods.external.length?presentation.textSource('No passkeys or external sign-in methods recorded.'):null,caseHref:mount+'/cases',caseLabel:tr('factorCase'),actions:markup(manage?['verify-email','resend-verification','force-password-reset','schedule-deletion','cancel-deletion'].map(action=>form(action as AdminAccountAction,accountId)).join('')+form('request-email-change',accountId,formField('email',tr('email'),'email'))+form('assign-roles',accountId,formField('roles',tr('roles'))):'')}});
  }
  if(request.method!=='POST')throw new AuthHttpError(405,'GET, HEAD or POST required');
  if(!hasPermission(principal,'auth.users.manage'))throw new AuthHttpError(403,'Permission required');
  const fields=readFields(request,['action','accountIds','roles','email','credentialId','externalId','reason','confirmation']);http.verify(request,fields);
  const action=fields.action as AdminAccountAction;if(!actions.includes(action))throw new AuthHttpError(400,'Invalid account action');
  const accountIds=(fields.accountIds||'').split(',').map(id=>id.trim()).filter(Boolean);if(fields.confirmation!==action.toUpperCase()+' '+accountIds.length)throw new AuthHttpError(400,'Typed confirmation must match action and count');
  const base={actorToken,accountIds,reason:fields.reason||''};let input:AdminAccountRequest;
  if(action==='assign-roles')input={...base,action,roles:(fields.roles||'').split(',').map(role=>role.trim()).filter(Boolean)};
  else if(action==='request-email-change')input={...base,action,email:fields.email||''};
  else if(action==='remove-passkey')input={...base,action,credentialId:fields.credentialId||''};
  else if(action==='remove-external')input={...base,action,externalId:fields.externalId||''};
  else input={...base,action};
  if(batches>=4||callbacks>=4)throw new AuthHttpError(503,'Account administration delivery busy');
  batches++;let operationId:string|undefined;const deadline=Date.now()+30000;
  try{
   const staged=await options.service.stageAccountAdministration(input);operationId=staged.operationId;
   for(const message of staged.deliveries){
    if(callbacks>=4||Date.now()>=deadline)throw new AuthHttpError(503,'Account administration delivery busy');
    callbacks++;
    await withDeadline(signal=>{const pending=Promise.resolve().then(()=>options.sendAccountAdministration!({...message,signal}));void pending.finally(()=>{callbacks--;}).catch(()=>{});return pending;},Math.min(5000,deadline-Date.now()),'Account notice delivery timed out');
   }
   const result=await options.service.completeAccountAdministration({actorToken,operationId});
   return wantsJson(request)?jsonResponse(200,result):screenResponse(tr('completed'),{name:'admin/status',view:{alert:false,message:tr('affected',{count:result.affected}),href:mount+'/users',label:presentation.textSource('Back to users')}},render);
  }catch(error){if(operationId)await options.service.cancelAccountAdministration({actorToken,operationId}).catch(()=>{});throw error;}
  finally{batches--;}
 }};
}
