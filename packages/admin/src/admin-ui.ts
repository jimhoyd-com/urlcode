/**
 * Renders one admin screen through the urlcode-ui kit. The kit is the only render path: admin requires the `ui`
 * extension and refuses to activate while it is inactive. Flows, permissions, freshness gates, escaping and headers
 * stay in the extension code that computes the view; the kit owns the document and the console shell around it.
 */
import {Markup,field} from '@jimhoyd/urlcode-ui';
import type {IconName,ViewModel} from '@jimhoyd/urlcode-ui';
import type {UiExtension} from '@jimhoyd/urlcode-ui/host';
import {ExtensionHttpError,jsonResponse,wantsJson} from '@jimhoyd/urlcode/extensions';
import type {ExtensionRequest,HandlerResult} from '@jimhoyd/urlcode/extensions';
import {adminTemplates} from './admin-templates.ts';
import type {AdminCopy} from './admin-copy.ts';
/** A refusal admin itself decides. The message is English source text from the admin catalogue, never request data. */
export class AdminHttpError extends Error {
 readonly status:number;
 constructor(status:number,message:string){super(message);this.name='AdminHttpError';this.status=status;}
}
/** One admin screen: an `admin/*` template name and the view the extension computed for it. */
export interface Screen {name:string;view:ViewModel}
export interface ScreenOptions {
 status?:number|undefined;
 headers?:[string,string][]|undefined;
 /** The console copy resolved for this request. The kit layout renders through the same context, so the document's language matches the body's. */
 copy:AdminCopy;
 /** The console shell's links: `kit.wrap` builds the sidebar, the page header and the skip target from these and the title. Absent on the failure page when the caller is not let in. */
 shell?:{nav:{href:string;label:string;current:boolean;icon:IconName}[];menu:{label:string;items:{href:string;label:string}[]}}|undefined;
 ui:UiExtension;
 /** Where a stale proof confirms the caller's identity: auth's step-up page, returning to this screen. */
 stepUp?:{href:string;label:string}|undefined;
}
/** Test hook: sees every screen before it renders. */
export const screenObserver:{current?:((screen:Screen)=>void)|undefined}={};
/** Renders a screen through `ui.kit`; `title` is English source text from the admin catalogue. */
export function screenResponse(title:string,screen:Screen,options:ScreenOptions):HandlerResult {
 if(!Object.hasOwn(adminTemplates,screen.name))throw new Error(`Unknown admin screen: ${screen.name.slice(0,64)}`);
 screenObserver.current?.(screen);
 const kit=options.ui.kit,context=options.copy.context;
 const rendered=kit.render(screen.name,screen.view,context);
 // The kit owns the console shell: it builds the sidebar, the page header and the skip target from `nav`, `menu` and the title.
 return kit.wrap(rendered,{title:options.copy.s(title),context,layout:options.shell?'application':'default',...(options.status!==undefined?{status:options.status}:{}),...(options.headers?{headers:options.headers}:{}),...(options.shell?{nav:options.shell.nav,menu:options.shell.menu}:{})});
}
/** A store refusal of a stale proof: the same answer as admin's own freshness pre-check. */
const stale=(error:unknown):boolean=>error instanceof Error&&'code' in error&&error.code==='fresh_authentication_required';
/**
 * The failure answer: JSON for API clients, otherwise the `admin/status` screen. Any error with a numeric `status` from
 * 400 to 499 keeps it, and so does a 502 or 503 (duck-typed: admin imports no auth value); anything else is 500. The
 * message is admin's own text, a project hook's `reason`, core's fixed request-refusal text, or a generic sentence.
 */
export function failureResponse(error:unknown,request:ExtensionRequest,options:ScreenOptions):HandlerResult {
 const given=error instanceof Error&&'status' in error&&typeof error.status==='number'?error.status:500;
 const refreshed=stale(error),status=refreshed?403:given>=400&&given<500||given===502||given===503?given:500;
 const reason=error instanceof Error&&'reason' in error&&typeof error.reason==='string'&&error.reason?error.reason:undefined;
 const message=refreshed?options.copy.s('Confirm your identity before this action'):error instanceof AdminHttpError?options.copy.s(error.message):error instanceof ExtensionHttpError?error.message:reason&&status<500?reason:options.copy.s(status>=500?'Service unavailable':'Request could not be completed');
 const code=error instanceof Error&&'code' in error&&typeof error.code==='string'&&/^[a-z][a-z_]{0,63}$/.test(error.code)?error.code:undefined;
 const confirm=(refreshed||error instanceof AdminHttpError&&error.message==='Confirm your identity before this action')?options.stepUp:undefined;
 if(wantsJson(request))return jsonResponse(status,{error:message,...(code?{code}:{}),...(confirm?{stepUp:confirm.href}:{})});
 return screenResponse('Request could not be completed',{name:'admin/status',view:{alert:true,message,href:confirm?.href??null,label:confirm?.label??null}},{...options,status});
}
export const markup=(html:string):Markup=>new Markup(html);
/** A labelled text input through the kit's `field`; `label` is already resolved copy. */
export function formField(name:string,label:string,type='text',autocomplete='off',required=true):string {return field({name,label,type,autocomplete,required});}
