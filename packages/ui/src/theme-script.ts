/** Static first-party enhancement. No user data interpolation, network calls or authentication state. */
export const themeScript = `(()=>{
 const key='urlcode-ui.theme',root=document.documentElement,media=matchMedia('(prefers-color-scheme: dark)');
 const valid=value=>['system','light','dark'].includes(value);
 let preference='system';try{const stored=localStorage.getItem(key);if(valid(stored))preference=stored;}catch{}
 const apply=()=>{root.dataset.theme=preference==='system'?(media.matches?'dark':'light'):preference;root.classList?.toggle('dark',root.dataset.theme==='dark');root.classList?.toggle('light',root.dataset.theme==='light');const button=document.querySelector('[data-ui-theme]');if(button){const label=root.dataset.theme==='dark'?button.dataset.labelLight:button.dataset.labelDark;button.setAttribute('aria-label',label);button.setAttribute('title',label);}};
 apply();media.addEventListener('change',apply);
 addEventListener('storage',event=>{if(event.key===key||event.key===null){preference=valid(event.newValue)?event.newValue:'system';apply();}});
 const ready=()=>{const control=document.querySelector('[data-ui-appearance]'),button=document.querySelector('[data-ui-theme]');if(control&&button){control.hidden=false;apply();button.addEventListener('click',()=>{preference=root.dataset.theme==='dark'?'light':'dark';try{localStorage.setItem(key,preference);}catch{}apply();});}};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
})();`;
