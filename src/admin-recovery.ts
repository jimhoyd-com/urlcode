import {adminPage as pageResponse} from './admin-presentation.ts';
import {escapeHtml} from '@jimhoyd/urlcode-ui';
import {maskEmail} from './admin-reporting.ts';
import {hidden as hiddenField,postForm} from './admin-markup.ts';
import {withDeadline} from './admin-deadline.ts';
import type {ExtensionRequest,ExtensionInstance} from '@jimhoyd/urlcode/extensions';
import {AuthHttp,AuthHttpError,formField,hasPermission,jsonResponse,readFields,wantsJson} from '@jimhoyd/urlcode-auth';
import type {AuthPrincipal,ManualRecoveryService,ManualRecoveryDelivery,PresentationContext} from '@jimhoyd/urlcode-auth';

export interface AdminRecoveryOptions {
 service:ManualRecoveryService&{
  closeCase(input:{actorToken:string;caseId:string;reason:string}):Promise<unknown>;
  addCaseNote(input:{actorToken:string;caseId:string;note:string}):Promise<unknown>;
 };
 sendRecovery?:(message:ManualRecoveryDelivery)=>Promise<void>;
}
/** The service is the authorization boundary; this handler supplies CSRF and delivery gates. */
export function createAdminRecovery(options:AdminRecoveryOptions,http:AuthHttp,mount:string){
 let delivering=0;
 const enabled=()=>options.service.getManualRecoveryEnabled()&&Boolean(options.sendRecovery);
 const hidden=(id:string)=>hiddenField('caseId',id);
 const form=(path:string,csrf:string,fields:string,label:string)=>postForm(mount+path,csrf,fields,label,path==='/recovery-cases/approve');
 return {enabled,async handle(request:ExtensionRequest,principal:AuthPrincipal,actorToken:string,presentation:PresentationContext,nav:string):Promise<Awaited<ReturnType<ExtensionInstance['handle']>>|undefined>{
  const tr=(key:string)=>presentation.text('manualRecovery.'+key),html=(key:string)=>escapeHtml(tr(key));
  const path=request.path.slice(mount.length);if(!['/recovery-cases','/recovery-cases/create','/recovery-cases/approve','/recovery-cases/note','/recovery-cases/close'].includes(path))return;
  if(!enabled())throw new AuthHttpError(404,'Not found');
  if(principal.impersonatorId||!hasPermission(principal,'auth.cases.read'))throw new AuthHttpError(403,'Permission required');
  const csrf=http.token(actorToken);
  if(request.method==='GET'||request.method==='HEAD'){
   if(path!=='/recovery-cases')throw new AuthHttpError(405,'POST required');
   const result=await options.service.listRecoveryCases({limit:50,...(request.query.get('after')?{after:request.query.get('after')!}:{})});
   if(wantsJson(request))return jsonResponse(200,{...result,cases:result.cases.map(item=>({...item,recovery:{...item.recovery,email:maskEmail(item.recovery.email)}})),csrf});
   const canManage=hasPermission(principal,'auth.cases.manage');
   const cases=result.cases.map(item=>`<li class="ui-card"><h2><code>${escapeHtml(item.id)}</code></h2><dl class="ui-definition-grid"><dt>${html('account')}</dt><dd>${escapeHtml(item.accountId)}</dd><dt>${html('address')}</dt><dd>${escapeHtml(maskEmail(item.recovery.email))}</dd><dt>${html('status')}</dt><dd>${html('state.'+item.recovery.state)}</dd><dt>${html('evidence')}</dt><dd>${escapeHtml(item.recovery.evidence.summary)}</dd><dt>${html('reference')}</dt><dd>${escapeHtml(item.recovery.evidence.reference||tr('none'))}</dd></dl><p>${escapeHtml(item.reason)}</p><ul>${(item.notes??[]).map(note=>`<li>${escapeHtml(note.actorId)}: ${escapeHtml(note.note)}</li>`).join('')}</ul>${canManage&&['review','delivery','ready'].includes(item.recovery.state)?form('/recovery-cases/note',csrf,hidden(item.id)+formField('reason',tr('note')),tr('addNote')):''}${canManage&&['review','delivery','ready'].includes(item.recovery.state)?form('/recovery-cases/close',csrf,hidden(item.id)+formField('reason',tr('closure')),tr('close')):''}${canManage&&item.status==='pending'&&item.makerId!==principal.id?form('/recovery-cases/approve',csrf,hidden(item.id)+formField('reason',tr('approval'))+formField('confirmation',tr('confirmation')),tr('approve')):''}</li>`).join('');
   return pageResponse(tr('title'),nav+'<p class="ui-muted">'+html('intro')+'</p>'+ (cases?'<ul class="ui-list">'+cases+'</ul>':'<section class="ui-card"><p class="ui-empty">'+escapeHtml(presentation.textSource('No manual recovery cases to review.'))+'</p></section>')+(canManage?'<details class="ui-card"><summary>'+html('create')+'</summary>'+form('/recovery-cases/create',csrf,formField('accountId',tr('accountId'))+formField('email',tr('verifiedAddress'),'email')+formField('summary',tr('boundedEvidence'))+formField('reference',tr('reference'),'text','off',false)+formField('reason',tr('reason')),tr('create'))+'</details>':'')+(result.next?`<a href="${escapeHtml(mount+'/recovery-cases?after='+encodeURIComponent(result.next))}">${escapeHtml(presentation.text('action.next'))}</a>`:''),200,[],undefined,presentation);
  }
  if(request.method!=='POST')throw new AuthHttpError(405,'GET, HEAD or POST required');
  if(!hasPermission(principal,'auth.cases.manage'))throw new AuthHttpError(403,'Permission required');
  const fields=readFields(request,['accountId','email','summary','reference','reason','caseId','confirmation']);http.verify(request,fields);
  if(!fields.reason?.trim()||fields.reason.length>256)throw new AuthHttpError(400,'A reason is required');
  if(path==='/recovery-cases/create')await options.service.createRecoveryCase({actorToken,accountId:fields.accountId||'',email:fields.email||'',evidence:{summary:fields.summary||'',...(fields.reference?{reference:fields.reference}:{})},reason:fields.reason});
  else if(path==='/recovery-cases/note')await options.service.addCaseNote({actorToken,caseId:fields.caseId||'',note:fields.reason});
  else if(path==='/recovery-cases/close')await options.service.closeCase({actorToken,caseId:fields.caseId||'',reason:fields.reason});
  else if(path==='/recovery-cases/approve'){
   if(fields.confirmation!=='RESTORE')throw new AuthHttpError(400,'Typed confirmation must be RESTORE');
   if(delivering>=4)throw new AuthHttpError(503,'Recovery delivery is busy');
   delivering++;let callbackStarted=false,released=false;const release=()=>{if(!released){released=true;delivering--;}};
   let issued:Awaited<ReturnType<ManualRecoveryService['approveRecoveryCase']>>|undefined;
   try{
    issued=await options.service.approveRecoveryCase({actorToken,caseId:fields.caseId||'',reason:fields.reason});
    const {email,oldEmail,token,case:{id:caseId}}=issued;callbackStarted=true;
    await withDeadline(signal=>{const sending=Promise.resolve().then(()=>options.sendRecovery!({email,oldEmail,token,caseId,signal}));void sending.finally(release).catch(()=>{});return sending;},5000,'Recovery delivery timed out');
    await options.service.activateRecoveryCase({actorToken,caseId:issued.case.id,token:issued.token});
   }catch(error){if(issued)await options.service.cancelRecoveryCredential({actorToken,caseId:issued.case.id,token:issued.token}).catch(()=>{});throw error;}
   finally{if(!callbackStarted)release();}
  }else throw new AuthHttpError(404,'Not found');
  return wantsJson(request)?jsonResponse(200,{updated:true}):jsonResponse(303,{updated:true},[['location',mount+'/recovery-cases']]);
 }};
}
