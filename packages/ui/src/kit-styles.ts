/**
 * The kit stylesheet and scripts, content-hashed for the asset paths.
 * `kitCss` compiles from `styles/kit.css` through `npm run styles` (like the
 * shared `stylesheet` export compiles from `styles/tailwind.css`), so both
 * stylesheets come from one Tailwind source of truth instead of one
 * generated and one hand-written. Tokens follow shadcn/ui variable names so
 * a theme block sets them without a CSS build; dark mode by media query and
 * by `.dark`.
 */
import { crudScript } from './crud-script.ts';
import { kitCss } from './kit-styles.generated.ts';
export { kitCss };
export interface Asset { readonly name: string; readonly contentType: string; readonly body: string; readonly hash: string }
/** FNV-1a 64-bit, for cache-busting names only. Not a security hash. */
export function contentHash(text: string): string {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(text)) {
        hash ^= BigInt(byte);
        hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, '0').slice(0, 12);
}
/** The kit stylesheet stays under this size so every page's first request is small; the closure test checks it. */
export const kitCssLimit: number = 65536;
/** OTP digit boxes: enhances the single input with per-digit boxes; the form still submits the one field. */
const otpScript = `(function(){for(const wrap of document.querySelectorAll('[data-ui-otp]')){const input=wrap.querySelector('input');const digits=Number(wrap.getAttribute('data-ui-otp'))||6;if(!input||digits<4||digits>10)continue;const boxes=document.createElement('div');boxes.className='ui-otp-boxes';boxes.setAttribute('aria-hidden','true');const cells=[];for(let i=0;i<digits;i++){const cell=document.createElement('input');cell.type='text';cell.inputMode='numeric';cell.maxLength=1;cell.className='ui-input';cell.tabIndex=-1;cells.push(cell);boxes.appendChild(cell);}
const sync=()=>{const value=input.value.replace(/\\D/g,'').slice(0,digits);cells.forEach((cell,i)=>{cell.value=value[i]||'';});};input.addEventListener('input',sync);boxes.addEventListener('paste',e=>{e.preventDefault();const text=(e.clipboardData||window.clipboardData).getData('text');input.value=String(text).replace(/\\D/g,'').slice(0,digits);sync();input.focus();});cells.forEach((cell,i)=>{cell.addEventListener('input',()=>{const chars=input.value.replace(/\\D/g,'').split('');chars[i]=cell.value.replace(/\\D/g,'').slice(-1);input.value=chars.join('').slice(0,digits);sync();if(cell.value&&cells[i+1])cells[i+1].focus();});cell.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!cell.value&&cells[i-1])cells[i-1].focus();});});input.insertAdjacentElement('afterend',boxes);input.classList.add('ui-sr-only');cells[0].tabIndex=0;sync();}})();`;
/** Typed confirmation: keeps the submit button disabled until the typed value matches. */
const confirmScript = `(function(){for(const wrap of document.querySelectorAll('[data-ui-confirm]')){const input=wrap.querySelector('input');const form=wrap.closest('form');const expected=wrap.getAttribute('data-ui-confirm');if(!input||!form||!expected)continue;const submit=form.querySelector('button[type=submit]');if(!submit)continue;const check=()=>{submit.disabled=input.value!==expected;};input.addEventListener('input',check);check();}})();`;
export function kitAssets(extraCss?: string, replaceCss?: string): readonly Asset[] {
    const css = replaceCss ?? (extraCss ? kitCss + '\n' + extraCss : kitCss);
    const cssHash = contentHash(css), otpHash = contentHash(otpScript), confirmHash = contentHash(confirmScript), crudHash = contentHash(crudScript);
    return Object.freeze([
        Object.freeze({ name: `kit.${cssHash}.css`, contentType: 'text/css; charset=utf-8', body: css, hash: cssHash }),
        Object.freeze({ name: `otp.${otpHash}.js`, contentType: 'text/javascript; charset=utf-8', body: otpScript, hash: otpHash }),
        Object.freeze({ name: `confirm.${confirmHash}.js`, contentType: 'text/javascript; charset=utf-8', body: confirmScript, hash: confirmHash }),
        Object.freeze({ name: `crud.${crudHash}.js`, contentType: 'text/javascript; charset=utf-8', body: crudScript, hash: crudHash }),
    ]);
}
