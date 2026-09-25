import { field as uiField, icon } from '@jimhoyd/urlcode-ui';
import { createHash, randomBytes } from 'node:crypto';
import { extensionHookContext, jsonResponse, wantsJson } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import type { AbuseChallengeWidget } from '@jimhoyd/urlcode-abuse';
import type { AuthServiceInternal } from './auth-core.ts';
import type { AuthExtensionOptions } from './auth.ts';
import type { Delivery } from './delivery.ts';
import type { PresentationContext } from './presentation.ts';
import type { RegistrationInput } from './registration.ts';
import { AuthHttp, AuthHttpError, csrfField, escapeHtml, formField, readAuthFields, screenResponse } from './auth-ui.ts';
import { Markup } from '@jimhoyd/urlcode-ui';

type SignupOptions = Omit<AuthExtensionOptions, 'service'> & { service: AuthServiceInternal; delivery: Delivery; challenge?: AbuseChallengeWidget | undefined };
/** Operator-owned signup orchestration. Only opaque browser-bound state is held in cookies. */
export function createSignup(options: SignupOptions, http: AuthHttp, mount: string, profile: { fields(p: PresentationContext): string; read(fields: Record<string,string>): RegistrationInput; names: string[] }) {
 const service=options.service, browserCookie='__Host-urlcode-signup-browser', flowCookie='__Host-urlcode-signup';
 const clear=()=>[['set-cookie',http.setCookie(flowCookie,'',0)]] as [string,string][];
 /** Best effort: the same public result is returned for every eligible identifier. */
 async function delivery(message: {kind:string;email:string;code?:string}, locale: string) {
  if(message.kind==='signup-code')await options.delivery.signupCode(message.email,message.code!,locale);
  else await options.delivery.notice(message.kind==='new-device'?'new-device':'registration-attempt',message.email,locale);
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
  const form=(action:string,fields:string,button:string)=>`<form class="ui-stack" method="post" action="${escapeHtml(mount+'/signup/'+action+'?lang='+encodeURIComponent(presentation.locale))}">${csrfField(prepared.csrf)}${fields}<button>${action==='begin'||action==='password'?icon('arrow-right'):action==='verify'?icon('check'):action==='complete'?icon('user'):''}${e(button)}</button></form>`;
  const field=(name:string,label:string,type='text',autocomplete='off')=>formField(name,text(label),type,autocomplete);
  if(request.method!=='POST') {
   if(path==='/signup/pending')return wantsJson(request)?jsonResponse(200,{pending:true},headers):screenResponse('Request an account',{name:'auth/status',view:{alert:false,message:text('Your request has been received. If eligible, an administrator will review it before you can sign in.'),href:null,label:null}},{status:200,headers,presentation,layout:'compact',ui:options.ui});
   let state;
   if(binding) { state=await service.getSignup(binding); if(!state)headers.push(...clear()); }
   if(wantsJson(request))return jsonResponse(200,{step:state?.step??'identifier',csrf:prepared.csrf,...(state?{expires:state.expires}:{})},headers);
   const verificationRequired = service.getSecurityPolicy().requireEmailVerification;
   const steps = ['Email address', ...(verificationRequired ? ['Verify email'] : []), 'Secure your account', 'Your details'];
   const currentStep = !state ? 0 : state.step === 'verify-email' ? 1 : state.step === 'credential' ? (verificationRequired ? 2 : 1) : steps.length - 1;
   const progress = steps.map((label,index)=>({number:index+1,label:text(label),current:index===currentStep}));
   const title = !state ? (service.getRegistrationMode()==='waitlist' ? 'Request an account' : 'Create account') : state.step === 'verify-email' ? 'Check your email' : state.step === 'credential' ? (options.passkeys ? 'Secure your account' : 'Create a password') : 'Your details';
   let intro:string, markup:string, passkey='', identifier:string|null=null;
   if(!state){
    const invitations=request.query.getAll('token');
    if(invitations.length>1||(invitations[0]&&!/^[A-Za-z0-9_-]{43}$/.test(invitations[0])))throw new AuthHttpError(400,'Invalid invitation');
    intro='';markup=form('begin',field('email','Email address','email','email')+'<div hidden><label>Leave empty<input name="website" tabindex="-1" autocomplete="off"></label></div>'+(service.getRegistrationMode()==='invite-only'?(invitations[0]?`<input type="hidden" name="invitationToken" value="${escapeHtml(invitations[0])}">`:field('invitationToken','Invitation token')):''),'Continue');
   }
   else if(state.step==='verify-email'){intro=text('If this address is eligible, a signup code has been sent. Enter the code to continue.');identifier=state.email;markup=form('verify',field('code','Email code','text','one-time-code'),'Verify email');}
   else if(state.step==='credential'){intro=options.passkeys?text('Use a password or passkey.'):'';markup=form('password',uiField({name:'password',label:text('Password'),type:'password',autocomplete:'new-password',required:true,description:text('At least 15 characters. Use a unique password.')}),'Continue');passkey=options.passkeys?`<button class="ui-button-secondary" type="button" data-passkey="signup" data-base="${escapeHtml(mount)}" data-failed="${e('Passkey request failed')}" data-unavailable="${e('Passkeys are unavailable in this browser. Use another sign-in method.')}" data-cancelled="${e('Passkey ceremony cancelled')}">${e('Create a passkey')}</button><p role="status" aria-live="polite" data-passkey-status></p>`:'';}
   else {intro=service.getRegistrationMode()==='waitlist'?text('An administrator must approve your request.'):'';markup=form('complete',profile.fields(presentation),service.getRegistrationMode()==='waitlist' ? 'Request account' : 'Create account');}
   const restart=state?{summary:text('Use a different email address'),help:text('Starting again clears this signup progress. No account is created until you finish.'),form:new Markup(form('restart','','Start again').replace('<button>', '<button class="ui-button-secondary">'))}:null;
   const view={progressLabel:presentation.text('ux.signupProgress',{current:currentStep+1,total:steps.length}),stepsLabel:text('Account setup progress'),steps:progress,email:state&&state.step!=='verify-email'?state.email:null,changeLabel:text('Change'),intro,identifier,form:new Markup(markup),passkey:new Markup(passkey),restart,signInPrompt:text('Already have an account?'),signInHref:mount+'/login?lang='+encodeURIComponent(presentation.locale),signInLabel:text('Sign in')};
   return screenResponse(title,{name:'auth/signup',view},{status:200,headers,scriptPath:state?.step==='credential'&&options.passkeys?mount+'/assets/passkeys.js':undefined,presentation,challenge:!state?options.challenge:undefined,layout:'compact',ui:options.ui});
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
  const fields=readAuthFields(request,['email','invitationToken','code','password','website',...profile.names]);http.verify(request,fields);
  if(path==='/signup/restart')return redirect(clear());
  if(path==='/signup/begin') {
   if(service.getSecurityPolicy().requireEmailVerification&&!options.delivery.available)throw new AuthHttpError(503,'Email delivery is not configured');
   const started=await service.beginSignup({email:fields.email||'',browserHash,...(fields.invitationToken?{invitationToken:fields.invitationToken}:{}),context:extensionHookContext(request)});
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
   const device=http.device(request),result=await service.completeSignup({...binding,profile:profile.read(fields),device:{id:device.id,label:device.label},context:extensionHookContext(request)});
   const resultHeaders=[...headers,...clear(),...(result?http.sessionHeaders(result.token):[])];
   if(result?.newDevice)await delivery({kind:'new-device',email:result.user.email},options.presentation?.resolve({...(result.user.profile?.locale?{accountLocale:result.user.profile.locale}:{}),queryLocale:presentation.locale}).locale??presentation.locale);
   // One redirect target regardless of outcome (JSON-API.md's no-enumeration guarantee): an
   // existing-email attempt completes with `result` null and no session, so `/account` simply
   // bounces an unauthenticated visitor onward; a real registration lands there authenticated.
   const target=mount+(service.getRegistrationMode()==='waitlist'?'/signup/pending':'/account');
   return wantsJson(request)?jsonResponse(200,{complete:true,redirect:target,...(result?{csrf:http.token(result.token)}:{})},resultHeaders):jsonResponse(303,{redirect:target},[['location',target],...resultHeaders]);
  } else throw new AuthHttpError(404,'Page not found');
  return wantsJson(request)?jsonResponse(200,{step:(await service.getSignup(binding))?.step},headers):redirect();
 };
}
