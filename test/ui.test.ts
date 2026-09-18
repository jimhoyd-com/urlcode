import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createPresentation,renderDocument,field,table,navigation,alert,escapeHtml,stylesheet} from '../src/index.ts';
test('shared documents escape user text and retain semantic labels, errors and navigation',()=>{
 const p=createPresentation({defaults:{'page.home':'Home'},catalogues:{fr:{'page.home':'Accueil','nav.skip':'Aller au contenu'}},theme:{'--ui-accent':'#123456'}}).resolve({queryLocale:'fr'});
 const html=renderDocument({title:p.text('page.home'),presentation:p,trustedContent:field({id:'email',name:'email',label:'Email <address>',description:'Use your email',error:'Invalid <script>',value:'" onfocus="evil'})+table('Accounts',['Name'],[['<img>']])+navigation([{label:'<Home>',href:'/'}])});
 assert.match(html,/lang="fr"/);assert.match(html,/Aller au contenu/);assert.match(html,/for="email"/);assert.match(html,/aria-describedby="email-description email-error"/);assert.match(html,/aria-invalid="true"/);assert.match(html,/scope="col"/);assert.match(html,/&lt;img&gt;/);assert.doesNotMatch(html,/<script|onfocus="evil/);assert.match(html,/--ui-accent:#123456/);
 assert.match(alert('<bad>','error'),/role="alert"/);assert.equal(escapeHtml('<"&'), '&lt;&quot;&amp;');
});
test('theme, URL, script and shape boundaries reject injection and oversized tables',()=>{
 for(const href of ['javascript:alert(1)','//evil.test','/\\evil','/bad\npath','/%0aevil'])assert.throws(()=>navigation([{label:'link',href}]));
 assert.throws(()=>createPresentation({theme:{'--ui-background':'red; background:url(https://evil.test)'}}));
 assert.throws(()=>field({name:'email" bad',label:'Email'}));assert.throws(()=>field({name:'email',label:'Email',type:'hidden'}));
 assert.throws(()=>table('Bad',['One'],[[1,2]]));assert.throws(()=>renderDocument({title:'Hi',trustedContent:'',scripts:[{src:'javascript:alert(1)',nonce:'a'.repeat(24)}]}));
 assert.throws(()=>renderDocument({title:'Hi',trustedContent:'',scripts:[{src:'/script.js',nonce:'" bad'}]}));
 assert.match(renderDocument({title:'<title>',trustedContent:'<p>Trusted</p>',scripts:[{src:'/script.js',nonce:'a'.repeat(24)}]}),/<script nonce="a{24}" src="\/script.js" defer/);
});
test('locale precedence, English fallback, RTL, plural rules and immutable input are shared',()=>{
 const defaults={'message.items':{one:'{count} item',other:'{count} items'},'page.home':'Home'};
 const p=createPresentation({defaults,catalogues:{fr:{'page.home':'Accueil'},ar:{'page.home':'الرئيسية'}}});defaults['page.home']='Changed';
 assert.equal(p.resolve({accountLocale:'ar',queryLocale:'fr'}).dir,'rtl');assert.equal(p.resolve({acceptLanguage:'fr-CA;q=0.8,en;q=0.4'}).text('page.home'),'Accueil');assert.equal(p.resolve().text('page.home'),'Home');assert.equal(p.resolve().text('message.items',{count:2}),'2 items');assert.equal(p.resolve({queryLocale:'ar'}).text('nav.skip'),'Skip to content');
 assert.throws(()=>p.resolve().text('missing.key'));assert.throws(()=>createPresentation({defaultLocale:'fr'}));
});
test('production modules are dependency-free and use portable web/platform APIs',async()=>{
 for(const file of (await readdir(new URL('../src/',import.meta.url))).filter(name=>name.endsWith('.ts'))){const source=await readFile(new URL('../src/'+file,import.meta.url),'utf8');assert.doesNotMatch(source,/(?:from\s*|import\s*\()\s*['"](?:node:|@|[a-z])/);assert.doesNotMatch(source,/\b(?:process|Buffer|require)\s*[.(]/);assert.doesNotMatch(source,/--auth-|page\.signIn|adminOps\./);}
 assert.match(stylesheet,/focus-visible/);assert.match(stylesheet,/border-inline-start/);assert.match(stylesheet,/prefers-color-scheme/);
});
