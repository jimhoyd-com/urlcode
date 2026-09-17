import type {ExtensionRequest} from '@jimhoyd/urlcode/extensions';
import type {AuthService} from './auth-core.ts';
import type {AuthChallenge} from './challenge.ts';
import {AuthHttp,AuthHttpError,jsonResponse,pageResponse,wantsJson,escapeHtml} from './auth-ui.ts';
import type {PresentationContext} from './presentation.ts';
import {isHoneypotFilled} from './registration.ts';
/** Entry requests only: callback and code/token redemption keep their own bound proofs. */
export function createAbuseGuard(service:AuthService,http:AuthHttp,mount:string,challenge?:AuthChallenge){
 const policy=service.getAbusePolicy();if(policy?.challengeAfter!==undefined&&!challenge)throw new Error('Challenge policy requires an operator verifier');
 let active=0;
 return async(request:ExtensionRequest,presentation?:PresentationContext)=>{
  const path=request.path.slice(mount.length),signup=path==='/register'||path==='/signup/begin';
  const entry=['/login','/register','/signup/begin','/forgot-password','/send-email-code','/recover-factor','/passkeys/login/options'].includes(path)||/^\/providers\/[a-z][a-z0-9-]{0,31}\/start$/.test(path);
  if(request.method!=='POST'||!entry)return;
  if(request.body.byteLength>16384)throw new AuthHttpError(413,'Request body too large');
  let fields:Record<string,unknown>={};const type=request.headers.get('content-type')?.split(';')[0];
  try{const raw=new TextDecoder('utf-8',{fatal:true}).decode(request.body);if(type==='application/json'){const value:unknown=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();fields=value as Record<string,unknown>;}else if(type==='application/x-www-form-urlencoded'){const entries=[...new URLSearchParams(raw)];if(new Set(entries.map(([key])=>key)).size!==entries.length)throw new Error();fields=Object.fromEntries(entries);}else throw new Error();}catch{throw new AuthHttpError(400,'Invalid authentication request');}
  if(Object.keys(fields).length>64||fields.csrf!==undefined&&typeof fields.csrf!=='string'||fields.challengeToken!==undefined&&(typeof fields.challengeToken!=='string'||fields.challengeToken.length>2048))throw new AuthHttpError(400,'Invalid authentication request');
  http.verify(request,{csrf:typeof fields.csrf==='string'?fields.csrf:''});
  if(signup&&isHoneypotFilled(fields.website))return jsonResponse(202,{message:'Registration request received.'});
  if(!policy)return;
  const admission=await service.admitAuthRequest({client:request.client,...(signup?{signupEmail:typeof fields.email==='string'?fields.email:''}:{})});
  if(!admission.challengeRequired)return;
  let passed=false;
  if(challenge&&typeof fields.challengeToken==='string'&&fields.challengeToken&&request.client&&active<32){
   active++;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
   const verification=Promise.resolve().then(()=>challenge.verify({token:fields.challengeToken as string,client:request.client!,signal:controller.signal}));void verification.finally(()=>{active--;}).catch(()=>{});
   try{passed=await Promise.race([verification,new Promise<boolean>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(false);},5000);})]);}catch{passed=false;}finally{if(timer)clearTimeout(timer);}
  }
  if(passed!==true){
   const source='Challenge required. Return to the form and try again.',message=presentation?.textSource(source)??source;
   if(wantsJson(request))return jsonResponse(403,{error:message,challengeRequired:true});
   const retry=signup?'/signup':path==='/forgot-password'||path==='/recover-factor'?path:path==='/send-email-code'?'/email-code':'/login';
   return pageResponse('Verification required',`<p role="alert">${escapeHtml(message)}</p><a href="${escapeHtml(mount+retry)}">${escapeHtml(presentation?.textSource('Try again')??'Try again')}</a>`,403,[],undefined,presentation);
  }
 };
}
