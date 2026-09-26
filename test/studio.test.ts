import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stringify} from 'yaml';
import {browserCommand,startStudio} from '../packages/core/src/studio.ts';
import {reportContentSecurityPolicy} from '../packages/core/src/project-report.ts';
import {project} from './helpers.ts';
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));

// fetch() fixes the Host header, so requests that need another one go through node:http.
function get(url:string,{method='GET',host}:{method?:string;host?:string}={}):Promise<{status:number;headers:http.IncomingHttpHeaders;body:string}> {
  return new Promise((resolve,reject)=>{
    const request=http.request(url,{method,...(host?{headers:{host}}:{})},response=>{
      let body='';response.setEncoding('utf8').on('data',chunk=>body+=chunk).on('end',()=>resolve({status:response.statusCode!,headers:response.headers,body}));
    });
    request.on('error',reject).end();
  });
}

test('studio rebuilds the report from disk on every request and shows a load error instead of stopping',async t=>{
  const root=await project(t,{'/a':{description:'first',respond:{text:'a'}}});
  const studio=await startStudio({project:root,host:'127.0.0.1',port:0});
  t.after(()=>studio.close());
  const first=await get(studio.url);
  assert.equal(first.status,200);
  assert.equal(first.headers['content-security-policy'],reportContentSecurityPolicy);
  assert.equal(first.headers['cache-control'],'no-store');
  assert.match(first.body,/<code>\/a<\/code>/);
  assert.doesNotMatch(first.body,/<code>\/b<\/code>/);
  await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',routes:{'/a':{respond:{text:'a'}},'/b':{respond:{text:'b'}}}}));
  assert.match((await get(studio.url)).body,/<code>\/b<\/code>/);
  await writeFile(join(root,'urlcode.yaml'),'version: "1"\nroutes:\n  /a: {respond: {text: <script>}, redirect: {url: /x}}\n');
  const broken=await get(studio.url);
  assert.equal(broken.status,500);
  assert.match(broken.body,/The project does not load/);
  assert(!/<script/i.test(broken.body));
});

test('studio serves this machine only',async t=>{
  const root=await project(t,{'/a':{respond:{text:'a'}}});
  assert.throws(()=>startStudio({project:root,host:'0.0.0.0',port:0}),/this machine only/);
  const studio=await startStudio({project:root,host:'127.0.0.1',port:0});
  t.after(()=>studio.close());
  assert.equal((await get(studio.url,{host:'attacker.example'})).status,403);
  assert.equal((await get(studio.url,{host:'attacker.example:4100'})).status,403);
  assert.equal((await get(studio.url,{host:'localhost:4100'})).status,200);
  const post=await get(studio.url,{method:'POST'});
  assert.equal(post.status,405);
  assert.equal(post.headers.allow,'GET, HEAD');
  assert.equal((await get(new URL('/other',studio.url).href)).status,404);
  const head=await get(studio.url,{method:'HEAD'});
  assert.equal(head.status,200);
  assert.equal(head.body,'');
});

test('concurrent reloads share one build, so they never exhaust project loading',async t=>{
  const root=await project(t,{'/a':{respond:{text:'a'}}});
  const studio=await startStudio({project:root,host:'127.0.0.1',port:0});
  t.after(()=>studio.close());
  const pages=await Promise.all(Array.from({length:6},()=>get(studio.url)));
  assert.deepEqual(pages.map(page=>page.status),[200,200,200,200,200,200]);
});

test('studio compares with BEFORE on each request',async t=>{
  const before=await project(t,{'/a':{respond:{text:'a'}}});
  const root=await project(t,{'/a':{respond:{text:'a'}},'/b':{respond:{text:'b'}}});
  const studio=await startStudio({project:root,before,host:'127.0.0.1',port:0});
  t.after(()=>studio.close());
  const body=(await get(studio.url)).body;
  assert.match(body,/Adds <a href="#%2Fb"><code>\/b<\/code><\/a>/);
  // Unlike `urlcode report`, the studio page says when it was built.
  assert.match(body,/built [^<]+, reload to rebuild/);
});

test('urlcode studio prints its URL and stops on SIGINT',async t=>{
  const root=await project(t,{'/a':{respond:{text:'a'}}});
  const child=spawn(process.execPath,[cli,'studio','--project',root,'--port','0'],{stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());
  const [line]=await once(child.stdout.setEncoding('utf8'),'data') as [string];
  const event=JSON.parse(line) as {event:string;mode:string;url:string};
  assert.equal(event.event,'listening');
  assert.equal(event.mode,'studio');
  assert.equal((await get(event.url)).status,200);
  child.kill('SIGINT');
  const [code,signal]=await once(child,'exit') as [number|null,NodeJS.Signals|null];
  // Windows cannot deliver SIGINT to a child process: kill() terminates it, so only POSIX can observe the graceful stop.
  if(process.platform==='win32')assert.equal(signal,'SIGINT');
  else assert.equal(code,0);
});

test('the browser opener follows BROWSER, then the platform, and never goes through a shell',()=>{
  const url='http://127.0.0.1:4100/';
  assert.deepEqual(browserCommand(url,'darwin',undefined),['open',[url]]);
  assert.deepEqual(browserCommand(url,'win32',undefined),['explorer.exe',[url]]);
  assert.deepEqual(browserCommand(url,'linux',undefined),['xdg-open',[url]]);
  assert.deepEqual(browserCommand(url,'linux',''),['xdg-open',[url]]);
  assert.deepEqual(browserCommand(url,'darwin','/usr/bin/firefox'),['/usr/bin/firefox',[url]]);
  assert.equal(browserCommand(url,'darwin','none'),undefined);
});

test('urlcode studio --open opens the page, and --open/--no-open belong to studio only',{skip:process.platform==='win32'&&'the fake browser is a shell script'},async t=>{
  const root=await project(t,{'/a':{respond:{text:'a'}}});
  const dir=await mkdtemp(join(tmpdir(),'urlcode-studio-open-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const browser=join(dir,'browser.sh'),seen=join(dir,'seen.txt');
  await writeFile(browser,`#!/bin/sh\nprintf '%s' "$1" > '${seen}'\n`);
  await chmod(browser,0o755);
  const child=spawn(process.execPath,[cli,'studio','--project',root,'--port','0','--open'],{stdio:['ignore','pipe','pipe'],env:{...process.env,BROWSER:browser}});
  t.after(()=>child.kill());
  const [line]=await once(child.stdout.setEncoding('utf8'),'data') as [string];
  const event=JSON.parse(line) as {url:string;opened:boolean};
  assert.equal(event.opened,true);
  let opened='';
  for(let tries=0;tries<50&&!opened;tries++){opened=await readFile(seen,'utf8').catch(()=>'');if(!opened)await new Promise(done=>setTimeout(done,100));}
  assert.equal(opened,event.url);
  for(const args of [['report','--project',root,'--no-open'],['studio','--project',root,'--open','--no-open']]){
    const run=spawn(process.execPath,[cli,...args],{stdio:['ignore','pipe','pipe']});
    let stderr='';run.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
    const [code]=await once(run,'exit') as [number|null];
    assert.equal(code,1);
    assert.match(stderr,/--open|--no-open/);
  }
});
