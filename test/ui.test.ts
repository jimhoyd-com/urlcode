import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createPresentation,renderDocument,field,table,navigation,alert,escapeHtml,stylesheet,attributes,emptyState,pagination,localHref,assetPath,contentHash,compareCatalogues} from '../src/index.ts';
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
 const entries=await readdir(new URL('../src/',import.meta.url),{withFileTypes:true});
 assert.deepEqual(entries.filter(entry=>entry.isDirectory()).map(entry=>entry.name),['host'],'only src/host/ may import Node modules; a new subdirectory must be added to the closure test');
 for(const file of entries.filter(entry=>entry.isFile()&&entry.name.endsWith('.ts')).map(entry=>entry.name)){const source=await readFile(new URL('../src/'+file,import.meta.url),'utf8');assert.doesNotMatch(source,/(?:from\s*|import\s*\()\s*['"](?:node:|@|[a-z])/);assert.doesNotMatch(source,/\b(?:process|Buffer|require)\s*[.(]/);assert.doesNotMatch(source,/--auth-|page\.signIn|adminOps\./);}
 assert.match(stylesheet,/focus-visible/);assert.match(stylesheet,/border-inline-start/);assert.match(stylesheet,/prefers-color-scheme/);
});

test('generic document layouts remain bounded and ship compiled Tailwind styles',()=>{
 assert.match(renderDocument({title:'Welcome',trustedContent:field({name:'email',label:'Email'}),layout:'compact'}),/data-layout="compact"/);
 assert.throws(()=>renderDocument({title:'Unsafe',trustedContent:'',layout:'bad" onclick="evil' as 'compact'}));
 assert.match(stylesheet,/tailwindcss/);assert.match(stylesheet,/ui-sidebar/);assert.match(stylesheet,/ui-metric/);
 assert.doesNotMatch(stylesheet,/@import|url\(/);
});
test('document scripts accept absolute https and local sources only, and the count and size limits hold',()=>{
 const nonce='a'.repeat(24), doc=(scripts:{src:string;nonce:string;async?:boolean}[])=>renderDocument({title:'Hi',trustedContent:'',scripts});
 assert.match(doc([{src:'https://cdn.example.test/lib.js?v=1',nonce,async:true}]),/<script nonce="a{24}" src="https:\/\/cdn\.example\.test\/lib\.js\?v=1" async defer><\/script>/);
 for(const src of ['http://cdn.example.test/lib.js','//cdn.example.test/lib.js','https://user:pw@cdn.example.test/lib.js','data:text/javascript,1','lib.js',''])assert.throws(()=>doc([{src,nonce}]),src||'(empty)');
 assert.doesNotMatch(doc([{src:'https://cdn.example.test/"><script>',nonce}]),/"><script>/);
 assert.equal((doc(Array.from({length:8},()=>({src:'/s.js',nonce}))).match(/<script /g)??[]).length,8);
 assert.throws(()=>doc(Array.from({length:9},()=>({src:'/s.js',nonce}))),/exceeds limit/);
 assert.throws(()=>renderDocument({title:'Hi',trustedContent:'x'.repeat(4194305)}),/exceeds limit/);
 assert.doesNotThrow(()=>renderDocument({title:'Hi',trustedContent:'x'.repeat(4194304)}));
});
test('attributes, emptyState and pagination escape values and reject unsafe attribute names',()=>{
 assert.equal(attributes({id:'a"b<c>&\'',hidden:true,'data-x':0,skip:null,gone:undefined,off:false}),' id="a&quot;b&lt;c&gt;&amp;&#39;" hidden data-x="0"');
 for(const name of ['onClick','on click','x"y','1x','data_x','','Id'])assert.throws(()=>attributes({[name]:'v'}),/Invalid attribute name/);
 assert.equal(emptyState('<b>nothing</b> & "none"'),'<p class="ui-empty">&lt;b&gt;nothing&lt;/b&gt; &amp; &quot;none&quot;</p>');
 const nav=pagination({previous:'/p?page=1',next:'/p?page=3',previousLabel:'<Prev>',nextLabel:'Next "3"',label:'Pages & more'});
 assert.match(nav,/^<nav aria-label="Pages &amp; more"><a href="\/p\?page=1">&lt;Prev&gt;<\/a><a href="\/p\?page=3">Next &quot;3&quot;<\/a><\/nav>$/);
 assert.equal(pagination({}),'<nav aria-label="Pagination"></nav>');
 assert.throws(()=>pagination({next:'//evil.test'}));assert.throws(()=>pagination({previous:'javascript:alert(1)'}));
});
test('localHref and assetPath reject protocol-relative, query, encoded traversal, backslash and empty values',()=>{
 assert.equal(localHref('/account?page=2'),'/account?page=2');assert.equal(assetPath('/img/logo.svg'),'/img/logo.svg');assert.equal(localHref(undefined),undefined);assert.equal(assetPath(undefined),undefined);
 for(const value of ['//evil.test','','\\evil','/a\\b','https://evil.test/','javascript:alert(1)','account','/a b','/a"b','/a<b>','/x'.repeat(600)])assert.throws(()=>localHref(value),/same-site path/);
 for(const value of ['//evil.test','','/a?x=1','/%2e%2e/etc','/a/../b','/./a','/a\\b','\\a','/a b','/a"b','https://evil.test/a','/'+'a'.repeat(512)])assert.throws(()=>assetPath(value),/safe local path/);
 assert.throws(()=>localHref(1 as never));assert.throws(()=>assetPath({} as never));
});
test('field id overrides are escaped, contentHash is deterministic and compareCatalogues reports drift',()=>{
 const html=field({name:'email',label:'Email',id:'x" onfocus="evil',description:'d',error:'e'});
 assert.doesNotMatch(html,/onfocus="evil/);assert.match(html,/for="x&quot; onfocus=&quot;evil"/);assert.match(html,/aria-describedby="x&quot; onfocus=&quot;evil-description x&quot; onfocus=&quot;evil-error"/);
 assert.equal(contentHash('a'),contentHash('a'));assert.match(contentHash(''),/^[0-9a-f]{12}$/);assert.notEqual(contentHash('a'),contentHash('b'));assert.equal(contentHash('é'),contentHash('\u00e9'));
 assert.deepEqual(compareCatalogues({'a':'Hi {name}','b':'x','c':{one:'{count}',other:'{count}s'}},{'a':'Salut {nom}','c':{one:'{count}',other:'{count}'},'d':'y'}),{missing:['b'],mismatched:['a'],unknown:['d']});
});
