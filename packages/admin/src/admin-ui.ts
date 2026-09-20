/**
 * Renders one admin screen through the urlcode-ui kit. The kit is the only
 * render path: the host supplies the `ui` extension and the admin extension
 * refuses to activate without an active one. Flows, permissions, freshness
 * gates, escaping, CSRF and headers stay in the extension code that computes
 * the view; the kit owns the document and the console shell around it.
 */
import {Markup} from '@jimhoyd/urlcode-ui';
import type {IconName,Kit,Presentation,PresentationContext,ViewModel} from '@jimhoyd/urlcode-ui';
import {AuthHttpError,httpFailure,wantsJson} from '@jimhoyd/urlcode-auth';
import type {AuthHttpResponse} from '@jimhoyd/urlcode-auth';
import type {ExtensionRequest} from '@jimhoyd/urlcode/extensions';
import {adminTemplateNames,adminTemplates} from './admin-templates.ts';
import {createAdminPresentation} from './admin-copy.ts';
/** The object `createUiExtension` returns, structurally: the kit once the runtime has activated the `ui` extension. */
export interface UiHost {readonly kit:Kit;readonly active:boolean}
/** One admin screen: an `admin/*` template name and the view the extension computed for it. */
export interface Screen {name:string;view:ViewModel}
export interface ScreenOptions {
 status?:number|undefined;
 headers?:[string,string][]|undefined;
 /** The console copy the extension resolved for this request. The kit layout renders through it too, so the document's language matches the body's. */
 presentation:PresentationContext;
 /** The console shell's links: `kit.wrap` builds the sidebar, the page header and the skip target from these and the title. Absent on the failure page, which carries no console navigation. */
 shell?:{nav:{href:string;label:string;current:boolean;icon:IconName}[];menu:{label:string;items:{href:string;label:string}[]}}|undefined;
 ui:UiHost;
}
/** Test hook: sees every screen before it renders. */
export const screenObserver:{current?:((screen:Screen)=>void)|undefined}={};
/**
 * Activation gate: the console has one render path, so a host without an active kit that carries the `admin/*`
 * templates is refused up front, naming what is missing and how to supply it, rather than failing per request.
 */
export function requireKit(ui:UiHost|undefined):Kit {
 if(!ui||typeof ui!=='object'||typeof ui.active!=='boolean')throw new Error("The admin console renders only through the urlcode-ui kit: pass the ui extension as `ui` to adminExtension({service, csrfKey, projectSha256, ui}), built with createUiExtension({projectSha256, projectRoot, sources: [authCatalogue], extensions: [authUiTemplates, adminUiTemplates]}).");
 if(!ui.active)throw new Error("The ui extension is not active yet: declare `ui` before `admin` under `extensions` in urlcode.yaml and mount its assets route (for example `/assets/ui/*`), so the runtime activates it before the admin console.");
 const kit=ui.kit,missing=adminTemplateNames.filter(name=>!kit.info(name));
 if(missing.length)throw new Error(`The ui extension was built without the admin templates (${missing.length} of ${adminTemplateNames.length} missing, first ${missing[0]}): pass adminUiTemplates in createUiExtension({extensions: [authUiTemplates, adminUiTemplates]}).`);
 return kit;
}
const composed=new WeakMap<Presentation,Presentation>();
/**
 * The copy source: the host's presentation; else the kit's, composed with the admin catalogue, when the host registered
 * the auth catalogue with the ui extension (the kit's own catalogue limit leaves no room for the admin catalogue too);
 * else the bundled English.
 */
export function presentationSource(presentation:Presentation|undefined,ui:UiHost,fallback:Presentation):Presentation {
 if(presentation)return presentation;
 const kit=ui.kit;
 if(!Object.hasOwn(kit.presentation.english,'page.admin'))return fallback;
 let source=composed.get(kit.presentation);
 if(!source){source=createAdminPresentation({base:kit.presentation});composed.set(kit.presentation,source);}
 return source;
}
/** Renders a screen through `ui.kit`, the console's only render path. */
export function screenResponse(title:string,screen:Screen,options:ScreenOptions):AuthHttpResponse {
 if(!Object.hasOwn(adminTemplates,screen.name))throw new Error(`Unknown admin screen: ${screen.name.slice(0,64)}`);
 screenObserver.current?.(screen);
 const kit=options.ui.kit,context=options.presentation;
 const rendered=kit.render(screen.name,screen.view,context);
 // The kit owns the console shell: it builds the sidebar, the page header and the skip target from `nav`, `menu` and the title.
 return kit.wrap(rendered,{title:options.presentation.textSource(title),context,layout:options.shell?'application':'default',...(options.status!==undefined?{status:options.status}:{}),...(options.headers?{headers:options.headers}:{}),...(options.shell?{nav:options.shell.nav,menu:options.shell.menu}:{})});
}
/** The failure page: JSON for API clients, otherwise the `admin/status` screen with the same status and message auth's `httpFailure` derives. */
export function failureResponse(error:unknown,request:ExtensionRequest,options:ScreenOptions):AuthHttpResponse {
 if(wantsJson(request))return httpFailure(error,request,options.presentation,undefined,options.ui);
 const known=error instanceof AuthHttpError||(error instanceof Error&&'status' in error&&typeof error.status==='number'&&error.status>=400&&error.status<500);
 const status=known?(error as Error&{status:number}).status:500;
 const source=error instanceof AuthHttpError?error.message:status>=500?'Service unavailable':'Request could not be completed';
 return screenResponse('Request could not be completed',{name:'admin/status',view:{alert:true,message:options.presentation.textSource(source),href:null,label:null}},{...options,status});
}
export const markup=(html:string):Markup=>new Markup(html);
