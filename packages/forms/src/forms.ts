import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { assertSafePattern, extensionHookContext, extensionHooksSchema, loadExtensionHooks, maxPatternInputLength } from '@jimhoyd/urlcode/extensions';
import type { ExtensionAuthoringContract, ExtensionHookContract, ExtensionInstance, ExtensionRequest, HandlerResult, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { alert, escapeHtml, field, markup, postForm } from '@jimhoyd/urlcode-ui';
import { createSignedToken, readSignedToken } from '@jimhoyd/urlcode-ui/host';
import type { UiExtension } from '@jimhoyd/urlcode-ui/host';

const FLOW=/^[a-z][a-z0-9-]{0,63}$/, FIELD=/^[a-z][A-Za-z0-9_]{0,63}$/;
const MAX_BODY=64 * 1024, TOKEN_TTL=10 * 60 * 1000;
const CSRF_PURPOSE='urlcode-forms-csrf', CSRF_COOKIE='__Host-urlcode-forms-csrf';
/** Confirmation handoff (#527): only `confirmation.show` values, sealed for 5 minutes, at most 2 KiB of plaintext. */
const CONFIRMATION_PURPOSE='urlcode-forms-confirmation-v1', CONFIRMATION_COOKIE='__Host-urlcode-forms-confirmation', CONFIRMATION_TTL=5 * 60 * 1000, CONFIRMATION_MAX_PLAINTEXT=2048;
const PLACEHOLDER=/\{([a-z][A-Za-z0-9_]{0,63})\}/g;
type Control='input'|'textarea'|'select'|'checkbox';
type InputType='text'|'email'|'number'|'tel'|'url'|'date'|'datetime-local';

interface FormOption { value:string; label:string }
export interface FormFieldSpec { label:string; control?:Control; type?:InputType; required?:boolean; minLength?:number; maxLength?:number; minimum?:DateBound; maximum?:DateBound; pattern?:string; enum?:string[]; options?:FormOption[]; description?:string; requiredWhen?:RequiredWhen }
/** One-level conditional requirement (#528): the field is required when sibling `field` (a select or enum field) was submitted with one of `in`, and optional otherwise. */
export interface RequiredWhen { field:string; in:string[] }
/** Relative date bound (#705): the flow's "today" moved by a signed ISO 8601 duration of years, months and days. */
export interface RelativeDateBound { from:'today'; add:string }
/** A number (`type: number`), an absolute date or date-time string, `today`, or a {@link RelativeDateBound} (the last two for `date` and `datetime-local` only). */
export type DateBound=number|string|RelativeDateBound;
export interface FormFlowSpec { mount:string; title:string; timeZone?:string; submitLabel:string; confirmation:{title:string; message:string; show?:string[]}; fields:Record<string,FormFieldSpec> }
interface FormConfig { flows:Record<string,FormFlowSpec>; hooks?:Record<string,unknown> }
/** `now` is a clock override for tests (epoch milliseconds); relative date bounds read it per request. */
export interface FormsExtensionOptions { projectSha256:string; csrfSecret:string|Uint8Array; ui:UiExtension; now?:()=>number }

const stringSchema={type:'string',minLength:1,maxLength:512};
/** Relative bound durations: signed, years/months/days only, at least one part (`P2Y`, `-P18Y`, `P1Y6M`, `P30D`). */
const DURATION=/^(-?)P(?=\d)(?:(\d{1,5})Y)?(?:(\d{1,5})M)?(?:(\d{1,5})D)?$/, ZONE=/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/;
/** A bound is a number for `type: number`, or a `YYYY-MM-DD` date / `YYYY-MM-DDTHH:MM` local date and time, `today` or `{from: today, add: <duration>}` for the date types; validateFlow checks which applies. */
const boundSchema={anyOf:[{type:'number'},{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2})?$'},{const:'today'},{type:'object',additionalProperties:false,required:['from','add'],properties:{from:{const:'today'},add:{type:'string',pattern:DURATION.source}}}]};
const fieldSchema={type:'object',additionalProperties:false,required:['label'],properties:{
  label:stringSchema,control:{enum:['input','textarea','select','checkbox']},type:{enum:['text','email','number','tel','url','date','datetime-local']},required:{type:'boolean'},
  minLength:{type:'integer',minimum:0,maximum:65536},maxLength:{type:'integer',minimum:1,maximum:65536},minimum:boundSchema,maximum:boundSchema,pattern:{type:'string',minLength:1,maxLength:maxPatternInputLength},enum:{type:'array',minItems:1,maxItems:128,uniqueItems:true,items:{type:'string',maxLength:512}},description:{type:'string',maxLength:512},
  requiredWhen:{type:'object',additionalProperties:false,required:['field','in'],properties:{field:{type:'string',pattern:FIELD.source},in:{type:'array',minItems:1,maxItems:128,uniqueItems:true,items:{type:'string',maxLength:512}}}},
  options:{type:'array',minItems:1,maxItems:128,items:{type:'object',additionalProperties:false,required:['value','label'],properties:{value:{type:'string',maxLength:512},label:{type:'string',maxLength:512}}}},
}};
export const formHookContracts=[{name:'onSubmit',kind:'action',description:'Runs after the extension has admitted and validated a form submission, before the confirmation redirect. It is trusted project code and receives only declared field values.',inputSchema:{type:'object',additionalProperties:false,required:['flow','values'],properties:{flow:{type:'string'},values:{type:'object'}}}}] as const satisfies readonly ExtensionHookContract[];
export const formsConfigSchema={type:'object',additionalProperties:false,required:['flows'],properties:{
  hooks:extensionHooksSchema(formHookContracts),
  flows:{type:'object',minProperties:1,maxProperties:16,propertyNames:{pattern:FLOW.source},additionalProperties:{type:'object',additionalProperties:false,required:['mount','title','submitLabel','confirmation','fields'],properties:{
    mount:{type:'string',pattern:'^/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$',maxLength:256},title:stringSchema,timeZone:{type:'string',pattern:ZONE.source},submitLabel:stringSchema,
    confirmation:{type:'object',additionalProperties:false,required:['title','message'],properties:{title:stringSchema,message:{type:'string',minLength:1,maxLength:2048},show:{type:'array',minItems:1,maxItems:32,uniqueItems:true,items:{type:'string',pattern:FIELD.source}}}},
    fields:{type:'object',minProperties:1,maxProperties:32,propertyNames:{pattern:FIELD.source},additionalProperties:fieldSchema},
  }}
}}} as const;
export const formsAuthoring:ExtensionAuthoringContract={
  description:'Declare a bounded server-rendered form flow with fixed fields and a confirmation page that can show opted-in submitted values (confirmation.show). The forms extension owns HTML escaping, admission, CSRF and field validation; attach auth on the mount when submissions need a signed-in caller.',
  surfaces:[
    {kind:'configuration',name:'flows',description:'Declare each mounted form, its bounded fields, explicit submit label and confirmation page.',path:'urlcode.yaml#extensions.forms.config.flows'},
    {kind:'hook',name:'onSubmit',description:'Optional trusted project action, called only after successful form validation and CSRF admission. It is not sandboxed and must keep external effects idempotent.',path:'urlcode.yaml#extensions.forms.config.hooks.onSubmit'},
    {kind:'extension',name:'mount',description:'Mount each flow as `/contact/*` with GET, HEAD and POST. Add `auth: true` when the form is for signed-in callers.',path:'urlcode.yaml'},
  ],fastChecks:['urlcode validate --project . --host-file <host.mjs> --origin <origin>','urlcode test --project . --host-file <host.mjs> --origin <origin>'],
};

function fail(status:number,message:string):HandlerResult {return {status,headers:[['content-type','text/html; charset=utf-8']],body:message};}
function redirect(path:string,extraHeaders:[string,string][]=[]):HandlerResult {return {status:303,headers:[['location',path],...extraHeaders]};}
/**
 * The signed token carries a purpose tag (domain-separated from any other `createSignedToken`
 * user sharing the same secret) and the caller's double-submit binding value, so a token minted
 * for one browser cannot be replayed by a different one, or for a different flow, before its TTL
 * — see "Cross-site request forgery" in SECURITY.md. It is not single-use: a caller may still
 * resubmit the same valid token again within the TTL (also documented there).
 */
function token(secret:string|Uint8Array,flow:string,binding:string):string {return createSignedToken(secret,{flow,purpose:CSRF_PURPOSE,binding},TOKEN_TTL);}
function validToken(secret:string|Uint8Array,flow:string,binding:string|undefined,value:string|undefined):boolean {const parsed=readSignedToken(secret,value,TOKEN_TTL);return parsed?.flow===flow&&parsed?.purpose===CSRF_PURPOSE&&typeof parsed?.binding==='string'&&binding!==undefined&&parsed.binding===binding;}
function cookie(request:ExtensionRequest,cookieName:string,shape:RegExp):string|undefined {const header=request.headers.get('cookie');if(!header)return undefined;for(const part of header.split(';')){const index=part.indexOf('=');if(index===-1)continue;const name=part.slice(0,index).trim(),value=part.slice(index+1).trim();if(name===cookieName&&shape.test(value))return value;}return undefined;}
function bindingCookie(request:ExtensionRequest):string|undefined {return cookie(request,CSRF_COOKIE,/^[A-Za-z0-9_-]{16,128}$/);}
/**
 * The confirmation handoff is a stateless sealed cookie rather than server state, because forms runs
 * on node, aws and vercel, where the confirmation GET may reach a different instance than the POST.
 * AES-256-GCM (encryption plus authentication) under a key derived from the CSRF secret with HKDF
 * (domain-separated by `CONFIRMATION_PURPOSE`), with the flow name and the caller's CSRF binding
 * cookie as additional authenticated data: a value sealed for one flow or one browser does not open
 * for another. The plaintext carries only the flow's `confirmation.show` values and an expiry, never
 * reaches a URL, and the confirmation GET clears the cookie whatever its state.
 */
function confirmationKey(secret:string|Uint8Array):Buffer {return Buffer.from(hkdfSync('sha256',secret,Buffer.alloc(0),CONFIRMATION_PURPOSE,32));}
function confirmationAad(flow:string,binding:string):Buffer {return Buffer.from(`${CONFIRMATION_PURPOSE}\0${flow}\0${binding}`);}
function sealConfirmation(key:Buffer,flow:string,binding:string,values:Record<string,string>):string|undefined {const plaintext=Buffer.from(JSON.stringify({expires:Date.now()+CONFIRMATION_TTL,values}));if(plaintext.byteLength>CONFIRMATION_MAX_PLAINTEXT)return undefined;const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});cipher.setAAD(confirmationAad(flow,binding));const sealed=Buffer.concat([cipher.update(plaintext),cipher.final()]);return Buffer.concat([iv,sealed,cipher.getAuthTag()]).toString('base64url');}
/** Returns the sealed `show` values, or `undefined` for a missing, expired, tampered, other-flow or other-browser value. Never throws. */
function openConfirmation(key:Buffer,flow:string,binding:string|undefined,value:string|undefined,show:readonly string[]):Record<string,string>|undefined {
  if(binding===undefined||value===undefined)return undefined;
  try{const raw=Buffer.from(value,'base64url');if(raw.byteLength<12+16+2)return undefined;const decipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12),{authTagLength:16});decipher.setAAD(confirmationAad(flow,binding));decipher.setAuthTag(raw.subarray(raw.byteLength-16));const parsed=JSON.parse(Buffer.concat([decipher.update(raw.subarray(12,raw.byteLength-16)),decipher.final()]).toString('utf8')) as unknown;
    if(parsed===null||typeof parsed!=='object')return undefined;const {expires,values}=parsed as {expires?:unknown;values?:unknown};
    if(typeof expires!=='number'||!Number.isSafeInteger(expires)||expires<Date.now()||expires>Date.now()+CONFIRMATION_TTL||values===null||typeof values!=='object')return undefined;
    const shown:Record<string,string>={};for(const name of show){const entry=(values as Record<string,unknown>)[name];if(typeof entry!=='string')return undefined;shown[name]=entry;}return shown;
  }catch{return undefined;}
}
const confirmationCookieAttributes='Path=/; Secure; HttpOnly; SameSite=Strict';
function setConfirmationCookie(value:string):[string,string] {return ['set-cookie',`${CONFIRMATION_COOKIE}=${value}; ${confirmationCookieAttributes}; Max-Age=${CONFIRMATION_TTL/1000}`];}
function clearConfirmationCookie():[string,string] {return ['set-cookie',`${CONFIRMATION_COOKIE}=; ${confirmationCookieAttributes}; Max-Age=0`];}
function setBindingCookie(value:string):[string,string] {return ['set-cookie',`${CSRF_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil(TOKEN_TTL/1000)}`];}
/** Absent `Origin` (same-origin browser navigations sometimes omit it) falls back to `Sec-Fetch-Site`,
 * then `Referer`; with no evidence of either, the request is refused rather than admitted. */
function sameOriginFallback(request:ExtensionRequest,origin:string):boolean {const site=request.headers.get('sec-fetch-site');if(site)return site==='same-origin'||site==='none';const referer=request.headers.get('referer');if(referer){try{return new URL(referer).origin===origin;}catch{return false;}}return false;}
function validateFlow(name:string,flow:FormFlowSpec):void {if(!FLOW.test(name))throw new Error(`Invalid form flow: ${name}`);if(!flow.mount||!flow.mount.startsWith('/'))throw new Error(`Form ${name}: invalid mount`);if(flow.timeZone!==undefined)zoneFormat(name,flow.timeZone);for(const [fieldName,spec] of Object.entries(flow.fields)){if(!FIELD.test(fieldName))throw new Error(`Form ${name}: invalid field ${fieldName}`);const control=spec.control??'input',numeric=spec.type==='number',dated=spec.type==='date'||spec.type==='datetime-local';if(control==='select'&&(!spec.options?.length))throw new Error(`Form ${name}: select ${fieldName} needs options`);if(control!=='select'&&spec.options)throw new Error(`Form ${name}: options apply only to select ${fieldName}`);if(control!=='input'&&control!=='checkbox'&&spec.type)throw new Error(`Form ${name}: type applies only to input ${fieldName}`);if(control==='checkbox'&&(spec.type||spec.minLength!==undefined||spec.maxLength!==undefined||spec.minimum!==undefined||spec.maximum!==undefined||spec.pattern||spec.enum))throw new Error(`Form ${name}: checkbox ${fieldName} cannot have a type or bounds`);if(numeric&&(spec.minLength!==undefined||spec.maxLength!==undefined||spec.pattern||spec.enum))throw new Error(`Form ${name}: string rules do not apply to numeric ${fieldName}`);for(const bound of ['minimum','maximum'] as const){const value=spec[bound];if(value===undefined)continue;if(numeric?typeof value!=='number':!dated)throw new Error(`Form ${name}: ${bound} of ${fieldName} requires type number, date or datetime-local`);if(dated&&(value==='today'||typeof value==='object')){if(!relativeShift(value))throw new Error(`Form ${name}: ${bound} of ${fieldName} must be today or {from: today, add: <duration>}, the duration a signed ISO 8601 period of years, months and days such as P30D or -P18Y`);continue;}if(dated&&(typeof value!=='string'||!(spec.type==='date'?validDate(value):DATETIME_BOUND.test(value)&&validDateTimeLocal(value))))throw new Error(`Form ${name}: ${bound} of ${fieldName} must be ${spec.type==='date'?'a YYYY-MM-DD date':'a YYYY-MM-DDTHH:MM local date and time'}`);}if(spec.minLength!==undefined&&spec.maxLength!==undefined&&spec.minLength>spec.maxLength)throw new Error(`Form ${name}: ${fieldName} minLength exceeds maxLength`);if(boundsInverted(spec))throw new Error(`Form ${name}: ${fieldName} minimum exceeds maximum`);if(spec.pattern!==undefined){if(spec.maxLength===undefined||spec.maxLength>maxPatternInputLength)throw new Error(`Form ${name}: pattern ${fieldName} requires maxLength at most ${maxPatternInputLength}`);try{assertSafePattern(spec.pattern);}catch(error){throw new Error(`Form ${name}: pattern ${fieldName} ${(error as Error).message}`,{cause:error});}}if(spec.requiredWhen)validateRequiredWhen(name,flow,fieldName,spec);}const show=flow.confirmation.show??[];for(const fieldName of show)if(!Object.hasOwn(flow.fields,fieldName))throw new Error(`Form ${name}: confirmation show lists undeclared field ${fieldName}`);for(const match of flow.confirmation.message.matchAll(PLACEHOLDER))if(!show.includes(match[1]!))throw new Error(`Form ${name}: confirmation placeholder {${match[1]}} is not listed in show`);}
/** The values a sibling field can admit, when that set is fixed: a select's option values (narrowed by its `enum`, if any) or an input's `enum`. */
function fixedValues(spec:FormFieldSpec):string[]|undefined {const control=spec.control??'input';if(control==='select')return spec.options!.map(option=>option.value).filter(value=>!spec.enum||spec.enum.includes(value));return control==='input'&&spec.enum?spec.enum:undefined;}
/** `requiredWhen` replaces `required` rather than qualifying it (fields are required by default, so `required: true` would contradict it and `required: false` would only restate it); its sibling must have a fixed value set, every `in` value must be one of those, and the sibling cannot itself be conditional. */
function validateRequiredWhen(name:string,flow:FormFlowSpec,fieldName:string,spec:FormFieldSpec):void {const when=spec.requiredWhen!,target=when.field;if(spec.required!==undefined)throw new Error(`Form ${name}: ${fieldName} declares both required and requiredWhen; requiredWhen alone makes it optional unless the condition holds`);if(target===fieldName)throw new Error(`Form ${name}: requiredWhen of ${fieldName} cannot reference the field itself`);if(!Object.hasOwn(flow.fields,target))throw new Error(`Form ${name}: requiredWhen of ${fieldName} references undeclared field ${target}`);const sibling=flow.fields[target]!;if(sibling.requiredWhen)throw new Error(`Form ${name}: requiredWhen of ${fieldName} references ${target}, which has its own requiredWhen; conditions are one level only`);const allowed=fixedValues(sibling);if(!allowed)throw new Error(`Form ${name}: requiredWhen of ${fieldName} references ${target}, which is not a select or enum field`);if(!when.in.length)throw new Error(`Form ${name}: requiredWhen of ${fieldName} needs at least one value`);if(new Set(when.in).size!==when.in.length)throw new Error(`Form ${name}: requiredWhen of ${fieldName} lists a value twice`);for(const value of when.in)if(!allowed.includes(value))throw new Error(`Form ${name}: requiredWhen of ${fieldName} lists ${JSON.stringify(value)}, which ${target} does not allow`);}
/** Whether a field is required for this submission: unconditionally unless `required: false`, or, with `requiredWhen`, only when its sibling was supplied once with one of the listed values. */
function isRequired(spec:FormFieldSpec,form:URLSearchParams):boolean {if(!spec.requiredWhen)return spec.required!==false;const entries=form.getAll(spec.requiredWhen.field);return entries.length===1&&spec.requiredWhen.in.includes(entries[0]!);}
function formValues(flow:FormFlowSpec, today:string, values:Record<string,string>, errors:Record<string,string>):string {return Object.entries(flow.fields).map(([name,spec])=>{const control=spec.control??'input',uiControl=control==='checkbox'?'input':control;return field({name,label:spec.label,control:uiControl,...(control==='input'?{type:spec.type??'text',...(spec.type==='date'||spec.type==='datetime-local'?boundAttributes(spec,today):{})}:control==='checkbox'?{type:'checkbox'}:{}),required:spec.requiredWhen===undefined&&spec.required!==false,...(spec.description===undefined?{}:{description:spec.description}),...(errors[name]===undefined?{}:{error:errors[name]}),...(control==='checkbox'?{checked:values[name]==='true'}:{value:values[name]??''}),...(control==='textarea'?{maxLength:spec.maxLength??4096}:{}),...(control==='select'?{options:spec.options!,placeholder:'Choose one'}:{})});}).join('');}
function boundAttributes(spec:FormFieldSpec,today:string):{min?:string;max?:string} {const min=resolveBound(spec,'minimum',today),max=resolveBound(spec,'maximum',today);return {...(min===undefined?{}:{min}),...(max===undefined?{}:{max})};}
function render(ui:UiExtension, name:string, flow:FormFlowSpec, today:string, csrf:string, values:Record<string,string>={}, errors:Record<string,string>={}, status=200, extraHeaders:[string,string][]=[]):HandlerResult {const body=(Object.keys(errors).length?alert('Correct the highlighted fields.','error'):'')+postForm({action:flow.mount,csrf,fields:formValues(flow,today,values,errors),label:flow.submitLabel,className:'ui-form-grid'});const page=ui.kit.wrap(markup(body),{title:flow.title});return {status,headers:[...page.headers,...extraHeaders],body:page.body};}
/** A shown checkbox reads Yes/No and a shown select its option label; every other value is shown as submitted. */
function shownValue(spec:FormFieldSpec,value:string):string {if(spec.control==='checkbox')return value==='true'?'Yes':'No';if(spec.control==='select')return spec.options?.find(option=>option.value===value)?.label??value;return value;}
/**
 * Without `shown` (no handoff, or one that did not open) this is the fixed page: each `{field}`
 * placeholder renders as nothing. With it, placeholders are substituted in one pass after the message
 * is escaped (so a value cannot introduce markup or a further placeholder), and shown fields the
 * message does not reference follow as a label/value list.
 */
function confirmation(ui:UiExtension, flow:FormFlowSpec, shown?:Record<string,string>, extraHeaders:[string,string][]=[]):HandlerResult {const used=new Set<string>();const message=escapeHtml(flow.confirmation.message).replace(PLACEHOLDER,(_,name:string)=>{used.add(name);return shown?escapeHtml(shownValue(flow.fields[name]!,shown[name]!)):'';});const list=shown?(flow.confirmation.show??[]).filter(name=>!used.has(name)).map(name=>`<div><dt>${escapeHtml(flow.fields[name]!.label)}</dt><dd>${escapeHtml(shownValue(flow.fields[name]!,shown[name]!))}</dd></div>`).join(''):'';const page=ui.kit.wrap(markup(`<section class="ui-stack"><h1>${escapeHtml(flow.confirmation.title)}</h1><p>${message}</p>${list?`<dl>${list}</dl>`:''}</section>`),{title:flow.confirmation.title});return {status:200,headers:[...page.headers.filter(([header])=>header.toLowerCase()!=='cache-control'),['cache-control','no-store'],...extraHeaders],body:page.body};}
function readForm(request:ExtensionRequest):URLSearchParams|null|undefined {if(request.body.byteLength>MAX_BODY)return undefined;const type=request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();if(type!=='application/x-www-form-urlencoded')return null;try{return new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(request.body));}catch{return undefined;}}
/** HTML `date` and `datetime-local` submission formats (HTML "valid date string" and "valid normalized local date and time string"): a four-digit year from 0001, a real calendar day, `T`, 24-hour time with optional seconds and up to three fractional digits, and no timezone offset. */
/** Date-time bounds are whole minutes: the browser uses `min` as the step base, and the default 60-second step would otherwise demand the bound's seconds on every value. */
const DATETIME_BOUND=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DATE=/^(\d{4})-(\d{2})-(\d{2})$/,DATETIME_LOCAL=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;
function calendarDay(year:number,month:number,day:number):boolean {const leap=year%4===0&&(year%100!==0||year%400===0);return year>=1&&month>=1&&month<=12&&day>=1&&day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1]!;}
function validDate(value:string):boolean {const match=DATE.exec(value);return !!match&&calendarDay(Number(match[1]),Number(match[2]),Number(match[3]));}
function validDateTimeLocal(value:string):boolean {const match=DATETIME_LOCAL.exec(value);return !!match&&calendarDay(Number(match[1]),Number(match[2]),Number(match[3]))&&Number(match[4])<=23&&Number(match[5])<=59&&(match[6]===undefined||Number(match[6])<=59);}
/** A fixed-width `YYYY-MM-DDTHH:MM:SS.mmm` form of a valid date-time, so values of different precision compare as strings; a valid date is already fixed-width. */
function dateKey(value:string):string {if(value.length===10)return value;const [main,fraction='']=value.split('.') as [string,string?];return `${main.length===16?`${main}:00`:main}.${fraction.padEnd(3,'0')}`;}
/**
 * Relative date bounds (#705). "Today" is the calendar date in the flow's declared IANA `timeZone`,
 * or UTC when none is declared, never the host's zone, so one project resolves identically on node,
 * aws and vercel. It is read per request: the server check is authoritative, while the rendered
 * `min`/`max` reflect the moment the page was served and can go stale across midnight.
 */
function zoneFormat(flow:string,timeZone='UTC'):Intl.DateTimeFormat {const refuse=(cause?:unknown)=>new Error(`Form ${flow}: timeZone ${JSON.stringify(timeZone)} is not a known IANA time zone name such as Europe/London`,cause===undefined?undefined:{cause});if(!ZONE.test(timeZone))throw refuse();try{return new Intl.DateTimeFormat('en-US',{timeZone,calendar:'gregory',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit'});}catch(error){throw refuse(error);}}
function todayIn(format:Intl.DateTimeFormat,now:number):string {const parts=Object.fromEntries(format.formatToParts(now).map(part=>[part.type,part.value]));return `${String(parts.year).padStart(4,'0')}-${parts.month}-${parts.day}`;}
interface DateShift { sign:1|-1; years:number; months:number; days:number }
/** `today` is a zero shift; `{from: today, add}` parses its duration. Anything else (including an absolute bound) is `undefined`. */
function relativeShift(bound:unknown):DateShift|undefined {if(bound==='today')return {sign:1,years:0,months:0,days:0};if(bound===null||typeof bound!=='object'||Array.isArray(bound))return undefined;const {from,add,...rest}=bound as {from?:unknown;add?:unknown};const match=from==='today'&&typeof add==='string'&&!Object.keys(rest).length?DURATION.exec(add):null;return match?{sign:match[1]?-1:1,years:Number(match[2]??0),months:Number(match[3]??0),days:Number(match[4]??0)}:undefined;}
/**
 * Years and months move first and the day is clamped to the end of the resulting month (Jan 31 + P1M
 * is Feb 28, or Feb 29 in a leap year; Feb 29 - P18Y is Feb 28), then days move. A result before
 * 0001-01-01 or after 9999-12-31 clamps to that date, which no submitted four-digit-year value can cross.
 */
function shiftDate(date:string,shift:DateShift):string {const [year,month,day]=date.split('-').map(Number) as [number,number,number];const total=year*12+month-1+shift.sign*(shift.years*12+shift.months),targetYear=Math.floor(total/12),targetMonth=total-targetYear*12;const last=new Date(0);last.setUTCFullYear(targetYear,targetMonth+1,0);const at=new Date(0);at.setUTCFullYear(targetYear,targetMonth,Math.min(day,last.getUTCDate()));const result=new Date(at.getTime()+shift.sign*shift.days*86_400_000),resultYear=result.getUTCFullYear();if(resultYear<1)return '0001-01-01';if(resultYear>9999)return '9999-12-31';return `${String(resultYear).padStart(4,'0')}-${String(result.getUTCMonth()+1).padStart(2,'0')}-${String(result.getUTCDate()).padStart(2,'0')}`;}
/** A bound in the field's own format for a request whose date is `today`: an absolute bound as declared; a relative one's date, at 00:00 for a `datetime-local` minimum and 23:59 for a maximum (checked through 23:59:59.999, the end of that day). */
function resolveBound(spec:FormFieldSpec,bound:'minimum'|'maximum',today:string):string|undefined {const value=spec[bound];if(typeof value==='string'&&value!=='today')return value;const shift=relativeShift(value);if(!shift)return undefined;const date=shiftDate(today,shift);return spec.type==='date'?date:`${date}T${bound==='minimum'?'00:00':'23:59'}`;}
let referenceDays:string[]|undefined;
/** Two absolute bounds compare directly. Two relative bounds are refused when the window is empty on any day of a whole leap cycle (month-end clamping makes the order date-dependent: +P1M against +P30D). An absolute and a relative bound depend on the date and are not compared at load time. */
function boundsInverted(spec:FormFieldSpec):boolean {const low=spec.minimum,high=spec.maximum;if(low===undefined||high===undefined)return false;const lowShift=relativeShift(low),highShift=relativeShift(high);if(!lowShift&&!highShift)return (low as number|string)>(high as number|string);if(!lowShift||!highShift)return false;referenceDays??=Array.from({length:1461},(_,index)=>new Date(Date.UTC(2024,0,1+index)).toISOString().slice(0,10));return referenceDays.some(day=>shiftDate(day,lowShift)>shiftDate(day,highShift));}
function dateBoundError(spec:FormFieldSpec,value:string,today:string):string|undefined {const key=dateKey(value),minimum=resolveBound(spec,'minimum',today),maximum=resolveBound(spec,'maximum',today);if(minimum!==undefined&&key<dateKey(minimum))return `must be on or after ${minimum}`;if(maximum!==undefined&&key>(spec.type==='datetime-local'&&relativeShift(spec.maximum)?`${maximum}:59.999`:dateKey(maximum)))return `must be on or before ${maximum}`;return undefined;}
function admission(flow:FormFlowSpec, form:URLSearchParams, today:string):{values:Record<string,string>;errors:Record<string,string>} {const values:Record<string,string>={},errors:Record<string,string>={};for(const key of new Set(form.keys()))if(key!=='csrf'&&!Object.hasOwn(flow.fields,key))errors[key]='is not a declared field';for(const [name,spec] of Object.entries(flow.fields)){const entries=form.getAll(name);if(entries.length>1){errors[name]='must be supplied once';continue;}const raw=entries[0]??(spec.control==='checkbox'?'false':'');values[name]=raw;const value=spec.control==='checkbox'?(raw==='true'?'true':'false'):raw,required=isRequired(spec,form);let bounded:string|undefined;if(spec.control==='checkbox'){if(entries.length&&raw!=='true')errors[name]='must be true or absent';else if(required&&value!=='true')errors[name]='is required';continue;}if(required&&value===''){errors[name]='is required';continue;}if(value===''&&!required)continue;if(spec.minLength!==undefined&&value.length<spec.minLength)errors[name]=`must be at least ${spec.minLength} characters`;else if(spec.maxLength!==undefined&&value.length>spec.maxLength)errors[name]=`must be at most ${spec.maxLength} characters`;else if(spec.pattern!==undefined&&!new RegExp(spec.pattern,'u').test(value))errors[name]='does not match the declared pattern';else if(spec.enum&&!spec.enum.includes(value))errors[name]='is not an allowed value';else if(spec.control==='select'&&!spec.options?.some(option=>option.value===value))errors[name]='is not an allowed option';else if(spec.type==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))errors[name]='must be a valid email address';else if(spec.type==='date'&&!validDate(value))errors[name]='must be a valid date';else if(spec.type==='datetime-local'&&!validDateTimeLocal(value))errors[name]='must be a valid local date and time';else if((spec.type==='date'||spec.type==='datetime-local')&&(bounded=dateBoundError(spec,value,today))!==undefined)errors[name]=bounded;else if(spec.type==='number'){const number=Number(value);if(!Number.isFinite(number))errors[name]='must be a number';else if(typeof spec.minimum==='number'&&number<spec.minimum)errors[name]=`must be at least ${spec.minimum}`;else if(typeof spec.maximum==='number'&&number>spec.maximum)errors[name]=`must be at most ${spec.maximum}`;}}
return {values,errors};}

/** Creates the forms registration. The CSRF secret is a host-file/operator value and is deliberately absent from project YAML. */
export function createFormsExtension(options:FormsExtensionOptions):RuntimeExtension {if(!/^[a-f0-9]{64}$/.test(options.projectSha256))throw new Error('forms extension requires an explicit operator revision pin');if((typeof options.csrfSecret==='string'&&Buffer.byteLength(options.csrfSecret)<32)||(options.csrfSecret instanceof Uint8Array&&options.csrfSecret.byteLength<32))throw new Error('forms extension requires a CSRF secret of at least 32 bytes');return {name:'forms',version:'1',projectSha256:options.projectSha256,targets:['node','aws','vercel'],schema:formsConfigSchema,hooks:formHookContracts,authoring:formsAuthoring,async activate(raw,context):Promise<ExtensionInstance>{if(!options.ui.active)throw new Error('forms extension requires an active ui extension');const config=raw as unknown as FormConfig;for(const [name,flow] of Object.entries(config.flows)) {validateFlow(name,flow);if(!context.mounts.includes(flow.mount))throw new Error(`Form ${name}: route ${flow.mount}/* with extension: forms is not declared`);}for(const mount of context.mounts)if(!Object.values(config.flows).some(flow=>flow.mount===mount))throw new Error(`Forms mount ${mount} has no declared flow`);const sealKey=confirmationKey(options.csrfSecret);const now=options.now??Date.now;const byMount=new Map(Object.entries(config.flows).map(([name,flow])=>[flow.mount,{name,flow,zone:zoneFormat(name,flow.timeZone)}]));const hooks=await loadExtensionHooks<'onSubmit'>(config.hooks,formHookContracts,context);return {async handle(request){
  const active=request.mount===null?undefined:byMount.get(request.mount);if(!active)return fail(404,'Not found');
  const {name,flow,zone}=active;const suffix=request.path.slice(flow.mount.length);
  if(request.method==='GET'||request.method==='HEAD'){
    if(suffix!==''&&suffix!=='/confirmation')return fail(404,'Not found');
    // HEAD answers with the fixed page and leaves any handoff in place; GET opens it (when the flow
    // shows fields) and clears the cookie whether or not it opened, so a refresh shows the fixed page.
    if(suffix==='/confirmation'){
      if(request.method==='HEAD')return {...confirmation(options.ui,flow),body:undefined};
      const sealed=cookie(request,CONFIRMATION_COOKIE,/^[A-Za-z0-9_-]{1,4096}$/),show=flow.confirmation.show;
      const shown=show&&sealed!==undefined?openConfirmation(sealKey,name,bindingCookie(request),sealed,show):undefined;
      return confirmation(options.ui,flow,shown,request.headers.get('cookie')?.includes(CONFIRMATION_COOKIE)?[clearConfirmationCookie()]:[]);
    }
    // Reuse an existing binding cookie's value across renders (so a browser with several open tabs
    // on the same flow keeps one consistent value); mint one only when absent. The cookie is
    // re-issued on every render with a fresh Max-Age so it always outlives the token just minted
    // for this page (#551): otherwise a form loaded late in the cookie's window fails on submit.
    const binding=bindingCookie(request)??globalThis.crypto.randomUUID();
    const answer=render(options.ui,name,flow,todayIn(zone,now()),token(options.csrfSecret,name,binding),undefined,undefined,200,[setBindingCookie(binding)]);
    return request.method==='HEAD'?{...answer,body:undefined}:answer;
  }
  if(request.method!=='POST'||suffix!=='')return {status:405,headers:[['allow','GET, HEAD, POST'],['content-type','text/plain; charset=utf-8']],body:'Method not allowed'};
  // Same-origin admission: a present Origin must match exactly; an absent one (some legitimate
  // same-origin navigations omit it) falls back to Sec-Fetch-Site, then Referer, and is refused
  // with no evidence of either rather than admitted by default.
  const origin=request.headers.get('origin');
  if(origin!==null?origin!==context.origin:!sameOriginFallback(request,context.origin))return fail(403,'Forbidden');
  const parsed=readForm(request);if(parsed===undefined)return fail(413,'Form body is too large');if(parsed===null)return fail(415,'Form submission requires application/x-www-form-urlencoded');
  const csrf=parsed.get('csrf')??undefined,binding=bindingCookie(request);
  if(!validToken(options.csrfSecret,name,binding,csrf))return fail(403,'Forbidden');
  const today=todayIn(zone,now()),{values,errors}=admission(flow,parsed,today);
  if(Object.keys(errors).length)return render(options.ui,name,flow,today,token(options.csrfSecret,name,binding!),values,errors,422,[setBindingCookie(binding!)]);
  try{await hooks.onSubmit?.(Object.freeze({flow:name,values:Object.freeze({...values})}),extensionHookContext(request));}catch{return fail(500,'The form could not be submitted');}
  // Hand off only the opted-in values. A handoff over the size cap is not issued (and a stale one is
  // cleared), so the confirmation renders its fixed form.
  const show=flow.confirmation.show;if(!show)return redirect(`${flow.mount}/confirmation`);
  const sealed=sealConfirmation(sealKey,name,binding!,Object.fromEntries(show.map(field=>[field,values[field]!])));
  return redirect(`${flow.mount}/confirmation`,[sealed===undefined?clearConfirmationCookie():setConfirmationCookie(sealed)]);
}};}};}
