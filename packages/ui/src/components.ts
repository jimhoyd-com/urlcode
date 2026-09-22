import {icon} from './icons.ts';
import type {IconName} from './icons.ts';
/** Values are always escaped. Only trusted package code may compose trustedContent. */
export function escapeHtml(value:unknown):string {return String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!));}
export function localUrl(value:string):string {
 if(typeof value!=='string'||value.length>2048||!/^\/(?!\/)|^#[A-Za-z]/.test(value)||/[\x00-\x20\x7f\\]/.test(value)||/%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value))throw new Error('Expected a local UI URL');
 return escapeHtml(value);
}
export interface FieldOption {value:string;label:string;disabled?:boolean}
export interface FieldOptions {name:string;label:string;id?:string;type?:string;autocomplete?:string;required?:boolean;value?:string;description?:string;error?:string;
 /** `input` (default), `textarea` or `select`. `type` applies to `input` only. */
 control?:'input'|'textarea'|'select';
 /** textarea only: visible rows, 2 to 40 (default 5). */
 rows?:number;
 /** textarea only: maximum characters, 1 to 65536 (default 4096). Inputs keep 1024. */
 maxLength?:number;
 /** select only: the choices, at most 500. */
 options?:readonly FieldOption[];
 /** select only: a leading empty choice, so a required select does not preselect a real value. */
 placeholder?:string;
 /** checkbox only: whether the control is initially selected. */
 checked?:boolean}
export function field(options:FieldOptions):string {
 const {name,label}=options,control=options.control??'input',type=options.type??'text',id=options.id??name+'-'+crypto.randomUUID().replaceAll('-','');
 if(!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name)||!['input','textarea','select'].includes(control)||(control==='input'&&!['text','email','password','number','search','tel','url','date','datetime-local','checkbox'].includes(type)))throw new Error('Invalid field');
 const description=options.description?`${id}-description`:undefined,error=options.error?`${id}-error`:undefined,described=[description,error].filter(Boolean).join(' ');
 const controlClass=control==='textarea'?'ui-input ui-textarea':control==='select'?'ui-input ui-select':'ui-input';
 const common=`class="${controlClass}" data-slot="${control}" id="${escapeHtml(id)}" name="${escapeHtml(name)}"`,tail=`${options.required!==false?' required':''}${described?` aria-describedby="${escapeHtml(described)}"`:''}${error?' aria-invalid="true"':''}`;
 let control_:string;
 if(control==='textarea'){
  const rows=options.rows??5,max=options.maxLength??4096;
  if(!Number.isInteger(rows)||rows<2||rows>40||!Number.isInteger(max)||max<1||max>65536)throw new Error('Invalid field');
  control_=`<textarea ${common} rows="${rows}" autocomplete="${escapeHtml(options.autocomplete??'off')}" maxlength="${max}"${tail}>${options.value!==undefined?'\n'+escapeHtml(options.value):''}</textarea>`;
 }else if(control==='select'){
  const choices=options.options;
  if(!choices||!choices.length||choices.length>500)throw new Error('Invalid field');
  control_=`<select ${common} autocomplete="${escapeHtml(options.autocomplete??'off')}"${tail}>${options.placeholder!==undefined?`<option value="">${escapeHtml(options.placeholder)}</option>`:''}${choices.map(choice=>`<option value="${escapeHtml(choice.value)}"${choice.value===options.value?' selected':''}${choice.disabled?' disabled':''}>${escapeHtml(choice.label)}</option>`).join('')}</select>`;
 }else if(type==='checkbox') {
  if(options.value!==undefined&&options.value!=='true')throw new Error('Invalid checkbox value');
  control_=`<input ${common} type="checkbox" autocomplete="${escapeHtml(options.autocomplete??'off')}" value="true"${options.checked?' checked':''}${tail}>`;
 }else control_=`<input ${common} type="${type}" autocomplete="${escapeHtml(options.autocomplete??'off')}" maxlength="1024"${tail}${options.value!==undefined?` value="${escapeHtml(options.value)}"`:''}>`;
 return `<div class="ui-field" data-slot="field"${error?' data-invalid="true"':''}><label class="ui-label" data-slot="field-label" for="${escapeHtml(id)}">${escapeHtml(label)}</label>${control_}${description?`<p class="ui-help" data-slot="field-description" id="${escapeHtml(description)}">${escapeHtml(options.description)}</p>`:''}${error?`<p class="ui-error" data-slot="field-error" id="${escapeHtml(error)}" role="alert">${escapeHtml(options.error)}</p>`:''}</div>`;
}
export function button(label:string,type:'submit'|'button'='submit',iconName?:IconName):string {if(!['submit','button'].includes(type))throw new Error('Invalid button');return `<button class="ui-button ui-button-primary" data-slot="button" type="${type}">${iconName?icon(iconName).replace('<svg ','<svg data-icon="inline-start" '):''}${escapeHtml(label)}</button>`;}
export function alert(message:string,kind:'error'|'status'='status'):string {if(!['error','status'].includes(kind))throw new Error('Invalid alert');return `<p class="${kind}" role="${kind==='error'?'alert':'status'}">${escapeHtml(message)}</p>`;}
export function navigation(items:readonly {label:string;href:string;current?:boolean;icon?:IconName}[],label='Navigation'):string {if(items.length>100)throw new Error('Too many links');return `<nav aria-label="${escapeHtml(label)}">${items.map(item=>`<a href="${localUrl(item.href)}"${item.current?' aria-current="page"':''}>${item.icon?icon(item.icon):''}${escapeHtml(item.label)}</a>`).join('')}</nav>`;}
export function table(caption:string,columns:readonly string[],rows:readonly (readonly unknown[])[]):string {if(!columns.length||columns.length>32||rows.length>1000||rows.some(row=>row.length!==columns.length))throw new Error('Invalid table dimensions');return `<div class="ui-table"><table><caption>${escapeHtml(caption)}</caption><thead><tr>${columns.map(value=>`<th scope="col">${escapeHtml(value)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(value=>`<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;}
export function pagination(options:{previous?:string;next?:string;previousLabel?:string;nextLabel?:string;label?:string}):string {return navigation([...(options.previous?[{href:options.previous,label:options.previousLabel??'Previous page'}]:[]),...(options.next?[{href:options.next,label:options.nextLabel??'Next page'}]:[])],options.label??'Pagination');}
export function emptyState(message:string):string {return `<div class="ui-empty" data-slot="empty"><p class="ui-empty-title" data-slot="empty-title">${escapeHtml(message)}</p></div>`;}
