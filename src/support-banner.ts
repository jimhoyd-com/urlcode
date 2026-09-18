import {escapeHtml} from '@jimhoyd/urlcode-ui';
import type { Runtime, RuntimeRequest } from '@jimhoyd/urlcode';
import type { HandlerResult } from '@jimhoyd/urlcode/extensions';
import type { AuthService } from '@jimhoyd/urlcode-auth';

export interface SupportBannerOptions {
    service: Pick<AuthService,'authenticate'>;
    authMount?: string;
    message?: string;
    endLabel?: string;
    maximumHtmlBytes?: number;
}
/** Required host integration for impersonation: route every response through this runtime wrapper. */
export function withSupportBanner(runtime: Runtime, options: SupportBannerOptions): Runtime {
    const mount=options.authMount??'/account', maximum=options.maximumHtmlBytes??1048576;
    if(!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(mount)||!Number.isSafeInteger(maximum)||maximum<1024||maximum>4194304)throw new Error('Invalid support banner configuration');
    for(const value of [options.message,options.endLabel])if(value!==undefined&&(typeof value!=='string'||!value||value.length>512||/[\x00-\x1f\x7f]/.test(value)))throw new Error('Invalid support banner copy');
    const banner=`<aside role="alert" aria-label="Support session" id="urlcode-support-banner"><strong>${escapeHtml(options.message??'Support impersonation is active. Security changes are disabled.')}</strong> <a href="${escapeHtml(mount+'/account')}">${escapeHtml(options.endLabel??'End support session')}</a></aside>`;
    const handle=async(request:RuntimeRequest):Promise<HandlerResult>=>{
        const requestHeaders=new Headers(request.headers);
        const cookies=requestHeaders.get('cookie')??'', candidates=cookies.split(';').map(value=>value.trim()).filter(value=>value.startsWith('__Host-urlcode-session='));
        const token=cookies.length<=8192&&candidates.length===1&&(request.headerCounts?.cookie??1)===1?candidates[0]!.slice('__Host-urlcode-session='.length):'';
        const principal=/^[A-Za-z0-9_-]{43}$/.test(token)?await options.service.authenticate(token):null;
        if(!principal?.impersonatorId)return runtime.handle({...request,headers:requestHeaders});
        const headers=new Headers(requestHeaders);
        for(const name of ['if-none-match','if-modified-since','range','if-range','accept-encoding'])headers.delete(name);
        const result=await runtime.handle({...request,headers});
        const output=result.headers.filter(([name])=>!['cache-control','cdn-cache-control','vercel-cdn-cache-control','surrogate-control','etag','last-modified','content-length','x-urlcode-support-session'].includes(name.toLowerCase()));
        output.push(['cache-control','no-store'],['cdn-cache-control','no-store'],['x-urlcode-support-session','active']);
        const type=output.find(([name])=>name.toLowerCase()==='content-type')?.[1].split(';')[0]?.trim().toLowerCase();
        if(result.status!==304&&(request.method?.toUpperCase()==='HEAD'||type!=='text/html'||result.status<200||result.status===204||result.status>=300&&result.status<400))return {...result,headers:output};
        const encoded=typeof result.body==='string'?Buffer.from(result.body):Buffer.from(result.body??new Uint8Array());
        let html:string;
        try {if(result.status===304||output.filter(([name])=>name.toLowerCase()==='content-type').length!==1||encoded.byteLength>maximum||output.some(([name,value])=>name.toLowerCase()==='content-encoding'&&value!=='identity'))throw new Error('Unsupported response');html=new TextDecoder('utf-8',{fatal:true}).decode(encoded);}
        catch {return {status:409,headers:[['content-type','text/html; charset=utf-8'],['cache-control','no-store'],['cdn-cache-control','no-store'],['x-urlcode-support-session','active'],['content-security-policy',"default-src 'none'; base-uri 'none'; frame-ancestors 'none'"],['referrer-policy','no-referrer'],['x-content-type-options','nosniff']],body:`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Support session</title></head><body>${banner}<p>This page cannot be displayed safely during a support session.</p></body></html>`};}
        html=/<body(?:\s[^>]*)?>/i.test(html)?html.replace(/<body(?:\s[^>]*)?>/i,match=>match+banner):banner+html;
        const {contentLength:_length,...rest}=result;
        return {...rest,headers:output,body:new TextEncoder().encode(html)};
    };
    return new Proxy(runtime,{get(target,key){if(key==='handle')return handle;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
}
