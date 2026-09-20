/** The kit the HTTP suites render through: the `ui` extension a host supplies, activated the way the runtime would. Admin has no other render path. */
import type {TestContext} from 'node:test';
import {createUiExtension} from '@jimhoyd/urlcode-ui/host';
import type {UiExtension} from '@jimhoyd/urlcode-ui/host';
import {createKit,createPresentation,kitCatalogue,mergeCatalogues} from '@jimhoyd/urlcode-ui';
import type {UiHost} from '../../src/admin-ui.ts';
import type {RuntimeExtension} from '@jimhoyd/urlcode/extensions';
import {authCatalogue,authUiTemplates} from '@jimhoyd/urlcode-auth';
import {adminUiTemplates} from '../../src/admin-templates.ts';
/** What a host registers with `createUiExtension`: the auth catalogue (admin composes its own on top; the kit's 512-key catalogue limit holds no more) and both template namespaces. */
export const uiSources=[authCatalogue];
export const uiExtensions=[authUiTemplates,adminUiTemplates];
export interface KitSetup {ui:UiExtension|undefined;registrations:RuntimeExtension[];extensions:Record<string,unknown>;routes:Record<string,unknown>}
/** The `extensions.ui` block, its asset route and the ui extension the host declares before auth and admin. */
export function kitSetup(project:string,projectSha256:string,config:Record<string,unknown>={}):KitSetup {
 const yaml={extensions:{ui:{version:'1',config}},routes:{'/assets/ui/*':{extension:'ui',methods:['GET','HEAD']}}};
 // Before the project is written there is no revision to pin; only the YAML blocks are needed then.
 if(!projectSha256)return {ui:undefined,registrations:[],...yaml};
 const ui=createUiExtension({projectSha256,projectRoot:project,sources:uiSources,extensions:uiExtensions});
 // The ui package mirrors the runtime contract structurally with `targets: string[]`; the runtime checks the shape at activation.
 return {ui,registrations:[ui.registration as unknown as RuntimeExtension],...yaml};
}
/** For suites that call `activate` directly: the real ui extension, activated on its asset mount the way the runtime would. */
export async function activatedUi(t:TestContext,projectRoot:string,projectSha256:string,origin='https://example.test'):Promise<UiExtension> {
 const ui=createUiExtension({projectSha256,projectRoot,sources:uiSources,extensions:uiExtensions});
 const instance=await ui.registration.activate({},{origin,target:'node',projectSha256,mounts:['/assets/ui'],root:projectRoot});
 t.after(()=>instance.close?.());
 return ui;
}
/** The same kit without the runtime, for unit-level suites that call a handler directly rather than activating the extension. */
export const testUiHost=():UiHost=>({kit:createKit({presentation:createPresentation({defaults:mergeCatalogues([kitCatalogue,...uiSources])}),extensions:uiExtensions}),active:true});
