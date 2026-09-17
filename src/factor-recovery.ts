import type {AuthChallenge} from './challenge.ts';
import {createPresentation} from './presentation.ts';
import type {PresentationContext} from './presentation.ts';
import {randomBytes} from 'node:crypto';
import type {ExtensionRequest} from '@jimhoyd/urlcode/extensions';
import type {AuthSessionResult} from './auth-core.ts';
import {AuthHttp,AuthHttpError,csrfField,escapeHtml,formField,jsonResponse,pageResponse,readFields,wantsJson} from './auth-ui.ts';
import type {AuthHttpResponse} from './auth-ui.ts';
export interface FactorRecoveryService {
 getFactorRecoveryEnabled():boolean;
 beginFactorRecovery(input:{email:string;browserToken:string}):Promise<{verificationToken:string|null;cancelToken:string|null}>;
 confirmFactorRecovery(input:{token:string;browserToken:string}):Promise<{completeAfter:number;expires:number}>;
 cancelFactorRecovery(token:string):Promise<void>;
 completeFactorRecovery(input:{token:string;browserToken:string}):Promise<AuthSessionResult>;
}
export interface FactorRecoveryMessage {email:string;verificationToken:string;cancelToken:string;locale?:string;signal:AbortSignal}
export interface FactorRecoveryOptions {challenge?:AuthChallenge;service:FactorRecoveryService;sendFactorRecovery?:(message:FactorRecoveryMessage)=>Promise<void>}
/** Opt-in email fallback lowers factor assurance; it never creates an unrestricted session. */
export function createFactorRecoveryFlows(options:FactorRecoveryOptions,http:AuthHttp,mount:string){
 const browserCookie='__Host-urlcode-factor-recovery';
 const enabled=()=>options.service.getFactorRecoveryEnabled()&&Boolean(options.sendFactorRecovery);
 const hidden=(token:string)=>`<input type="hidden" name="token" value="${escapeHtml(token)}">`;
 return {enabled,async handle(request:ExtensionRequest,presentation:PresentationContext=createPresentation().resolve()):Promise<AuthHttpResponse|undefined>{
  const tr=(key:string,values?:Record<string,string|number>)=>presentation.text(key,values);
 const form=(path:string,csrf:string,markup:string,label:string)=>`<form method="post" action="${escapeHtml(mount+path+'?lang='+encodeURIComponent(presentation.locale))}">${csrfField(csrf)}${markup}<button type="submit">${escapeHtml(label)}</button></form>`;

  const page=(title:string,markup:string,status=200,headers:[string,string][]=[])=>(pageResponse(title,markup,status,headers,undefined,presentation,request.path===mount+'/recover-factor'&&request.method!=='POST'?options.challenge?.widget:undefined));
  const path=request.path.slice(mount.length);if(!['/recover-factor','/recover-factor/confirm','/recover-factor/cancel','/recover-factor/complete'].includes(path))return;
  if(!enabled())throw new AuthHttpError(404,'Not found');
  if(!['GET','HEAD','POST'].includes(request.method))throw new AuthHttpError(405,'GET, HEAD or POST required');
  if(request.method!=='POST'){
   const prepared=http.prepare(request);
   if(path==='/recover-factor')return page(tr('recovery.title'),`<p>${escapeHtml(tr('recovery.intro'))}</p>`+form(path,prepared.csrf,formField('email',presentation.textSource('Email address'),'email','username'),tr('recovery.send')),200,prepared.headers);
   const tokens=request.query.getAll('token');if(tokens.length!==1||!/^[A-Za-z0-9_-]{43}$/.test(tokens[0]!))throw new AuthHttpError(400,'A single recovery token is required');
   if(path==='/recover-factor/cancel')return page(tr('recovery.cancelTitle'),form(path,prepared.csrf,hidden(tokens[0]!),tr('recovery.cancel')),200,prepared.headers);
   return page(tr('recovery.confirmTitle'),`<p>${escapeHtml(tr('recovery.confirmInfo'))}</p>`+form('/recover-factor/confirm',prepared.csrf,hidden(tokens[0]!),tr('recovery.confirm'))+form('/recover-factor/complete',prepared.csrf,hidden(tokens[0]!),tr('recovery.complete')),200,prepared.headers);
  }
  const fields=readFields(request,['email','token']);http.verify(request,fields);
  if(path==='/recover-factor'){
   const browserToken=http.cookie(request,browserCookie)||randomBytes(32).toString('base64url');
   const issued=await options.service.beginFactorRecovery({email:fields.email||'',browserToken});
   if(issued.verificationToken&&issued.cancelToken){
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([options.sendFactorRecovery!({email:fields.email||'',verificationToken:issued.verificationToken,cancelToken:issued.cancelToken,locale:presentation.locale,signal:controller.signal}),new Promise<void>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Delivery timeout'));},5000);})]);}
    catch{await options.service.cancelFactorRecovery(issued.cancelToken).catch(()=>{});}finally{if(timer)clearTimeout(timer);}
   }
   return jsonResponse(200,{message:'If this account is eligible, recovery instructions will be sent. Continue in this browser.'},[['set-cookie',http.setCookie(browserCookie,browserToken,5*86400)]]);
  }
  if(path==='/recover-factor/cancel'){await options.service.cancelFactorRecovery(fields.token||'');return jsonResponse(200,{cancelled:true});}
  const browserToken=http.cookie(request,browserCookie);if(!browserToken)throw new AuthHttpError(403,'Use the browser that requested recovery');
  if(path==='/recover-factor/confirm'){
   const result=await options.service.confirmFactorRecovery({token:fields.token||'',browserToken});
   return wantsJson(request)?jsonResponse(200,result):page(tr('recovery.waitTitle'),`<p>${escapeHtml(tr('recovery.waitInfo',{time:new Date(result.completeAfter).toISOString()}))}</p>`+form('/recover-factor/complete',http.token(http.session(request)||http.cookie(request,http.flowCookie)||''),hidden(fields.token||''),tr('recovery.complete')));
  }
  const result=await options.service.completeFactorRecovery({token:fields.token||'',browserToken});
  const headers=http.sessionHeaders(result.token);headers.push(['set-cookie',http.setCookie(browserCookie,'',0)]);
  return wantsJson(request)?jsonResponse(200,{enrollmentRequired:true,user:result.user,csrf:http.token(result.token)},headers):jsonResponse(303,{enrollmentRequired:true},[['location',mount+'/account'],...headers]);
 }};
}
