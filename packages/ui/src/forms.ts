import {escapeHtml,button} from './components.ts';
import {safeHref} from './template.ts';
import type {IconName} from './icons.ts';
const NAME=/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/,CLASS=/^[A-Za-z][A-Za-z0-9_-]{0,63}(?: [A-Za-z][A-Za-z0-9_-]{0,63}){0,7}$/;
/** Escaped hidden input; the name follows the same grammar as `field`. */
export function hiddenField(name:string,value:string):string {if(!NAME.test(name))throw new Error('Invalid field');return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;}
export interface PostFormOptions {action:string;csrf:string;fields:string;label:string;destructive?:boolean;icon?:IconName;className?:string}
/** POST form with the CSRF hidden field, trusted field markup and one submit button. `action` must pass `safeHref` unchanged; `fields` is trusted package markup. */
export function postForm(options:PostFormOptions):string {
 const {action,csrf,fields,label,destructive=false}=options,className=options.className??'ui-stack';
 if(typeof action!=='string'||!action||safeHref(action)!==action)throw new Error('Expected a safe form action');
 if(!CLASS.test(className))throw new Error('Invalid class name');
 const submit=button(label,'submit',options.icon);
 return `<form class="${className}" method="post" action="${escapeHtml(action)}">${hiddenField('csrf',csrf)}${fields}<div class="ui-actions">${destructive?submit.replace('<button ','<button class="ui-button-destructive" '):submit}</div></form>`;
}
/** Race `fn` against a timeout; on the deadline the signal aborts and the result rejects with `Error(message)`. */
export async function withDeadline<T>(fn:(signal:AbortSignal)=>Promise<T>,ms:number,message:string):Promise<T> {
 if(!Number.isFinite(ms)||ms<0)throw new Error('Invalid deadline');
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([fn(controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error(message));},ms);})]);}
 finally{if(timer!==undefined)clearTimeout(timer);}
}
