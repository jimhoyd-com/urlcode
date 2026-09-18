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
/** The kit stylesheet stays under this size so every page's first request is small; the closure test checks it. */
export const kitCssLimit = 65536;
export const kitCss = `:root{--sidebar:210 40% 98%;--sidebar-foreground:215.4 16.3% 46.9%;--background:0 0% 100%;--foreground:240 10% 3.9%;--card:0 0% 100%;--card-foreground:240 10% 3.9%;--popover:0 0% 100%;--popover-foreground:240 10% 3.9%;--primary:240 5.9% 10%;--primary-foreground:0 0% 98%;--secondary:240 4.8% 95.9%;--secondary-foreground:240 5.9% 10%;--muted:240 4.8% 95.9%;--muted-foreground:240 3.8% 46.1%;--accent:240 4.8% 95.9%;--accent-foreground:240 5.9% 10%;--destructive:0 84.2% 60.2%;--destructive-foreground:0 0% 98%;--border:240 5.9% 90%;--input:240 5.9% 90%;--ring:240 10% 3.9%;--radius:0.5rem;--font-sans:ui-sans-serif,system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root:not(.light){--sidebar:222.2 84% 6.5%;--sidebar-foreground:214 20% 80%;--background:240 10% 3.9%;--foreground:0 0% 98%;--card:240 10% 3.9%;--card-foreground:0 0% 98%;--popover:240 10% 3.9%;--popover-foreground:0 0% 98%;--primary:0 0% 98%;--primary-foreground:240 5.9% 10%;--secondary:240 3.7% 15.9%;--secondary-foreground:0 0% 98%;--muted:240 3.7% 15.9%;--muted-foreground:240 5% 64.9%;--accent:240 3.7% 15.9%;--accent-foreground:0 0% 98%;--destructive:0 62.8% 30.6%;--destructive-foreground:0 0% 98%;--border:240 3.7% 15.9%;--input:240 3.7% 15.9%;--ring:240 4.9% 83.9%}}
.dark{--sidebar:222.2 84% 6.5%;--sidebar-foreground:214 20% 80%;--background:240 10% 3.9%;--foreground:0 0% 98%;--card:240 10% 3.9%;--card-foreground:0 0% 98%;--primary:0 0% 98%;--primary-foreground:240 5.9% 10%;--secondary:240 3.7% 15.9%;--secondary-foreground:0 0% 98%;--muted:240 3.7% 15.9%;--muted-foreground:240 5% 64.9%;--accent:240 3.7% 15.9%;--accent-foreground:0 0% 98%;--destructive:0 62.8% 30.6%;--destructive-foreground:0 0% 98%;--border:240 3.7% 15.9%;--input:240 3.7% 15.9%;--ring:240 4.9% 83.9%}
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
.ui-icon{display:inline-block;width:1.125rem;height:1.125rem;flex:none;vertical-align:-.2em;pointer-events:none}
.ui-nav a>.ui-icon,.ui-tabs a>.ui-icon,.ui-button>.ui-icon{margin-inline-end:.4rem}
[dir=rtl] .ui-icon-directional{transform:scaleX(-1)}
.ui-shell{display:grid;grid-template-columns:15rem minmax(0,1fr);min-height:100vh}
.ui-sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:1.5rem;padding:1.75rem 1rem;background:hsl(var(--sidebar));color:hsl(var(--sidebar-foreground));border-inline-end:1px solid hsl(var(--border))}
.ui-sidebar>.ui-brand{padding:0 .75rem;font-size:1.125rem;color:hsl(var(--foreground))}
.ui-sidebar-nav ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.25rem}
.ui-sidebar-nav a,.ui-nav-link{display:flex;align-items:center;gap:.7rem;padding:.6rem .8rem;border-radius:var(--radius);color:hsl(var(--sidebar-foreground));font-size:.875rem;font-weight:500;text-decoration:none}
.ui-sidebar-nav a:hover,.ui-nav-link:hover{background:hsl(var(--accent));color:hsl(var(--accent-foreground))}
.ui-sidebar-nav a[aria-current]{background:hsl(var(--secondary));color:hsl(var(--foreground));box-shadow:inset 3px 0 hsl(var(--primary))}
.ui-sidebar-footer{margin-top:auto;padding-top:.75rem;border-top:1px solid hsl(var(--border));font-size:.875rem;color:hsl(var(--muted-foreground))}
.ui-sidebar .ui-menu{margin-inline-start:0}
.ui-sidebar .ui-menu-list{inset-inline:0 auto;top:auto;bottom:100%}
.ui-content{min-width:0;width:100%;max-width:80rem;margin-inline:auto;padding:2.5rem 3rem}
.ui-page-header{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1.5rem}
.ui-page-header h1,.ui-page-header h2,.ui-page-header p{margin:0}
.ui-page-header p{color:hsl(var(--muted-foreground));font-size:.875rem}
.ui-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem;margin-block:0 1.5rem}
.ui-metric{display:flex;flex-direction:column;gap:.6rem;padding:1.25rem;background:hsl(var(--card));color:hsl(var(--card-foreground));border:1px solid hsl(var(--border));border-radius:var(--radius);box-shadow:0 1px 2px rgba(0,0,0,.05);text-decoration:none}
a.ui-metric:hover{border-color:hsl(var(--primary))}
.ui-metric strong{font-size:2rem;font-weight:600;letter-spacing:-.05em;line-height:1.2}
.ui-metric span{font-size:.875rem;color:hsl(var(--muted-foreground))}
.ui-definition-grid{display:grid;grid-template-columns:minmax(8rem,1fr) 2fr;gap:.7rem 1.5rem;margin:0 0 1.5rem}
.ui-definition-grid dt{color:hsl(var(--muted-foreground));font-size:.875rem}
.ui-definition-grid dd{margin:0;overflow-wrap:anywhere}
.ui-badge{display:inline-flex;align-items:center;padding:.15rem .6rem;border:1px solid hsl(var(--border));border-radius:9999px;background:hsl(var(--muted));font-size:.8125rem;font-weight:500;white-space:nowrap}
.ui-badge[data-status=active]{background:hsl(142 71% 45%/.12);color:hsl(142 71% 30%);border-color:hsl(142 71% 45%/.4)}
.ui-list{list-style:none;margin:0 0 1.5rem;padding:0}
.ui-list>li{padding:1rem 0;border-bottom:1px solid hsl(var(--border))}
.ui-list>li:last-child{border-bottom:0}
.ui-toolbar{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-block:0 1rem}
.ui-section-heading{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:1rem}
.ui-section-heading h2{margin:0;font-size:1.125rem;font-weight:600}
.ui-danger-zone{border-color:hsl(var(--destructive)/.5)}
.ui-danger-zone .ui-card-title{color:hsl(var(--destructive))}
.ui-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:.75rem 1rem;align-items:end}
.ui-form-grid>.ui-actions{grid-column:1/-1;margin-top:0}
.ui-actions{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;margin-top:1rem}
.ui-activity{list-style:none;margin:0;padding:0}
.ui-activity li{display:flex;justify-content:space-between;gap:1rem;padding:.8rem 0;border-bottom:1px solid hsl(var(--border));font-size:.875rem}
.ui-activity li:last-child{border-bottom:0}
.ui-activity time{color:hsl(var(--muted-foreground));white-space:nowrap}
.ui-chart{padding:1rem 0}
.ui-chart svg{display:block;width:100%;max-height:230px}
.ui-chart-legend{display:flex;gap:1.25rem;flex-wrap:wrap;padding-top:.75rem;font-size:.875rem;color:hsl(var(--muted-foreground))}
.ui-chart-key{display:inline-flex;align-items:center;gap:.4rem}
.ui-chart-key::before{content:"";width:.5rem;height:.5rem;border-radius:9999px;background:hsl(var(--chart-1))}
.ui-chart-key-green::before{background:hsl(var(--chart-2))}
.ui-chart-key-red::before{background:hsl(var(--chart-3))}
.ui-filter{min-width:0}
@media (max-width:1000px){.ui-content{padding:2rem 1.5rem}.ui-shell{grid-template-columns:13rem minmax(0,1fr)}}
@media (max-width:720px){.ui-shell{display:block}.ui-sidebar{position:static;height:auto;padding:1rem;gap:.75rem}.ui-sidebar-nav ul{flex-direction:row;flex-wrap:wrap}.ui-sidebar-nav a[aria-current]{box-shadow:none}.ui-sidebar-footer{margin-top:0}.ui-sidebar .ui-menu-list{top:100%;bottom:auto}.ui-content{padding:1.5rem 1rem}.ui-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.ui-definition-grid{grid-template-columns:1fr;gap:.2rem}.ui-definition-grid dd{margin-bottom:.7rem}.ui-activity li{flex-direction:column;gap:.25rem}.ui-form-grid{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.ui-button{transition:none}}

.ui-appearance{position:absolute;top:1rem;inset-inline-end:1rem;z-index:10}.ui-appearance[hidden]{display:none}
.ui-theme-toggle{display:inline-flex;align-items:center;justify-content:center;width:2.25rem;height:2.25rem;padding:0;border:0;border-radius:.375rem;background:transparent;color:hsl(var(--foreground));cursor:pointer}.ui-theme-toggle:hover{background:hsl(var(--muted))}.ui-theme-toggle:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:3px}.ui-theme-toggle .ui-icon{width:1.125rem;height:1.125rem}.ui-theme-toggle span{display:flex}.ui-theme-toggle .ui-theme-sun{display:none}.dark .ui-theme-toggle .ui-theme-sun{display:flex}.dark .ui-theme-toggle .ui-theme-moon{display:none}
.ui-body[data-layout=compact] .ui-header:has(.ui-brand>span:empty){display:none}.ui-body[data-layout=compact] .ui-main{max-width:24rem;margin:clamp(4.5rem,12vh,7rem) auto 3rem;padding:1.5rem;border:1px solid hsl(var(--border));border-radius:.75rem;background:hsl(var(--card));box-shadow:0 1px 2px #00000008}.ui-body[data-layout=compact] .ui-title{margin-bottom:1.25rem}.ui-progress{font-size:.75rem;color:hsl(var(--muted-foreground));margin:-.75rem 0 1.25rem}
.ui-body[data-layout=compact] .ui-intro{font-size:.875rem;color:hsl(var(--muted-foreground))}.ui-body[data-layout=compact] .ui-selected-identity{display:flex;align-items:center;justify-content:space-between;gap:.75rem;font-size:.875rem;margin-bottom:1rem}.ui-body[data-layout=compact] .ui-stack{display:grid;gap:1rem}.ui-body[data-layout=compact] .ui-field label{font-size:.875rem;font-weight:500}.ui-body[data-layout=compact] .ui-field>p{font-size:.875rem;color:hsl(var(--muted-foreground));margin:0}.ui-body[data-layout=compact] .ui-disclosure{font-size:.875rem;color:hsl(var(--muted-foreground));margin:0}.ui-body[data-layout=compact] input:not([type=hidden]):not([type=checkbox]):not([type=radio]){width:100%;min-height:2.25rem;border:1px solid hsl(var(--input));border-radius:.375rem;background:transparent;color:inherit;padding:.375rem .75rem;font:inherit}.ui-body[data-layout=compact] form>button{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-height:2.25rem;border-radius:.375rem;background:hsl(var(--primary));color:hsl(var(--primary-foreground));font:inherit;font-size:.875rem;padding:.375rem 1rem}.ui-body .ui-icon{width:1.125rem;height:1.125rem;flex:none}.ui-body[data-layout=compact] nav{display:flex;justify-content:center;margin-top:1.25rem;font-size:.875rem}
@media(max-width:720px){.ui-theme-toggle{width:2.75rem;height:2.75rem}.ui-body[data-layout=compact] .ui-main{margin:4.75rem 1rem 2rem;max-width:none}.ui-body[data-layout=compact] input:not([type=hidden]),.ui-body[data-layout=compact] form>button{min-height:2.75rem;font-size:1rem}}

.ui-body[data-layout=application]>.ui-header{display:none}.ui-body[data-layout=application]>.ui-main{max-width:none;padding:0;margin:0}.ui-body[data-layout=application]>.ui-main>.ui-title{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.ui-body .ui-shell{display:grid;grid-template-columns:15rem minmax(0,1fr);min-height:100vh}.ui-body .ui-sidebar{position:sticky;top:0;height:100vh;border-inline-end:1px solid hsl(var(--border));padding:1.25rem .75rem;display:flex;flex-direction:column;gap:1rem}.ui-body .ui-sidebar nav{display:flex;flex-direction:column;gap:.125rem}.ui-body .ui-sidebar nav a,.ui-body .ui-nav-link{display:flex;align-items:center;gap:.625rem;padding:.5rem .75rem;font-size:.875rem;border-radius:.375rem;color:hsl(var(--muted-foreground));text-decoration:none}.ui-body .ui-sidebar nav a[aria-current=page],.ui-body .ui-sidebar nav a:hover{background:hsl(var(--muted));color:hsl(var(--foreground))}.ui-body .ui-desktop-navigation{display:flex;flex-direction:column;flex:1;gap:1rem}.ui-body .ui-sidebar-footer{margin-top:auto;border-top:1px solid hsl(var(--border));padding-top:.75rem}.ui-body .ui-mobile-navigation{display:none}.ui-body .ui-content{min-width:0;width:100%;padding:1.5rem 2rem}.ui-body .ui-page-header{margin-bottom:1.25rem;padding-inline-end:3rem}.ui-body .ui-page-header h1{font-size:1.5rem;margin:0}.ui-body[data-layout=application] .ui-card,.ui-body[data-layout=application] .ui-section{padding:1.25rem;border:1px solid hsl(var(--border));border-radius:.75rem;margin-bottom:1rem}.ui-body .ui-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.75rem;margin:1rem 0}.ui-body .ui-metric{padding:1rem;display:flex;flex-direction:column;border:1px solid hsl(var(--border));border-radius:.75rem;text-decoration:none;color:inherit}.ui-body .ui-metric strong{font-size:1.875rem}.ui-body .ui-metric-label{color:hsl(var(--muted-foreground));font-size:.875rem}.ui-body .ui-chart svg{max-width:100%;height:auto}.ui-body .ui-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:1rem}.ui-body .ui-form-grid>.ui-actions{grid-column:1/-1}.ui-body .ui-actions,.ui-body .ui-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}.ui-body .ui-table-wrap{overflow:auto;border:1px solid hsl(var(--border));border-radius:.5rem}.ui-body table{width:100%;border-collapse:collapse;font-size:.875rem}.ui-body th,.ui-body td{text-align:start;padding:.625rem .75rem;border-bottom:1px solid hsl(var(--border))}.ui-body th{color:hsl(var(--muted-foreground));font-weight:500}.ui-body input:not([type=hidden]):not([type=checkbox]):not([type=radio]),.ui-body select{border:1px solid hsl(var(--input));border-radius:.375rem;padding:.375rem .75rem;min-height:2.25rem;max-width:100%;background:transparent;color:inherit;font:inherit}.ui-body label{font-size:.875rem;font-weight:500}.ui-body button:not(.ui-theme-toggle):not(.ui-button){display:inline-flex;align-items:center;justify-content:center;gap:.5rem;padding:.375rem 1rem;min-height:2.25rem;border-radius:.375rem;background:hsl(var(--primary));color:hsl(var(--primary-foreground));font-size:.875rem;cursor:pointer}.ui-body .ui-progress{font-size:.75rem;color:hsl(var(--muted-foreground))}
@media(max-width:720px){.ui-body .ui-shell{display:block}.ui-body .ui-sidebar{position:static;height:auto}.ui-body .ui-brand{padding-inline-end:3rem;min-height:2.75rem}.ui-body .ui-desktop-navigation{display:none}.ui-body .ui-mobile-navigation{display:block}.ui-body .ui-mobile-navigation nav{flex-direction:row;flex-wrap:wrap}.ui-body .ui-content{padding:1.25rem 1rem}.ui-body .ui-form-grid{grid-template-columns:1fr}.ui-body .ui-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.ui-body input:not([type=hidden]),.ui-body select,.ui-body button:not(.ui-theme-toggle):not(.ui-button){min-height:2.75rem;font-size:1rem}}
/* Shared consumer markup keeps the same treatment as kit components. */
.ui-body a{color:inherit;text-underline-offset:3px}.ui-body .ui-stack{display:grid;gap:1rem}.ui-body .ui-stack>form{margin:0}.ui-body .ui-section{padding:1.25rem}.ui-body .ui-section>h2:first-child{margin-top:0}.ui-body .ui-section h2{font-size:1.125rem;font-weight:600}.ui-body .ui-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,24rem),1fr));gap:1rem;align-items:start}.ui-body .ui-settings-grid>.ui-section{margin:0}.ui-body .ui-card-list{list-style:none;padding:0}.ui-body .ui-link-list{display:flex;flex-wrap:wrap;justify-content:center;gap:.5rem 1rem;font-size:.875rem;margin-top:1.25rem;color:hsl(var(--muted-foreground))}.ui-body .ui-selected-identity{min-width:0}.ui-body .ui-identifier{min-width:0;overflow-wrap:anywhere}.ui-body .ui-selected-identity>a{flex:none}.ui-body .error{border:1px solid hsl(var(--destructive)/.5);border-radius:.5rem;padding:.75rem 1rem;color:hsl(var(--foreground));font-size:.875rem}.ui-body[data-layout=compact] form.ui-stack>button{width:100%;margin-top:.5rem}.ui-body button.ui-button-secondary{background:hsl(var(--background));color:hsl(var(--foreground));border:1px solid hsl(var(--border))}.ui-body button.ui-button-secondary:hover{background:hsl(var(--muted))}.ui-body button.ui-button-destructive,.ui-body .ui-danger-zone button{background:hsl(var(--destructive));color:hsl(var(--destructive-foreground))}.ui-body .ui-filter-card{padding:1rem}.ui-body .ui-field input,.ui-body .ui-field select{width:100%}.ui-body .ui-field>p{font-size:.875rem;color:hsl(var(--muted-foreground));margin:.375rem 0}.ui-body .ui-mobile-navigation summary{display:flex;align-items:center;gap:.5rem;cursor:pointer;font-size:.875rem}.ui-body input:focus-visible,.ui-body select:focus-visible,.ui-body button:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}

.ui-body{display:flow-root;--chart-1:#0891b2;--chart-2:#0d9488;--chart-3:#e45c66}.ui-chart-key::before{content:"";display:inline-block;width:.5rem;height:.5rem;border-radius:100%;background:var(--chart-1)}.ui-chart-key-green::before{background:var(--chart-2)}.ui-chart-key-red::before{background:var(--chart-3)}.dark{color-scheme:dark}.light{color-scheme:light}.ui-header:not(:has(a,img,nav,details)):has(.ui-brand>span:empty){display:none}.ui-main:has(.ui-settings-grid){max-width:72rem}.ui-tabs a{display:inline-flex;align-items:center;gap:.5rem}.ui-body .ui-icon{vertical-align:-.2em}.ui-body summary>.ui-icon,.ui-body .ui-toolbar a>.ui-icon{margin-inline-end:.4rem}.ui-body .ui-toolbar>label,.ui-body .ui-form-grid>label{display:flex;flex-direction:column;gap:.375rem;min-width:0}.ui-body .ui-filter{margin:.75rem 0}.ui-body summary{cursor:pointer;font-size:.875rem}.ui-body details[open]>summary{margin-bottom:1rem}.ui-body .ui-section-heading{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:.75rem}.ui-body .ui-section-heading h2{margin:0;font-size:1.125rem}.ui-body .ui-badge{display:inline-flex;align-items:center;border:1px solid hsl(var(--border));border-radius:999px;padding:.125rem .5rem;font-size:.75rem;white-space:nowrap;background:hsl(var(--muted))}.ui-body .ui-account-id{display:block;max-width:18rem;overflow-wrap:anywhere;font-size:.75rem;margin-top:.25rem;color:hsl(var(--muted-foreground))}.ui-body .ui-table-wrap table{min-width:45rem}.ui-body th{white-space:nowrap;overflow-wrap:normal}.ui-body td{overflow-wrap:normal}.ui-body .ui-activity{list-style:none;padding:0}.ui-body .ui-activity li{display:flex;justify-content:space-between;gap:1rem;padding:.75rem 0;border-bottom:1px solid hsl(var(--border));font-size:.875rem}.ui-body .ui-chart-legend{display:flex;gap:1rem;flex-wrap:wrap;font-size:.875rem}.ui-body .ui-chart-legend>span{display:inline-flex;align-items:center;gap:.375rem}.ui-body .ui-list{list-style:none;padding:0}.ui-body .ui-definition-grid{display:grid;grid-template-columns:minmax(8rem,1fr) 3fr;gap:.5rem 1rem}.ui-body .ui-definition-grid dd{margin:0;overflow-wrap:anywhere}.ui-body .ui-form-grid{align-items:end}.ui-body .ui-brand>span:first-child{display:grid;place-items:center;width:1.9rem;height:1.9rem;border:1px solid hsl(var(--border));border-radius:.375rem}.ui-body .ui-toolbar>label:first-child{flex:1;min-width:min(15rem,100%)}.ui-body .ui-table-wrap{margin-bottom:.75rem}
@media(max-width:720px){.ui-body .ui-toolbar>label{width:100%}.ui-body .ui-definition-grid{grid-template-columns:1fr}.ui-body .ui-activity li{flex-direction:column;gap:.25rem}}

@media(max-width:720px){.ui-body input:not([type=hidden]):not([type=checkbox]):not([type=radio]),.ui-body[data-layout=compact] input:not([type=hidden]):not([type=checkbox]):not([type=radio]),.ui-body select{min-height:2.75rem;font-size:1rem}.ui-body .ui-mobile-navigation summary,.ui-body .ui-mobile-navigation a{min-height:2.75rem}}

.ui-icon{display:inline-block;width:1.125rem;height:1.125rem;flex:none;vertical-align:-.2em;pointer-events:none}.ui-nav a>.ui-icon,.ui-tabs a>.ui-icon,.ui-button>.ui-icon{margin-inline-end:.4rem}[dir=rtl] .ui-icon-directional{transform:scaleX(-1)}.ui-sidebar-nav ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.25rem}.ui-sidebar-nav a{display:flex;align-items:center;gap:.7rem;padding:.6rem .8rem;border-radius:var(--radius);color:hsl(var(--sidebar-foreground));font-size:.875rem;font-weight:500;text-decoration:none}.ui-sidebar-nav a:hover{background:hsl(var(--accent));color:hsl(var(--accent-foreground))}.ui-sidebar-nav a[aria-current]{background:hsl(var(--secondary));color:hsl(var(--foreground))}.ui-badge[data-status=active]{background:hsl(142 71% 45%/.12);color:hsl(142 71% 30%);border-color:hsl(142 71% 45%/.4)}.ui-chart-key{display:inline-flex;align-items:center;gap:.4rem}@media (max-width:720px){.ui-sidebar-nav ul{flex-direction:row;flex-wrap:wrap}}
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
