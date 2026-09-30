import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {stringify} from 'yaml';
import {importBulkProject} from '../packages/core/src/bulk.ts';
import {loadDocument} from '../packages/core/src/config.ts';
import {createRuntime} from '../packages/core/src/runtime.ts';
import {project} from './helpers.ts';

test('bulk import shards routes deterministically and preserves input provenance without copying input',async t=>{
  const root=await project(t,{}),output=join(root,'built');
  const input='path,url,status\n'+Array.from({length:1001},(_,i)=>`/r${String(i).padStart(4,'0')},https://example.com/${i},301`).reverse().join('\n')+'\n';
  const preview=await importBulkProject(input,'csv',output,{dryRun:true,source:'redirects.csv'});
  assert.equal(preview.ok,true);assert.equal(preview.routeCount,1001);assert.deepEqual(preview.files.map(file=>file.routeCount),[0,1000,1,0]);
  await assert.rejects(lstat(output),{code:'ENOENT'});
  const built=await importBulkProject(input,'csv',output,{source:'redirects.csv'});assert.deepEqual(built.files,preview.files);
  const loaded=await loadDocument(output);assert.equal(Object.keys(loaded.routes).length,1001);assert.equal(loaded.document.includes?.length,2);
  const provenance: {source:{name:string;sha256:string};routeCount:number}=JSON.parse(await readFile(join(output,'provenance.json'),'utf8'));
  assert.equal(provenance.source.name,'redirects.csv');assert.match(provenance.source.sha256,/^[a-f0-9]{64}$/);assert.equal(provenance.routeCount,1001);
  const runtime=await createRuntime(output);t.after(()=>runtime.close());
  const reply=await runtime.handle({target:'/r1000'});assert.equal(reply.status,301);assert.ok(reply.headers.some(([key,value])=>key.toLowerCase()==='location'&&value==='https://example.com/1000'));
});

test('bulk JSON and YAML row forms have equivalent output and support empty catalogs',async t=>{
  const root=await project(t,{}),rows=[{path:'/a',url:'https://example.com',status:307}];
  const json=await importBulkProject(JSON.stringify(rows),'json',join(root,'json'));
  const yaml=await importBulkProject(stringify(rows),'yaml',join(root,'yaml'));
  assert.deepEqual(json.files,yaml.files);
  assert.equal(await readFile(join(root,'json/routes/redirects-001.yaml'),'utf8'),await readFile(join(root,'yaml/routes/redirects-001.yaml'),'utf8'));
  const empty=await importBulkProject('[]','json',join(root,'empty'));assert.equal(empty.routeCount,0);assert.equal((await loadDocument(join(root,'empty'))).document.includes,undefined);
});

test('bulk failures retain row diagnostics and never overwrite or publish a partial project',async t=>{
  const root=await project(t,{}),output=join(root,'built');
  const duplicate=await importBulkProject('path,url,status\n/a,https://example.com,301\n/a,https://example.org,302\n','csv',output,{source:'fixture.csv'});
  assert.equal(duplicate.ok,false);assert.ok(duplicate.diagnostics.some(item=>item.code==='duplicate-path'&&item.row===3&&item.source==='fixture.csv'));
  await assert.rejects(lstat(output),{code:'ENOENT'});
  const invalid=await importBulkProject('[{"path":"/a","url":"javascript:alert(1)"}]','json',output);
  assert.equal(invalid.ok,false);await assert.rejects(lstat(output),{code:'ENOENT'});
  await importBulkProject('[]','json',output);const original=await readFile(join(output,'urlcode.yaml'),'utf8');
  await assert.rejects(importBulkProject('[]','json',output),/already exists/);assert.equal(await readFile(join(output,'urlcode.yaml'),'utf8'),original);
});

// Row validation for the csv, json and yaml row forms.
const rows=(text:string,format:'csv'|'json'|'yaml',source?:string)=>importBulkProject(text,format,join(tmpdir(),`urlcode-bulk-rows-${process.pid}-never-written`),{dryRun:true,...(source?{source}:{})});
test('CSV quotes are parsed without dropping columns or malformed data',async()=>{
  assert.equal((await rows('path,url,status\r\n/a,"https://example.test/?a=x,y",302\r\n','csv')).diagnostics.length,0);
  for(const text of ['path,url,status\n/a,"https://example.test,302','path,url,status\n/a,"https://example.test"oops,302','path,url,status\n/a,https://example.test,302,extra'])assert.equal((await rows(text,'csv')).ok,false,text);
});
test('invalid or unsupported row semantics are refused',async()=>{
  for(const [format,text] of [
    ['json','[{"path":"/a","url":"https://user:password@example.test"}]'],['json','[{"path":"/a","url":"javascript:alert(1)"}]'],
    ['json','[{"path":"/a","url":"https://example.test/{x}"}]'],['json','[{"path":"/_urlcode/health","url":"https://example.test"}]'],
    ['json','[{"path":"/../a","url":"https://example.test"}]'],['json','[{"path":"/a","url":"https://example.test","__proto__":{}}]'],
    ['json','[{"path":"/a","path":"/b","url":"https://example.test"}]'],['json','[{"path":"/a","url":"https://example.test","status":200}]'],
    ['yaml','- &row {path: /a, url: "https://example.test"}\n- *row'],
  ] as const){const report=await rows(text,format);assert.equal(report.ok,false,`${format}: ${text}`);assert.deepEqual(report.files,[]);}
});
test('an invalid row names its file and physical CSV row without echoing credentials',async()=>{
  const result=await rows('path,url,status\n/a,https://private:credential@example.test,301\n','csv','data.csv');
  assert.equal(result.diagnostics[0]?.row,2);assert.equal(result.diagnostics[0]?.source,'data.csv');assert.ok(!JSON.stringify(result.diagnostics).includes('credential'));
});
test('late invalid rows keep their provenance through bounded compiler diagnostics, and input size is bounded',async()=>{
  const late=Array.from({length:1000},(_,i)=>({path:`/p${i}`,url:i===999?'https://secret:credential@example.test':'https://example.test'}));
  const result=await rows(JSON.stringify(late),'json','rows.json');assert.equal(result.ok,false);assert.equal(result.diagnostics[0]?.row,1000);assert.equal(result.diagnostics[0]?.source,'rows.json');
  assert.equal((await rows(' '.repeat(32*1024*1024+1),'json')).ok,false);
});
test('an unpaired surrogate is refused in every row format, never written as an escape the redirect sends as U+FFFD (#1021)',async()=>{
  for(const [format,text] of [['json','[{"path":"/a","url":"https://example.test/\\ud800","status":301}]'],['yaml','- {path: /a, url: "https://example.test/\\udc00", status: 301}\n'],['csv','path,url,status\n/a,https://example.test/\ud800,301\n']] as const){
    const result=await rows(text,format);
    assert.equal(result.ok,false,format);
    assert.match(result.diagnostics.find(d=>d.severity==='error')?.message??'',/unpaired UTF-16 surrogate/i,format);
  }
});
