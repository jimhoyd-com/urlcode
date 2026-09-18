/**
 * The kit stylesheet and scripts as static strings, content-hashed for the
 * asset paths. Tokens follow shadcn/ui variable names so a theme block sets
 * them without a CSS build; dark mode by media query and by `.dark`.
 */
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
export const kitCss = `:root{--background:0 0% 100%;--foreground:222.2 84% 4.9%;--card:0 0% 100%;--card-foreground:222.2 84% 4.9%;--popover:0 0% 100%;--popover-foreground:222.2 84% 4.9%;--primary:222.2 47.4% 11.2%;--primary-foreground:210 40% 98%;--secondary:210 40% 96.1%;--secondary-foreground:222.2 47.4% 11.2%;--muted:210 40% 96.1%;--muted-foreground:215.4 16.3% 46.9%;--accent:210 40% 96.1%;--accent-foreground:222.2 47.4% 11.2%;--destructive:0 84.2% 60.2%;--destructive-foreground:210 40% 98%;--border:214.3 31.8% 91.4%;--input:214.3 31.8% 91.4%;--ring:222.2 84% 4.9%;--radius:0.5rem;--font-sans:ui-sans-serif,system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root:not(.light){--background:222.2 84% 4.9%;--foreground:210 40% 98%;--card:222.2 84% 4.9%;--card-foreground:210 40% 98%;--popover:222.2 84% 4.9%;--popover-foreground:210 40% 98%;--primary:210 40% 98%;--primary-foreground:222.2 47.4% 11.2%;--secondary:217.2 32.6% 17.5%;--secondary-foreground:210 40% 98%;--muted:217.2 32.6% 17.5%;--muted-foreground:215 20.2% 65.1%;--accent:217.2 32.6% 17.5%;--accent-foreground:210 40% 98%;--destructive:0 62.8% 30.6%;--destructive-foreground:210 40% 98%;--border:217.2 32.6% 17.5%;--input:217.2 32.6% 17.5%;--ring:212.7 26.8% 83.9%}}
.dark{--background:222.2 84% 4.9%;--foreground:210 40% 98%;--card:222.2 84% 4.9%;--card-foreground:210 40% 98%;--primary:210 40% 98%;--primary-foreground:222.2 47.4% 11.2%;--secondary:217.2 32.6% 17.5%;--secondary-foreground:210 40% 98%;--muted:217.2 32.6% 17.5%;--muted-foreground:215 20.2% 65.1%;--accent:217.2 32.6% 17.5%;--accent-foreground:210 40% 98%;--destructive:0 62.8% 30.6%;--destructive-foreground:210 40% 98%;--border:217.2 32.6% 17.5%;--input:217.2 32.6% 17.5%;--ring:212.7 26.8% 83.9%}
*,*::before,*::after{box-sizing:border-box;border:0 solid hsl(var(--border))}
html{-webkit-text-size-adjust:100%;tab-size:4}
.ui-body{margin:0;min-height:100vh;font-family:var(--font-sans);font-size:1rem;line-height:1.5;color:hsl(var(--foreground));background:hsl(var(--background));-webkit-font-smoothing:antialiased}
.ui-container{max-width:40rem;margin-inline:auto;padding-inline:1rem}
.ui-main{padding-block:2rem}
.ui-title{font-size:1.5rem;font-weight:600;letter-spacing:-.025em;margin:0 0 1.5rem}
.ui-skip{position:absolute;inset-inline-start:-999px;top:0;padding:.5rem 1rem;background:hsl(var(--primary));color:hsl(var(--primary-foreground));border-radius:var(--radius);z-index:10}
.ui-skip:focus{inset-inline-start:1rem;top:1rem}
.ui-header{border-bottom:1px solid hsl(var(--border));background:hsl(var(--background))}
.ui-header-row{display:flex;align-items:center;gap:1rem;min-height:3.5rem;flex-wrap:wrap}
.ui-brand{display:inline-flex;align-items:center;gap:.5rem;font-weight:600;color:inherit;text-decoration:none}
.ui-logo{width:2rem;height:2rem;border-radius:calc(var(--radius) - 2px)}
.ui-nav ul,.ui-tabs ul,.ui-menu-list{list-style:none;margin:0;padding:0;display:flex;gap:.25rem;flex-wrap:wrap}
.ui-nav a,.ui-tabs a{display:inline-block;padding:.375rem .75rem;border-radius:var(--radius);color:hsl(var(--muted-foreground));text-decoration:none;font-size:.875rem;font-weight:500}
.ui-nav a:hover,.ui-tabs a:hover{color:hsl(var(--foreground));background:hsl(var(--accent))}
.ui-nav a[aria-current],.ui-tabs a[aria-current]{color:hsl(var(--foreground));background:hsl(var(--secondary))}
.ui-tabs{border-bottom:1px solid hsl(var(--border));margin-block:0 1.5rem;padding-bottom:.5rem}
.ui-menu{margin-inline-start:auto;position:relative}
.ui-menu summary{list-style:none;display:inline-flex;align-items:center;gap:.5rem;cursor:pointer;padding:.25rem .5rem;border-radius:var(--radius)}
.ui-menu summary::-webkit-details-marker{display:none}
.ui-menu[open] summary{background:hsl(var(--accent))}
.ui-menu-list{position:absolute;inset-inline-end:0;top:100%;min-width:12rem;flex-direction:column;gap:0;background:hsl(var(--popover));color:hsl(var(--popover-foreground));border:1px solid hsl(var(--border));border-radius:var(--radius);padding:.25rem;box-shadow:0 4px 12px rgba(0,0,0,.08);z-index:5}
.ui-menu-list a{display:block;padding:.375rem .5rem;border-radius:calc(var(--radius) - 2px);color:inherit;text-decoration:none;font-size:.875rem}
.ui-menu-list a:hover{background:hsl(var(--accent))}
.ui-avatar{display:inline-flex;align-items:center;justify-content:center;width:2rem;height:2rem;border-radius:9999px;background:hsl(var(--muted));font-size:.875rem;font-weight:600}
.ui-menu-name{font-size:.875rem}
.ui-card{background:hsl(var(--card));color:hsl(var(--card-foreground));border:1px solid hsl(var(--border));border-radius:var(--radius);box-shadow:0 1px 2px rgba(0,0,0,.05);margin-block:0 1.5rem}
.ui-card-header{padding:1.5rem 1.5rem 0}
.ui-card-title{font-size:1.125rem;font-weight:600;margin:0}
.ui-card-description{color:hsl(var(--muted-foreground));font-size:.875rem;margin:.25rem 0 0}
.ui-card-content{padding:1.5rem}
.ui-card-footer{padding:0 1.5rem 1.5rem;display:flex;gap:.5rem;flex-wrap:wrap}
.ui-form{display:flex;flex-direction:column;gap:1rem}
.ui-form-actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.ui-field{display:flex;flex-direction:column;gap:.375rem}
.ui-label{font-size:.875rem;font-weight:500;line-height:1}
.ui-input{display:block;width:100%;height:2.5rem;padding:.5rem .75rem;font:inherit;font-size:.875rem;color:inherit;background:hsl(var(--background));border:1px solid hsl(var(--input));border-radius:var(--radius)}
.ui-input::placeholder{color:hsl(var(--muted-foreground))}
.ui-input:focus-visible,.ui-button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}
.ui-field-invalid .ui-input{border-color:hsl(var(--destructive))}
.ui-help{color:hsl(var(--muted-foreground));font-size:.875rem;margin:0}
.ui-error{color:hsl(var(--destructive));font-size:.875rem;font-weight:500;margin:0}
.ui-muted{color:hsl(var(--muted-foreground));font-size:.875rem}
.ui-button{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;height:2.5rem;padding:.5rem 1rem;font:inherit;font-size:.875rem;font-weight:500;border-radius:var(--radius);border:1px solid transparent;cursor:pointer;text-decoration:none;white-space:nowrap;transition:background-color .15s}
.ui-button-primary{background:hsl(var(--primary));color:hsl(var(--primary-foreground))}
.ui-button-primary:hover{background:hsl(var(--primary)/.9)}
.ui-button-secondary{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground))}
.ui-button-secondary:hover{background:hsl(var(--secondary)/.8)}
.ui-button-outline{border-color:hsl(var(--input));background:hsl(var(--background));color:inherit}
.ui-button-outline:hover,.ui-button-ghost:hover{background:hsl(var(--accent));color:hsl(var(--accent-foreground))}
.ui-button-ghost{background:transparent;color:inherit}
.ui-button-destructive{background:hsl(var(--destructive));color:hsl(var(--destructive-foreground))}
.ui-button-destructive:hover{background:hsl(var(--destructive)/.9)}
.ui-button:disabled{opacity:.5;pointer-events:none}
.ui-alert{position:relative;border:1px solid hsl(var(--border));border-radius:var(--radius);padding:1rem;margin-block:0 1.5rem;font-size:.875rem}
.ui-alert p{margin:0}
.ui-alert-title{font-weight:500;margin-bottom:.25rem!important}
.ui-alert-error{border-color:hsl(var(--destructive)/.5);color:hsl(var(--destructive))}
.ui-alert-success{border-color:hsl(142 71% 45%/.5)}
.ui-alert-warning{border-color:hsl(38 92% 50%/.6)}
.ui-otp-input{font-size:1.5rem;letter-spacing:.5em;text-align:center;font-variant-numeric:tabular-nums}
.ui-otp-boxes{display:flex;gap:.5rem}
.ui-otp-boxes input{width:2.75rem;text-align:center;font-size:1.25rem;letter-spacing:0}
.ui-table-wrap{overflow-x:auto;border:1px solid hsl(var(--border));border-radius:var(--radius);margin-block:0 1.5rem}
.ui-table{width:100%;border-collapse:collapse;font-size:.875rem}
.ui-table caption{text-align:start;padding:.75rem;font-weight:500;caption-side:top}
.ui-table th,.ui-table td{text-align:start;padding:.75rem;border-bottom:1px solid hsl(var(--border));overflow-wrap:anywhere}
.ui-table th{color:hsl(var(--muted-foreground));font-weight:500}
.ui-table tbody tr:last-child td{border-bottom:0}
.ui-table tbody tr:hover{background:hsl(var(--muted)/.5)}
.ui-table a{color:inherit}
.ui-empty{text-align:center;padding:3rem 1rem;border:1px dashed hsl(var(--border));border-radius:var(--radius);margin-block:0 1.5rem}
.ui-empty-title{font-weight:500;margin:0 0 .5rem}
.ui-pagination{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-block:1rem}
.ui-footer{padding-block:2rem;color:hsl(var(--muted-foreground));font-size:.875rem}
.ui-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media (prefers-reduced-motion:reduce){.ui-button{transition:none}}
`;
/** OTP digit boxes: enhances the single input with per-digit boxes; the form still submits the one field. */
const otpScript = `(function(){for(const wrap of document.querySelectorAll('[data-ui-otp]')){const input=wrap.querySelector('input');const digits=Number(wrap.getAttribute('data-ui-otp'))||6;if(!input||digits<4||digits>10)continue;const boxes=document.createElement('div');boxes.className='ui-otp-boxes';boxes.setAttribute('aria-hidden','true');const cells=[];for(let i=0;i<digits;i++){const cell=document.createElement('input');cell.type='text';cell.inputMode='numeric';cell.maxLength=1;cell.className='ui-input';cell.tabIndex=-1;cells.push(cell);boxes.appendChild(cell);}
const sync=()=>{const value=input.value.replace(/\\D/g,'').slice(0,digits);cells.forEach((cell,i)=>{cell.value=value[i]||'';});};input.addEventListener('input',sync);boxes.addEventListener('paste',e=>{e.preventDefault();const text=(e.clipboardData||window.clipboardData).getData('text');input.value=String(text).replace(/\\D/g,'').slice(0,digits);sync();input.focus();});cells.forEach((cell,i)=>{cell.addEventListener('input',()=>{const chars=input.value.replace(/\\D/g,'').split('');chars[i]=cell.value.replace(/\\D/g,'').slice(-1);input.value=chars.join('').slice(0,digits);sync();if(cell.value&&cells[i+1])cells[i+1].focus();});cell.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!cell.value&&cells[i-1])cells[i-1].focus();});});input.insertAdjacentElement('afterend',boxes);input.classList.add('ui-sr-only');cells[0].tabIndex=0;sync();}})();`;
/** Typed confirmation: keeps the submit button disabled until the typed value matches. */
const confirmScript = `(function(){for(const wrap of document.querySelectorAll('[data-ui-confirm]')){const input=wrap.querySelector('input');const form=wrap.closest('form');const expected=wrap.getAttribute('data-ui-confirm');if(!input||!form||!expected)continue;const submit=form.querySelector('button[type=submit]');if(!submit)continue;const check=()=>{submit.disabled=input.value!==expected;};input.addEventListener('input',check);check();}})();`;
export function kitAssets(extraCss?: string, replaceCss?: string): readonly Asset[] {
    const css = replaceCss ?? (extraCss ? kitCss + '\n' + extraCss : kitCss);
    const cssHash = contentHash(css), otpHash = contentHash(otpScript), confirmHash = contentHash(confirmScript);
    return Object.freeze([
        Object.freeze({ name: `kit.${cssHash}.css`, contentType: 'text/css; charset=utf-8', body: css, hash: cssHash }),
        Object.freeze({ name: `otp.${otpHash}.js`, contentType: 'text/javascript; charset=utf-8', body: otpScript, hash: otpHash }),
        Object.freeze({ name: `confirm.${confirmHash}.js`, contentType: 'text/javascript; charset=utf-8', body: confirmScript, hash: confirmHash }),
    ]);
}
