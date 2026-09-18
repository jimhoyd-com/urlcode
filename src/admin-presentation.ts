import {escapeHtml} from '@jimhoyd/urlcode-ui';
import {pageResponse} from '@jimhoyd/urlcode-auth';

/** Shared trusted shell for both primitive and kit screen templates. */
export function adminShell(title:string,sidebar:string,content:string,presentation?:Parameters<typeof pageResponse>[5]):string {
 const label=escapeHtml(presentation?.textSource(title)??title);
 return `<div class="ui-shell">${sidebar}<div class="ui-content" id="admin-content" tabindex="-1"><header class="ui-page-header"><h1>${label}</h1></header>${content}</div></div>`;
}
/** Trusted admin composition only; the reusable UI package has no knowledge of this shell. */
export function adminPage(...args:Parameters<typeof pageResponse>):ReturnType<typeof pageResponse> {
 const [title,content,status,headers,script,presentation]=args;
 const boundary=content.startsWith('<aside class="ui-sidebar"')?content.indexOf('</aside>')+8:0;
 if(boundary<8)return pageResponse(...args);
 const body=adminShell(title,content.slice(0,boundary),content.slice(boundary),presentation);
 const response=pageResponse(title,body,status,headers,script,presentation,args[6],'application');
 // Only trusted document structure is adjusted. Preserve CSP nonces, theme scripts and headers verbatim.
 let html=new TextDecoder().decode(response.body);
 html=html.replace('href="#main"','href="#admin-content"').replace(/<h1>[^]*?<\/h1>/,'');
 return {...response,body:new TextEncoder().encode(html)};
}
