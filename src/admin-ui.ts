/**
 * Renders one admin screen either through the urlcode-ui kit (when the host
 * supplied the `ui` extension and the runtime activated it) or through the
 * shared primitives inside the console shell. Both paths render the same
 * `admin/*` template with the same view; only the layout around it differs.
 * Flows, permissions, freshness gates, escaping, CSRF and headers stay in the
 * extension code that computes the view.
 */
import {compileTemplate,Markup} from '@jimhoyd/urlcode-ui';
import type {CompiledTemplate,Kit,LocalePreferences,Presentation,PresentationContext,ViewModel} from '@jimhoyd/urlcode-ui';
import {AuthHttpError,httpFailure,wantsJson} from '@jimhoyd/urlcode-auth';
import type {AuthHttpResponse} from '@jimhoyd/urlcode-auth';
import type {ExtensionRequest} from '@jimhoyd/urlcode/extensions';
import {adminPage} from './admin-presentation.ts';
import {adminTemplates} from './admin-templates.ts';
import {createAdminPresentation} from './admin-copy.ts';
/** The object `createUiExtension` returns, structurally: the kit once the runtime has activated the `ui` extension. */
export interface UiHost {readonly kit:Kit;readonly active:boolean}
/** One admin screen: an `admin/*` template name and the view the extension computed for it. */
export interface Screen {name:string;view:ViewModel}
export type RenderPath='primitives'|'kit';
export interface ScreenOptions {
 status?:number|undefined;
 headers?:[string,string][]|undefined;
 /** The console copy the extension resolved for this request; titles and the primitive layout use it. */
 presentation:PresentationContext;
 /** The locale preferences the extension resolved, so the kit layout follows the same language. */
 preferences?:LocalePreferences|undefined;
 /** Sidebar markup on the primitive path; the kit path receives the same links as `nav` items. */
 shell?:{sidebar:string;nav:{href:string;label:string;current:boolean}[];menu:{label:string;items:{href:string;label:string}[]}}|undefined;
 ui?:UiHost|undefined;
}
/** Test hook: sees every screen before it renders, with the path that renders it. */
export const screenObserver:{current?:((screen:Screen,path:RenderPath)=>void)|undefined}={};
const localTemplates=new Map<string,CompiledTemplate>();
function localTemplate(name:string):CompiledTemplate|undefined {
 let template=localTemplates.get(name);
 if(!template&&Object.hasOwn(adminTemplates,name)){template=compileTemplate(name,adminTemplates[name]!.source);localTemplates.set(name,template);}
 return template;
}
/** The kit a request renders through, or nothing when the host gave no `ui` or the runtime has not activated it. */
export const activeKit=(ui:UiHost|undefined):Kit|undefined=>ui?.active?ui.kit:undefined;
const composed=new WeakMap<Presentation,Presentation>();
/**
 * The copy source: the host's presentation; else the kit's, composed with the admin catalogue, when the host registered
 * the auth catalogue with the ui extension (the kit's own catalogue limit leaves no room for the admin catalogue too);
 * else the bundled English.
 */
export function presentationSource(presentation:Presentation|undefined,ui:UiHost|undefined,fallback:Presentation):Presentation {
 if(presentation)return presentation;
 const kit=activeKit(ui);
 if(!kit||!Object.hasOwn(kit.presentation.english,'page.admin'))return fallback;
 let source=composed.get(kit.presentation);
 if(!source){source=createAdminPresentation({base:kit.presentation});composed.set(kit.presentation,source);}
 return source;
}
/** Renders a screen: through `ui.kit` when the host supplied the ui extension and it is active, otherwise through the shared primitives. */
export function screenResponse(title:string,screen:Screen,options:ScreenOptions):AuthHttpResponse {
 if(!Object.hasOwn(adminTemplates,screen.name))throw new Error(`Unknown admin screen: ${screen.name.slice(0,64)}`);
 const kit=activeKit(options.ui);
 screenObserver.current?.(screen,kit?'kit':'primitives');
 if(!kit){
  const markup=localTemplate(screen.name)!.render(screen.view,options.presentation,localTemplate).html;
  return adminPage(title,(options.shell?.sidebar??'')+markup,options.status??200,options.headers??[],undefined,options.presentation);
 }
 const context=kit.resolveContext(options.preferences);
 const page=kit.wrap(kit.render(screen.name,screen.view,options.presentation),{title:options.presentation.textSource(title),context,...(options.status!==undefined?{status:options.status}:{}),...(options.headers?{headers:options.headers}:{}),...(options.shell?{nav:options.shell.nav,menu:options.shell.menu}:{})});
 return {status:page.status,headers:page.headers,body:page.body};
}
/** The failure page: JSON for API clients, otherwise the `admin/status` screen with the same status and message auth's `httpFailure` derives. */
export function failureResponse(error:unknown,request:ExtensionRequest,options:ScreenOptions):AuthHttpResponse {
 if(wantsJson(request)||!activeKit(options.ui))return httpFailure(error,request,options.presentation);
 const known=error instanceof AuthHttpError||(error instanceof Error&&'status' in error&&typeof error.status==='number'&&error.status>=400&&error.status<500);
 const status=known?(error as Error&{status:number}).status:500;
 const source=error instanceof AuthHttpError?error.message:status>=500?'Service unavailable':'Request could not be completed';
 return screenResponse('Request could not be completed',{name:'admin/status',view:{alert:true,message:options.presentation.textSource(source),href:null,label:null}},{...options,status});
}
export const markup=(html:string):Markup=>new Markup(html);
