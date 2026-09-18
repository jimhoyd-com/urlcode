import {icon} from './icons.ts';
import {escapeHtml,localUrl} from './components.ts';
import {themeScript} from './theme-script.ts';
import {stylesheet} from './styles.ts';
import type {PresentationContext} from './presentation.ts';
export interface DocumentOptions {title:string;trustedContent:string;layout?:'default'|'compact'|'application';theme?:{nonce:string};presentation?:PresentationContext;scripts?:readonly {src:string;nonce:string;async?:boolean}[]}
/** Trusted composition boundary. Never pass project/user HTML as trustedContent. Headers/CSRF stay with the host. */
export function renderDocument(options:DocumentOptions):string {
 if(options.layout&&!['default','compact','application'].includes(options.layout))throw new Error('Invalid document layout');
 if(options.theme&&!/^[A-Za-z0-9+/_=-]{16,128}$/.test(options.theme.nonce))throw new Error('Invalid theme nonce');
 const p=options.presentation, scripts=options.scripts??[];
 if(options.trustedContent.length>4194304||scripts.length>8)throw new Error('UI document exceeds limit');
 const tags=scripts.map(script=>{if(!/^[A-Za-z0-9+/_=-]{16,128}$/.test(script.nonce))throw new Error('Invalid script nonce');let src:string;if(script.src.startsWith('https://')){const url=new URL(script.src);if(url.username||url.password)throw new Error('Invalid script URL');src=escapeHtml(url.href);}else src=localUrl(script.src);return `<script nonce="${script.nonce}" src="${src}"${script.async?' async':''} defer></script>`;}).join('');
 // The context is created by the bounded presentation factory, never by project JSON.
 const appearance=options.theme?themeControl(p):'';
 const variables=p?.cssVariables??'';if(/[<>{}]/.test(variables))throw new Error('Invalid presentation context');
 return `<!doctype html><html lang="${escapeHtml(p?.lang??'en')}" dir="${p?.dir==='rtl'?'rtl':'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(options.title)}</title>${options.theme?`<script nonce="${escapeHtml(options.theme.nonce)}">${themeScript}</script>`:''}${p?.favicon?`<link rel="icon" href="${localUrl(p.favicon)}">`:''}<style>${stylesheet}:root{${variables}}</style></head><body>${appearance}${p?.logo?`<img class="ui-logo" src="${localUrl(p.logo)}" alt="" width="120">`:''}<a class="ui-skip" href="#main">${escapeHtml(p?.text('nav.skip')??'Skip to content')}</a><main id="main" tabindex="-1" class="ui-document" data-layout="${options.layout??'default'}"><h1>${escapeHtml(options.title)}</h1>${options.trustedContent}</main>${tags}</body></html>`;
}

export function themeControl(p?:PresentationContext):string {
 const label=(key:string,fallback:string)=>escapeHtml(p?.text(key)??fallback);
 return `<div class="ui-appearance" data-ui-appearance hidden><button type="button" class="ui-theme-toggle" data-ui-theme data-label-light="${label('theme.toggleLight','Switch to light mode')}" data-label-dark="${label('theme.toggleDark','Switch to dark mode')}" aria-label="${label('theme.toggleDark','Switch to dark mode')}"><span class="ui-theme-sun">${icon('sun')}</span><span class="ui-theme-moon">${icon('moon')}</span></button></div>`;
}
