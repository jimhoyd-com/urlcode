import type {ExtensionRequest} from '@jimhoyd/urlcode/extensions';
import type {AuthSessionResult} from './auth-core.ts';
import type {PresentationContext} from './presentation.ts';
import {createPresentation} from './presentation.ts';
import {jsonResponse,wantsJson} from '@jimhoyd/urlcode/extensions';
import {AuthHttp,AuthHttpError,readAuthFields,screenResponse} from './auth-ui.ts';
import type {UiExtension} from '@jimhoyd/urlcode-ui/host';
import {escapeHtml,field,hiddenField,Markup} from '@jimhoyd/urlcode-ui';
import type {AuthHttpResponse} from './auth-ui.ts';

/** Evidence is an internal human assessment, never an automatic identity assertion. */
export interface ManualRecoveryEvidence {summary:string;reference?:string}
export interface ManualRecoveryCase {
 id:string;accountId:string;action:'restore-access';reason:string;makerId:string;approverId?:string;
 status:'pending'|'applied'|'closed';created:number;expires:number;targetVersion:number;
 recovery:{email:string;evidence:ManualRecoveryEvidence;state:'review'|'delivery'|'ready'|'redeemed'|'cancelled'};
 notes?:{actorId:string;note:string;created:number}[];
}
export interface ManualRecoveryService {
 getManualRecoveryEnabled():boolean;
 createRecoveryCase(input:{actorToken:string;accountId:string;email:string;evidence:ManualRecoveryEvidence;reason:string}):Promise<ManualRecoveryCase>;
 listRecoveryCases(options?:{limit?:number;after?:string}):Promise<{cases:ManualRecoveryCase[];next?:string}>;
 approveRecoveryCase(input:{actorToken:string;caseId:string;reason:string}):Promise<{case:ManualRecoveryCase;token:string;email:string;oldEmail:string}>;
 activateRecoveryCase(input:{actorToken:string;caseId:string;token:string}):Promise<void>;
 cancelRecoveryCredential(input:{actorToken:string;caseId:string;token:string}):Promise<void>;
 redeemRecoveryCase(input:{token:string;password:string}):Promise<AuthSessionResult>;
}
export function validateRecoveryEvidence(input:ManualRecoveryEvidence):ManualRecoveryEvidence {
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['summary','reference'].includes(key)))throw new Error('Invalid recovery evidence');
 const bounded=(value:unknown,max:number)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
 if(!bounded(input.summary,2000)||input.reference!==undefined&&!bounded(input.reference,256))throw new Error('Invalid recovery evidence');
 return {summary:input.summary.trim(),...(input.reference!==undefined?{reference:input.reference.trim()}:{})};
}
/** Redemption is POST-only and creates an enrollment session, never normal access. */
export function createManualRecoveryFlows(service:ManualRecoveryService,http:AuthHttp,mount:string,ui:UiExtension){
 return {async handle(request:ExtensionRequest,presentation:PresentationContext=createPresentation().resolve()):Promise<AuthHttpResponse|undefined>{
  const tr=(key:string)=>presentation.text('manualRecovery.'+key);
  if(request.path.slice(mount.length)!=='/restore-access')return;
  if(!service.getManualRecoveryEnabled())throw new AuthHttpError(404,'Not found');
  if(!['GET','HEAD','POST'].includes(request.method))throw new AuthHttpError(405,'GET, HEAD or POST required');
  if(request.method!=='POST'){
   const tokens=request.query.getAll('token');if(tokens.length!==1||!/^[A-Za-z0-9_-]{43}$/.test(tokens[0]!))throw new AuthHttpError(400,'A single restoration token is required');
   const prepared=http.prepare(request);
   return screenResponse(tr('restoreTitle'),{name:'auth/restore-access',view:{intro:tr('restoreIntro'),form:new Markup(`<form method="post" action="${escapeHtml(mount+'/restore-access?lang='+encodeURIComponent(presentation.locale))}">${hiddenField('csrf', prepared.csrf)}<input type="hidden" name="token" value="${escapeHtml(tokens[0]!)}">${field({name:'password',label:tr('newPassword'),type:'password',autocomplete:'new-password'})}<button type="submit">${escapeHtml(tr('replace'))}</button></form>`)}},{status:200,headers:prepared.headers,presentation,layout:'compact',ui});
  }
  const fields=readAuthFields(request,['token','password']);http.verify(request,fields);
  const result=await service.redeemRecoveryCase({token:fields.token||'',password:fields.password||''});
  const headers=http.sessionHeaders(result.token);
  return wantsJson(request)?jsonResponse(200,{enrollmentRequired:true,user:result.user,csrf:http.token(result.token)},headers):jsonResponse(303,{enrollmentRequired:true},[['location',mount+'/account?lang='+encodeURIComponent(presentation.locale)],...headers]);
 }};
}
