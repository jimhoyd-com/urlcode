import {createRuntime} from '@jimhoyd/urlcode';
import type {Runtime,RuntimeOptions} from '@jimhoyd/urlcode';
import {authExtension} from '@jimhoyd/urlcode-auth';
import type {AuthExtensionOptions} from '@jimhoyd/urlcode-auth';
import {adminExtension} from './admin.ts';
import type {AdminExtensionOptions} from './admin.ts';
import {withSupportBanner} from './support-banner.ts';
import type {SupportBannerOptions} from './support-banner.ts';
import type {AdminHealthSnapshot} from './admin-health.ts';
export interface AdministrationRuntimeOptions {
    auth: AuthExtensionOptions;
    admin?: Omit<AdminExtensionOptions,'service'|'csrfKey'|'projectSha256'|'health'>;
    runtime?: RuntimeOptions;
    banner?: Omit<SupportBannerOptions,'service'|'authMount'>;
    observations?: (context:{signal:AbortSignal})=>Promise<Pick<AdminHealthSnapshot,'sender'|'providers'|'alerts'>>;
}
/** Trusted host constructor: every returned runtime response passes through support-session enforcement. */
export async function createAdministrationRuntime(project:string,options:AdministrationRuntimeOptions):Promise<Runtime> {
    // Captured by the health closure built below and assigned only after
    // createRuntime resolves, so it cannot be const without reordering a
    // trusted host constructor to satisfy a style rule.
    // eslint-disable-next-line prefer-const
    let runtime:Runtime|undefined;
    const {service,csrfKey,projectSha256}=options.auth;
    const admin=adminExtension({...options.admin,service,csrfKey,projectSha256,health:async context=>{
        const observed=options.observations?await options.observations(context):{sender:'unknown' as const,providers:[],alerts:[]};
        const healthy=runtime?.healthy===true;
        return {...observed,checkedAt:new Date().toISOString(),runtime:{status:healthy?'healthy':'unavailable',readiness:healthy?'healthy':'unavailable',version:runtime?.version??'unknown',routes:runtime?.count??0}};
    }});
    runtime=await createRuntime(project,{...options.runtime,extensions:[...(options.runtime?.extensions??[]),authExtension(options.auth),admin]});
    try {return withSupportBanner(runtime,{...options.banner,service,authMount:options.admin?.authMount??'/account'});}
    catch(error){await runtime.close();throw error;}
}
