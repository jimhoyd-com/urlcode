import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {themeScript} from '../src/theme-script.ts';
import {renderDocument,createPresentation} from '../src/index.ts';
function browser(stored:string|null, dark=false, denied=false){
 const events=new Map<string,Function>(),mediaEvents=new Map<string,Function>(),selectEvents=new Map<string,Function>();
 const root={dataset:{} as Record<string,string>},control={hidden:true},select={value:'',addEventListener:(name:string,fn:Function)=>selectEvents.set(name,fn)};
 const media={matches:dark,addEventListener:(name:string,fn:Function)=>mediaEvents.set(name,fn)};
 let saved=stored;
 runInNewContext(themeScript,{document:{documentElement:root,readyState:'complete',querySelector:(selector:string)=>selector==='[data-ui-theme]'?select:control},matchMedia:()=>media,localStorage:{getItem:()=>{if(denied)throw Error('blocked');return saved;},setItem:(_key:string,value:string)=>{if(denied)throw Error('blocked');saved=value;}},addEventListener:(name:string,fn:Function)=>events.set(name,fn)});
 return{root,control,select,media,events,mediaEvents,selectEvents,saved:()=>saved};
}
test('appearance follows system until explicitly chosen and persists only a bounded preference',()=>{
 const b=browser(null,true);assert.equal(b.root.dataset.theme,'dark');assert.equal(b.select.value,'system');assert.equal(b.control.hidden,false);
 b.select.value='light';b.selectEvents.get('change')!();assert.equal(b.root.dataset.theme,'light');assert.equal(b.saved(),'light');
 b.media.matches=true;b.mediaEvents.get('change')!();assert.equal(b.root.dataset.theme,'light');
 b.select.value='system';b.selectEvents.get('change')!();assert.equal(b.root.dataset.theme,'dark');
 b.events.get('storage')!({key:'urlcode-ui.theme',newValue:'light'});assert.equal(b.root.dataset.theme,'light');
 b.events.get('storage')!({key:'urlcode-ui.theme',newValue:'invalid'});assert.equal(b.select.value,'system');
 assert.equal(browser('dark').root.dataset.theme,'dark');assert.equal(browser('invalid').root.dataset.theme,'light');
 const restricted=browser(null,true,true);restricted.select.value='light';assert.doesNotThrow(()=>restricted.selectEvents.get('change')!());assert.equal(restricted.root.dataset.theme,'light');
});
test('appearance is opt-in, nonce-bound and localized without interpolating content into script',()=>{
 const plain=renderDocument({title:'Hi',trustedContent:''});assert.doesNotMatch(plain,/<script/);
 const p=createPresentation({catalogues:{fr:{'theme.label':'Apparence','theme.dark':'Sombre'}}}).resolve({queryLocale:'fr'});
 const html=renderDocument({title:'Hi',trustedContent:'',theme:{nonce:'a'.repeat(24)},presentation:p});
 assert.match(html,/<script nonce="a{24}">/);assert.match(html,/Apparence/);assert.match(html,/Sombre/);assert.match(html,/data-ui-appearance hidden/);
 assert.throws(()=>renderDocument({title:'Hi',trustedContent:'',theme:{nonce:'bad"'}}));
 assert.doesNotMatch(themeScript,/fetch\(|XMLHttpRequest|innerHTML|document\.cookie/);
});
