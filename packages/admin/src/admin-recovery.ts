import {hiddenField,postForm} from '@jimhoyd/urlcode-ui';
import {jsonResponse,readFields,wantsJson} from '@jimhoyd/urlcode/extensions';
import type {ExtensionRequest,HandlerResult} from '@jimhoyd/urlcode/extensions';
import type {AuthAccount,AuthExports} from '@jimhoyd/urlcode-auth';
import {maskEmail} from './admin-reporting.ts';
import {AdminHttpError,formField,markup,screenResponse} from './admin-ui.ts';
import type {ScreenOptions} from './admin-ui.ts';
const paths=['/recovery-cases','/recovery-cases/create','/recovery-cases/approve','/recovery-cases/note','/recovery-cases/close'];
/**
 * Manual recovery cases: a view and its forms. Auth checks every permission and the maker-checker rule, warns the old
 * address and delivers the restoration link through `auth.administration.recovery`, so the credential never reaches
 * admin.
 */
export function createAdminRecovery(auth:AuthExports,mount:string){
 const enabled=()=>auth.administration.capabilities.manualRecovery;
 const hidden=(id:string)=>hiddenField('caseId',id);
 const form=(path:string,csrf:string,fields:string,label:string)=>postForm({action:mount+path,csrf,fields,label,destructive:path==='/recovery-cases/approve',className:'ui-form-grid'});
 return {enabled,async handle(request:ExtensionRequest,account:AuthAccount,csrf:string,render:ScreenOptions):Promise<HandlerResult|undefined>{
  const {copy}=render,tr=(key:string)=>copy.t('admin.recovery.'+key);
  const path=request.path.slice(mount.length);if(!paths.includes(path))return;
  if(!enabled())throw new AdminHttpError(404,'Not found');
  if(!account.has('auth.cases.read'))throw new AdminHttpError(403,'Permission required');
  if(request.method==='GET'||request.method==='HEAD'){
   if(path!=='/recovery-cases')throw new AdminHttpError(405,'POST required');
   const result=await auth.administration.recovery.list(account.actor,{limit:50,...(request.query.get('after')?{after:request.query.get('after')!}:{})});
   if(wantsJson(request))return jsonResponse(200,{...result,cases:result.cases.map(item=>({...item,recovery:{...item.recovery,email:maskEmail(item.recovery.email)}})),csrf});
   const canManage=account.has('auth.cases.manage');
   const cases=result.cases.map(item=>({id:item.id,facts:[{term:tr('account'),value:item.accountId},{term:tr('address'),value:maskEmail(item.recovery.email)},{term:tr('status'),value:tr('state.'+item.recovery.state)},{term:tr('evidence'),value:item.recovery.evidence.summary},{term:tr('reference'),value:item.recovery.evidence.reference||tr('none')}],reason:item.reason,notes:(item.notes??[]).map(note=>({actor:note.actorId,note:note.note})),forms:markup((canManage&&['review','delivery','ready'].includes(item.recovery.state)?form('/recovery-cases/note',csrf,hidden(item.id)+formField('reason',tr('note')),tr('addNote')):'')+(canManage&&['review','delivery','ready'].includes(item.recovery.state)?form('/recovery-cases/close',csrf,hidden(item.id)+formField('reason',tr('closure')),tr('close')):'')+(canManage&&item.status==='pending'&&item.makerId!==account.id?form('/recovery-cases/approve',csrf,hidden(item.id)+formField('reason',tr('approval'))+formField('confirmation',tr('confirmation')),tr('approve')):''))}));
   return screenResponse('Manual account recovery',{name:'admin/recovery-cases',view:{intro:tr('intro'),cases,empty:copy.s('No manual recovery cases to review.'),create:canManage?{summary:tr('create'),form:markup(form('/recovery-cases/create',csrf,formField('accountId',tr('accountId'))+formField('email',tr('verifiedAddress'),'email')+formField('summary',tr('boundedEvidence'))+formField('reference',tr('reference'),'text','off',false)+formField('reason',tr('reason')),tr('create')))}:null,nextHref:result.next?mount+'/recovery-cases?after='+encodeURIComponent(result.next):null,nextLabel:copy.t('action.next')}},render);
  }
  if(request.method!=='POST')throw new AdminHttpError(405,'GET, HEAD or POST required');
  if(!account.has('auth.cases.manage'))throw new AdminHttpError(403,'Permission required');
  const fields=readFields(request,{fields:['csrf','accountId','email','summary','reference','reason','caseId','confirmation']});
  if(!fields.reason?.trim()||fields.reason.length>256)throw new AdminHttpError(400,'A reason is required');
  if(!account.fresh)throw new AdminHttpError(403,'Confirm your identity before this action');
  const recovery=auth.administration.recovery,cases=auth.administration.cases;
  if(path==='/recovery-cases/create')await recovery.create(account.actor,{accountId:fields.accountId||'',email:fields.email||'',evidence:{summary:fields.summary||'',...(fields.reference?{reference:fields.reference}:{})},reason:fields.reason});
  else if(path==='/recovery-cases/note')await cases.note(account.actor,{caseId:fields.caseId||'',note:fields.reason});
  else if(path==='/recovery-cases/close')await cases.close(account.actor,{caseId:fields.caseId||'',reason:fields.reason});
  else if(path==='/recovery-cases/approve'){
   if(fields.confirmation!=='RESTORE')throw new AdminHttpError(400,'Typed confirmation must be RESTORE');
   await recovery.approve(account.actor,{caseId:fields.caseId||'',reason:fields.reason});
  }else throw new AdminHttpError(404,'Not found');
  return wantsJson(request)?jsonResponse(200,{updated:true}):jsonResponse(303,{updated:true},[['location',mount+'/recovery-cases']]);
 }};
}
