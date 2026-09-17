import type {ExtensionRequest,ExtensionInstance} from '@jimhoyd/urlcode/extensions';
import {AuthHttp,AuthHttpError,csrfField,escapeHtml,formField,hasPermission,jsonResponse,pageResponse,readFields,wantsJson} from '@jimhoyd/urlcode-auth';
import type {AuthPrincipal,AdminAccountService,AdminAccountRequest,AdminAccountAction,AdminAccountDelivery,PresentationContext} from '@jimhoyd/urlcode-auth';
export interface AdminAccountOptions {service:AdminAccountService;sendAccountAdministration?:(message:AdminAccountDelivery&{signal:AbortSignal})=>Promise<void>}
const actions:AdminAccountAction[]=['verify-email','force-password-reset','schedule-deletion','cancel-deletion','remove-passkey','remove-external','request-email-change','assign-roles','resend-verification'];
export function createAdminAccount(options:AdminAccountOptions,http:AuthHttp,mount:string){
 let callbacks=0,batches=0;
 return {enabled:()=>!!options.sendAccountAdministration,async handle(request:ExtensionRequest,principal:AuthPrincipal,actorToken:string,presentation:PresentationContext,nav:string):Promise<Awaited<ReturnType<ExtensionInstance['handle']>>|undefined>{
  if(request.path.slice(mount.length)!=='/account-operations')return;
  if(!options.sendAccountAdministration)throw new AuthHttpError(404,'Not found');
  if(principal.impersonatorId||!hasPermission(principal,'auth.users.read'))throw new AuthHttpError(403,'Permission required');
  const tr=(key:string,values?:Record<string,string|number>)=>presentation.text('adminOps.'+key.replace(/-([a-z])/g,(_match,letter:string)=>letter.toUpperCase()),values),html=(key:string,values?:Record<string,string|number>)=>escapeHtml(tr(key,values)),csrf=http.token(actorToken);
  const hidden=(name:string,value:string)=>`<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const form=(action:AdminAccountAction,ids:string,fields='')=>`<form method="post" action="${escapeHtml(mount+'/account-operations')}">${csrfField(csrf)}${hidden('action',action)}${hidden('accountIds',ids)}${fields}${formField('reason',tr('reason'))}${formField('confirmation',tr('confirm',{value:action.toUpperCase()+' '+ids.split(',').length}))}<button>${html('action.'+action)}</button></form>`;
  if(request.method==='GET'||request.method==='HEAD'){
   const ids=request.query.getAll('accountId');if(ids.length>1)throw new AuthHttpError(400,'One account ID required');const accountId=ids[0];
   if(!accountId)return pageResponse(tr('title'),nav+`<p>${html('bulkInfo')}</p><form method="post" action="${escapeHtml(mount+'/account-operations')}">${csrfField(csrf)}${formField('accountIds',tr('ids'))}<label>${html('actionLabel')}<select name="action"><option value="assign-roles">${html('action.assign-roles')}</option><option value="resend-verification">${html('action.resend-verification')}</option></select></label>${formField('roles',tr('roles'),'text','off',false)}${formField('reason',tr('reason'))}${formField('confirmation',tr('bulkConfirm'))}<button>${html('apply')}</button></form>`,200,[],undefined,presentation);
   const methods=await options.service.inspectAccountAuthentication({actorToken,accountId,reason:'Viewed account authentication methods'});
   if(wantsJson(request))return jsonResponse(200,{...methods,csrf});
   const manage=hasPermission(principal,'auth.users.manage');
   const dates=(method:{added?:number;lastUsed?:number})=>`<span>${escapeHtml(presentation.textSource('Added'))}: ${escapeHtml(method.added?new Date(method.added).toISOString():presentation.textSource('Not recorded'))}; ${escapeHtml(presentation.textSource('Last used'))}: ${escapeHtml(method.lastUsed?new Date(method.lastUsed).toISOString():presentation.textSource('Not recorded'))}</span>`;
   return pageResponse(tr('title'),nav+`<h2>${escapeHtml(accountId)}</h2><p>${html('info')}</p><dl><dt>${html('password')}</dt><dd>${html(methods.password?'yes':'no')}</dd><dt>${html('totp')}</dt><dd>${html(methods.totp?'yes':'no')}</dd></dl><ul>${methods.passkeys.map(method=>`<li>${html('passkey')} ${escapeHtml(method.id)} ${dates(method)} ${method.secondFactor?html('secondFactor'):manage?form('remove-passkey',accountId,hidden('credentialId',method.id)):''}</li>`).join('')}${methods.external.map(method=>`<li>${escapeHtml(method.provider)} ${dates(method)}${manage?form('remove-external',accountId,hidden('externalId',method.id)):''}</li>`).join('')}</ul><a href="${escapeHtml(mount+'/cases')}">${html('factorCase')}</a>`+(manage?['verify-email','resend-verification','force-password-reset','schedule-deletion','cancel-deletion'].map(action=>form(action as AdminAccountAction,accountId)).join('')+form('request-email-change',accountId,formField('email',tr('email'),'email'))+form('assign-roles',accountId,formField('roles',tr('roles'))):''),200,[],undefined,presentation);
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
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;callbacks++;
    const pending=Promise.resolve().then(()=>options.sendAccountAdministration!({...message,signal:controller.signal}));void pending.finally(()=>{callbacks--;}).catch(()=>{});
    try{await Promise.race([pending,new Promise<void>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Account notice delivery timed out'));},Math.min(5000,deadline-Date.now()));})]);}finally{if(timer)clearTimeout(timer);}
   }
   const result=await options.service.completeAccountAdministration({actorToken,operationId});
   return wantsJson(request)?jsonResponse(200,result):pageResponse(tr('completed'),nav+`<p>${html('affected',{count:result.affected})}</p>`,200,[],undefined,presentation);
  }catch(error){if(operationId)await options.service.cancelAccountAdministration({actorToken,operationId}).catch(()=>{});throw error;}
  finally{batches--;}
 }};
}
