import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {themeScript} from '../src/theme-script.ts';
import {renderDocument,createPresentation} from '../src/index.ts';
function browser(stored:string|null, dark=false, denied=false){
 const events=new Map<string,Function>(),mediaEvents=new Map<string,Function>(),buttonEvents=new Map<string,Function>();
 const root={dataset:{} as Record<string,string>},control={hidden:true},select={dataset:{labelLight:'Switch to light mode',labelDark:'Switch to dark mode'},attributes:{} as Record<string,string>,setAttribute(name:string,value:string){this.attributes[name]=value;},addEventListener:(name:string,fn:Function)=>buttonEvents.set(name,fn)};
 const media={matches:dark,addEventListener:(name:string,fn:Function)=>mediaEvents.set(name,fn)};
 let saved=stored;
 runInNewContext(themeScript,{document:{documentElement:root,readyState:'complete',querySelector:(selector:string)=>selector==='[data-ui-theme]'?select:control},matchMedia:()=>media,localStorage:{getItem:()=>{if(denied)throw Error('blocked');return saved;},setItem:(_key:string,value:string)=>{if(denied)throw Error('blocked');saved=value;}},addEventListener:(name:string,fn:Function)=>events.set(name,fn)});
 return{root,control,select,media,events,mediaEvents,buttonEvents,saved:()=>saved};
}
test('theme toggle follows system until clicked and persists the actual light/dark choice',()=>{
 const b=browser(null,true);assert.equal(b.root.dataset.theme,'dark');assert.equal(b.control.hidden,false);assert.equal(b.select.attributes['aria-label'],'Switch to light mode');
 b.buttonEvents.get('click')!();assert.equal(b.root.dataset.theme,'light');assert.equal(b.saved(),'light');assert.equal(b.select.attributes.title,'Switch to dark mode');
 b.media.matches=true;b.mediaEvents.get('change')!();assert.equal(b.root.dataset.theme,'light');
 b.buttonEvents.get('click')!();assert.equal(b.root.dataset.theme,'dark');assert.equal(b.saved(),'dark');
 b.events.get('storage')!({key:'urlcode-ui.theme',newValue:'light'});assert.equal(b.root.dataset.theme,'light');
 b.events.get('storage')!({key:null,newValue:null});assert.equal(b.root.dataset.theme,'dark');
 assert.equal(browser('dark').root.dataset.theme,'dark');assert.equal(browser('invalid').root.dataset.theme,'light');
 const restricted=browser(null,true,true);assert.doesNotThrow(()=>restricted.buttonEvents.get('click')!());assert.equal(restricted.root.dataset.theme,'light');
});
test('appearance is opt-in, nonce-bound and localized without interpolating content into script',()=>{
 const plain=renderDocument({title:'Hi',trustedContent:''});assert.doesNotMatch(plain,/<script/);
 const p=createPresentation({catalogues:{fr:{'theme.toggleLight':'Mode clair','theme.toggleDark':'Mode sombre'}}}).resolve({queryLocale:'fr'});
 const html=renderDocument({title:'Hi',trustedContent:'',theme:{nonce:'a'.repeat(24)},presentation:p});
 assert.match(html,/<script nonce="a{24}">/);assert.match(html,/Mode clair/);assert.match(html,/Mode sombre/);assert.doesNotMatch(html,/<select|>Appearance</);assert.match(html,/type="button" class="ui-theme-toggle"/);assert.match(html,/data-ui-appearance hidden/);
 assert.throws(()=>renderDocument({title:'Hi',trustedContent:'',theme:{nonce:'bad"'}}));
 assert.doesNotMatch(themeScript,/fetch\(|XMLHttpRequest|innerHTML|document\.cookie/);
});
