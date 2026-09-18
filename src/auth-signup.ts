import { createHash, randomBytes } from 'node:crypto';
import type { ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import type { AuthExtensionOptions } from './auth.ts';
import type { PresentationContext } from './presentation.ts';
import type { RegistrationInput } from './registration.ts';
import { AuthHttp, AuthHttpError, csrfField, escapeHtml, formField, jsonResponse, pageResponse, readFields, wantsJson } from './auth-ui.ts';

/** Operator-owned signup orchestration. Only opaque browser-bound state is held in cookies. */
export function createSignup(options: AuthExtensionOptions, http: AuthHttp, mount: string, profile: { fields(p: PresentationContext): string; read(fields: Record<string,string>): RegistrationInput; names: string[] }) {
 const service=options.service, browserCookie='__Host-urlcode-signup-browser', flowCookie='__Host-urlcode-signup';
 const clear=()=>[['set-cookie',http.setCookie(flowCookie,'',0)]] as [string,string][];
 async function delivery(message: {kind:string;email:string;code?:string}, locale: string) {
  const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>|undefined;
  try { const operation=message.kind==='signup-code' ? options.sendSignupCode?.({email:message.email,code:message.code!,locale,signal:controller.signal}) : options.sendNotice?.({email:message.email,event:message.kind==='new-device'?'new-device':'registration-attempt',locale,signal:controller.signal});
   if(!operation && message.kind==='signup-code') throw new AuthHttpError(503,'Email delivery is not configured');
   if(operation) await Promise.race([operation,new Promise<void>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Delivery timeout'));},5000);})]);
  } catch { /* The same public result is returned for every eligible identifier. */ }
  finally {if(timer)clearTimeout(timer);}
 }
 return async function handle(request:ExtensionRequest,presentation:PresentationContext) {
  const path=request.path.slice(mount.length);
  if(path!=='/signup'&&!path.startsWith('/signup/'))return undefined;
  if(!['open','invite-only','waitlist'].includes(service.getRegistrationMode()))throw new AuthHttpError(403,'Registration is disabled');
  if(!['GET','HEAD','POST'].includes(request.method))return jsonResponse(405,{error:'Method not allowed'},[['allow','GET, HEAD, POST']]);
  const existingBrowser=http.cookie(request,browserCookie), browser=existingBrowser||randomBytes(32).toString('base64url'), browserHash=createHash('sha256').update(browser).digest('hex');
  const flowId=http.cookie(request,flowCookie), binding=flowId?{flowId,browserHash}:undefined;
  const prepared=http.prepare(request), headers:[string,string][]=[...prepared.headers,['set-cookie',http.setCookie(browserCookie,browser,1800)]];
  const text=(source:string)=>presentation.textSource(source), e=(source:string)=>escapeHtml(text(source));
  const route=mount+'/signup?lang='+encodeURIComponent(presentation.locale);
  const redirect=(extra:[string,string][]=[])=>(jsonResponse(303,{redirect:route},[['location',route],...headers,...extra]));
  const form=(action:string,fields:string,button:string)=>`<form method="post" action="${escapeHtml(mount+'/signup/'+action+'?lang='+encodeURIComponent(presentation.locale))}">${csrfField(prepared.csrf)}${fields}<button>${e(button)}</button></form>`;
  const field=(name:string,label:string,type='text',autocomplete='off')=>formField(name,text(label),type,autocomplete);
  if(request.method!=='POST') {
   if(path==='/signup/pending')return wantsJson(request)?jsonResponse(200,{pending:true},headers):pageResponse('Request an account',`<p>${e('Your request has been received. If eligible, an administrator will review it before you can sign in.')}</p>`,200,headers,undefined,presentation,undefined,'compact');
   let state;
   if(binding) { state=await service.getSignup(binding); if(!state)headers.push(...clear()); }
   if(wantsJson(request))return jsonResponse(200,{step:state?.step??'identifier',csrf:prepared.csrf,...(state?{expires:state.expires}:{})},headers);
   let markup:string;
   if(!state){
    const invitations=request.query.getAll('token');
    if(invitations.length>1||(invitations[0]&&!/^[A-Za-z0-9_-]{43}$/.test(invitations[0])))throw new AuthHttpError(400,'Invalid invitation');
    markup=form('begin',field('email','Email address','email','email')+'<div hidden><label>Leave empty<input name="website" tabindex="-1" autocomplete="off"></label></div>'+(service.getRegistrationMode()==='invite-only'?(invitations[0]?`<input type="hidden" name="invitationToken" value="${escapeHtml(invitations[0])}">`:field('invitationToken','Invitation token')):''),'Continue');
   }
   else if(state.step==='verify-email')markup=`<p>${e('Check your email for a signup code. Enter it to continue.')}</p>`+form('verify',field('code','Email code','text','one-time-code'),'Verify email');
   else if(state.step==='credential')markup=form('password',field('password','Password (at least 15 characters)','password','new-password'),'Continue')+(options.passkeys?`<button type="button" data-passkey="signup" data-base="${escapeHtml(mount)}" data-failed="${e('Passkey request failed')}" data-unavailable="${e('Passkeys are unavailable in this browser. Use another sign-in method.')}" data-cancelled="${e('Passkey ceremony cancelled')}">${e('Create a passkey')}</button><p role="status" aria-live="polite" data-passkey-status></p>`:'');
   else markup=form('complete',profile.fields(presentation),'Create account');
   if(state)markup+=form('restart','','Start again');
   return pageResponse('Create account',markup,200,headers,state?.step==='credential'&&options.passkeys?mount+'/assets/passkeys.js':undefined,presentation,!state?options.challenge?.widget:undefined,'compact');
  }
  if(!existingBrowser)throw new AuthHttpError(403,'Signup browser binding required');
  // WebAuthn returns nested JSON; parse its bounded envelope separately from ordinary form fields.
  if(path==='/signup/passkeys/verify') {
   http.verify(request,{});
   if(!binding||!options.passkeys||request.body.byteLength>16384||request.headers.get('content-type')?.split(';')[0]!=='application/json')throw new AuthHttpError(400,'Invalid passkey request');
   let payload;try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(request.body));}catch{throw new AuthHttpError(400,'Invalid passkey request');}
   if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['response','flowId'].includes(key)))throw new AuthHttpError(400,'Invalid passkey request');
   const pending=await service.getSignupPasskeyChallenge(binding),credential=await options.passkeys.verifyRegistration(payload.response,pending.challenge);
   await service.setSignupPasskey({...binding,challenge:pending.challenge,credential});
   return jsonResponse(200,{step:'profile'},headers);
  }
  const fields=readFields(request,['email','invitationToken','code','password','website',...profile.names]);http.verify(request,fields);
  if(path==='/signup/restart')return redirect(clear());
  if(path==='/signup/begin') {
   if(service.getSecurityPolicy().requireEmailVerification&&!options.sendSignupCode)throw new AuthHttpError(503,'Email delivery is not configured');
   const started=await service.beginSignup({email:fields.email||'',browserHash,...(fields.invitationToken?{invitationToken:fields.invitationToken}:{})});
   if(started.delivery)await delivery(started.delivery,presentation.locale);
   const cookies:[string,string][]=[['set-cookie',http.setCookie(flowCookie,started.flowId,1800)]];
   return wantsJson(request)?jsonResponse(200,{step:started.step,expires:started.expires},[...headers,...cookies]):redirect(cookies);
  }
  if(!binding)throw new AuthHttpError(400,'Restart signup');
  if(path==='/signup/verify')await service.verifySignup({...binding,code:fields.code||''});
  else if(path==='/signup/password')await service.setSignupPassword({...binding,password:fields.password||''});
  else if(path==='/signup/passkeys/options') {
   if(!options.passkeys)throw new AuthHttpError(404,'Passkeys are not configured');
   const state=await service.getSignup(binding);if(!state||state.step!=='credential')throw new AuthHttpError(400,'Complete the previous signup step');
   const passkey=await options.passkeys.beginRegistration({id:state.accountId,email:state.email});
   await service.setSignupPasskeyChallenge({...binding,challenge:passkey.challenge});
   return jsonResponse(200,{options:passkey},headers);
  } else if(path==='/signup/complete') {
   const device=http.device(request),result=await service.completeSignup({...binding,profile:profile.read(fields),device:{id:device.id,label:device.label}});
   const resultHeaders=[...headers,...clear(),...(result?http.sessionHeaders(result.token):[])];
   if(result?.newDevice)await delivery({kind:'new-device',email:result.user.email},options.presentation?.resolve({...(result.user.profile?.locale?{accountLocale:result.user.profile.locale}:{}),queryLocale:presentation.locale}).locale??presentation.locale);
   // Existing-account attempts finish at sign-in; no existing credentials are replaced.
   const target=mount+(result?'/account':service.getRegistrationMode()==='waitlist'?'/signup/pending':'/login');
   return wantsJson(request)?jsonResponse(200,{complete:true,redirect:target,...(result?{csrf:http.token(result.token)}:{})},resultHeaders):jsonResponse(303,{redirect:target},[['location',target],...resultHeaders]);
  } else throw new AuthHttpError(404,'Page not found');
  return wantsJson(request)?jsonResponse(200,{step:(await service.getSignup(binding))?.step},headers):redirect();
 };
}
