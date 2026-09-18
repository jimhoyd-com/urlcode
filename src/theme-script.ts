/** Static first-party enhancement. No user data interpolation, network calls or authentication state. */
export const themeScript = `(()=>{
 const key='urlcode-ui.theme',root=document.documentElement,media=matchMedia('(prefers-color-scheme: dark)');
 const valid=value=>['system','light','dark'].includes(value);
 let preference='system';try{const stored=localStorage.getItem(key);if(valid(stored))preference=stored;}catch{}
 const apply=()=>{root.dataset.theme=preference==='system'?(media.matches?'dark':'light'):preference;const select=document.querySelector('[data-ui-theme]');if(select)select.value=preference;};
 apply();media.addEventListener('change',apply);
 addEventListener('storage',event=>{if(event.key===key){preference=valid(event.newValue)?event.newValue:'system';apply();}});
 const ready=()=>{const control=document.querySelector('[data-ui-appearance]'),select=document.querySelector('[data-ui-theme]');if(control&&select){control.hidden=false;select.value=preference;select.addEventListener('change',()=>{if(!valid(select.value))return;preference=select.value;try{localStorage.setItem(key,preference);}catch{}apply();});}};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
})();`;
