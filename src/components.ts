/** Values are always escaped. Only trusted package code may compose trustedContent. */
export function escapeHtml(value:unknown):string {return String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!));}
export function localUrl(value:string):string {
 if(typeof value!=='string'||value.length>2048||!/^\/(?!\/)|^#[A-Za-z]/.test(value)||/[\x00-\x20\x7f\\]/.test(value)||/%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value))throw new Error('Expected a local UI URL');
 return escapeHtml(value);
}
export interface FieldOptions {name:string;label:string;id?:string;type?:string;autocomplete?:string;required?:boolean;value?:string;description?:string;error?:string}
export function field(options:FieldOptions):string {
 const {name,label}=options,type=options.type??'text',id=options.id??name+'-'+crypto.randomUUID();
 if(!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name)||!['text','email','password','number','search','tel','url','date','datetime-local'].includes(type))throw new Error('Invalid field');
 const description=options.description?`${id}-description`:undefined,error=options.error?`${id}-error`:undefined,described=[description,error].filter(Boolean).join(' ');
 return `<label for="${escapeHtml(id)}">${escapeHtml(label)}</label><input id="${escapeHtml(id)}" name="${escapeHtml(name)}" type="${type}" autocomplete="${escapeHtml(options.autocomplete??'off')}" maxlength="1024"${options.required!==false?' required':''}${options.value!==undefined?` value="${escapeHtml(options.value)}"`:''}${described?` aria-describedby="${escapeHtml(described)}"`:''}${error?' aria-invalid="true"':''}>${description?`<p id="${escapeHtml(description)}">${escapeHtml(options.description)}</p>`:''}${error?`<p id="${escapeHtml(error)}" role="alert">${escapeHtml(options.error)}</p>`:''}`;
}
export function button(label:string,type:'submit'|'button'='submit'):string {if(!['submit','button'].includes(type))throw new Error('Invalid button');return `<button type="${type}">${escapeHtml(label)}</button>`;}
export function alert(message:string,kind:'error'|'status'='status'):string {if(!['error','status'].includes(kind))throw new Error('Invalid alert');return `<p class="${kind}" role="${kind==='error'?'alert':'status'}">${escapeHtml(message)}</p>`;}
export function navigation(items:readonly {label:string;href:string;current?:boolean}[],label='Navigation'):string {if(items.length>100)throw new Error('Too many links');return `<nav aria-label="${escapeHtml(label)}">${items.map(item=>`<a href="${localUrl(item.href)}"${item.current?' aria-current="page"':''}>${escapeHtml(item.label)}</a>`).join('')}</nav>`;}
export function table(caption:string,columns:readonly string[],rows:readonly (readonly unknown[])[]):string {if(!columns.length||columns.length>32||rows.length>1000||rows.some(row=>row.length!==columns.length))throw new Error('Invalid table dimensions');return `<div class="ui-table"><table><caption>${escapeHtml(caption)}</caption><thead><tr>${columns.map(value=>`<th scope="col">${escapeHtml(value)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(value=>`<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;}
export function pagination(options:{previous?:string;next?:string;previousLabel?:string;nextLabel?:string;label?:string}):string {return navigation([...(options.previous?[{href:options.previous,label:options.previousLabel??'Previous page'}]:[]),...(options.next?[{href:options.next,label:options.nextLabel??'Next page'}]:[])],options.label??'Pagination');}
export function emptyState(message:string):string {return `<p class="ui-empty">${escapeHtml(message)}</p>`;}
