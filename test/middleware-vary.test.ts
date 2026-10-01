import test from 'node:test';
import assert from 'node:assert/strict';
// Reusable middleware that varies a response must run in composition with a downstream response that already varies
// (#1120): each module merges its request header into the existing Vary, never replacing it. Covers the standalone CORS
// recipe, the cookbook modules and the recipes/middleware copies generated from them.
type Context={env:Record<string,string>,state:Record<string,unknown>};
type Middleware=(request:Request,context:Context,next:()=>Promise<Response>)=>Promise<Response>;
const load=async(path:string)=>(await import(new URL(path,import.meta.url).href) as {default:Middleware}).default;
const env={ALLOWED_ORIGINS:'https://app.example.com',LOCALES:'en de fr',SITE:'https://example.com',VARIANT_URL:'https://example.com/b'};
const call=(run:Middleware,headers:Record<string,string>,downstream:()=>Response,method='GET')=>
  run(new Request('https://api.example.com/data',{method,headers}),{env,state:{}},async()=>downstream());
const allowed='https://app.example.com',disallowed='https://evil.example.net';

// Requests that reach the downstream response for each module.
const cases:{name:string,source:string,token:string,requests:Record<string,string>[]}[]=[];
for(const [dir,token] of [['../recipes/cors-api/middleware/','Origin'],['../examples/cookbook/middleware/','origin'],['../recipes/middleware/middleware/','origin']] as const)
  cases.push({name:`${dir.slice(3)}cors.mjs`,source:dir+'cors.mjs',token,requests:[{origin:allowed},{origin:disallowed},{}]});
for(const dir of ['../examples/cookbook/middleware/','../recipes/middleware/middleware/']){
  cases.push({name:`${dir.slice(3)}negotiate.mjs`,source:dir+'negotiate.mjs',token:'accept',requests:[{accept:'application/json'},{}]});
  cases.push({name:`${dir.slice(3)}bucket.mjs`,source:dir+'bucket.mjs',token:'cookie',requests:[{cookie:'bucket=a'}]});
  cases.push({name:`${dir.slice(3)}locale.mjs`,source:dir+'locale.mjs',token:'accept-language',requests:[{'accept-language':'en'},{}]});
}

for(const {name,source,token,requests} of cases){
  const run=await load(source);
  test(`${name} keeps another downstream Vary token and adds ${token}`,async()=>{
    for(const headers of requests){
      const response=await call(run,headers,()=>new Response('x',{headers:{Vary:'Accept-Encoding'}}));
      assert.equal(response.headers.get('vary'),`Accept-Encoding, ${token}`,JSON.stringify(headers));
      assert.equal(await response.text(),'x');
    }
  });
  test(`${name} leaves a downstream Vary: * as *`,async()=>{
    for(const headers of requests){
      assert.equal((await call(run,headers,()=>new Response('x',{headers:{Vary:'*'}}))).headers.get('vary'),'*');
      assert.equal((await call(run,headers,()=>new Response('x',{headers:{Vary:'Accept-Encoding, *'}}))).headers.get('vary'),'*');
    }
  });
  test(`${name} does not duplicate a ${token} the downstream already varies on, in any case`,async()=>{
    for(const headers of requests){
      assert.equal((await call(run,headers,()=>new Response('x',{headers:{Vary:token}}))).headers.get('vary'),token);
      const mixed=`Accept-Encoding, ${token.toUpperCase()}, X-Other`;
      assert.equal((await call(run,headers,()=>new Response('x',{headers:{Vary:mixed}}))).headers.get('vary'),mixed);
    }
  });
  test(`${name} sets Vary: ${token} when the downstream has none`,async()=>{
    for(const headers of requests)assert.equal((await call(run,headers,()=>new Response('x'))).headers.get('vary'),token);
  });
  test(`${name} copies a downstream response whose headers are immutable`,async()=>{
    for(const headers of requests){
      const response=await call(run,headers,()=>Response.redirect('https://example.com/next',302));
      assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://example.com/next');
      assert.equal(response.headers.get('vary'),token);
    }
  });
}

for(const dir of ['../recipes/cors-api/middleware/','../examples/cookbook/middleware/','../recipes/middleware/middleware/']){
  const run=await load(dir+'cors.mjs'),token=dir.includes('cors-api')?'Origin':'origin';
  test(`${dir.slice(3)}cors.mjs allow-origin and preflight around a downstream Vary`,async()=>{
    for(const origin of [allowed,disallowed]){
      const response=await call(run,{origin},()=>new Response('x',{headers:{Vary:'Accept-Language'}}));
      assert.equal(response.headers.get('vary'),`Accept-Language, ${token}`);
      assert.equal(response.headers.get('access-control-allow-origin'),origin===allowed?allowed:null);
      const preflight=await call(run,{origin},()=>{throw new Error('preflight must not reach the handler');},'OPTIONS');
      assert.equal(preflight.status,204);assert.equal(preflight.headers.get('vary'),token);
    }
    const copied=await call(run,{origin:allowed},()=>Response.redirect('https://example.com/next',302));
    assert.equal(copied.headers.get('access-control-allow-origin'),allowed);
  });
}

for(const dir of ['../examples/cookbook/middleware/','../recipes/middleware/middleware/']){
  test(`${dir.slice(3)}negotiate.mjs keeps the merged Vary when it converts JSON to text`,async()=>{
    const run=await load(dir+'negotiate.mjs');
    const response=await call(run,{accept:'text/plain'},()=>Response.json({a:1},{headers:{Vary:'Accept-Language'}}));
    assert.equal(response.headers.get('vary'),'Accept-Language, accept');assert.equal(await response.text(),'a: 1\n');
  });
  test(`${dir.slice(3)}bucket.mjs sets a fresh bucket cookie on a copied immutable response`,async t=>{
    const run=await load(dir+'bucket.mjs');t.mock.method(Math,'random',()=>0.1);
    const response=await call(run,{},()=>Response.redirect('https://example.com/next',302));
    assert.equal(response.headers.get('vary'),'cookie');assert.match(response.headers.get('set-cookie')!,/^bucket=a;/);
    const kept=await call(run,{},()=>new Response('x',{headers:{Vary:'Accept'}}));
    assert.equal(kept.headers.get('vary'),'Accept, cookie');assert.match(kept.headers.get('set-cookie')!,/^bucket=a;/);
  });
  test(`${dir.slice(3)}bucket.mjs and locale.mjs redirect branches still vary`,async()=>{
    const b=await call(await load(dir+'bucket.mjs'),{cookie:'bucket=b'},()=>{throw new Error('must not reach downstream');});
    assert.equal(b.status,302);assert.equal(b.headers.get('vary'),'cookie');
    const l=await call(await load(dir+'locale.mjs'),{'accept-language':'de'},()=>{throw new Error('must not reach downstream');});
    assert.equal(l.status,302);assert.equal(l.headers.get('vary'),'accept-language');
  });
}
