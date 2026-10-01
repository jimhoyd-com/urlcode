import test from 'node:test';
import assert from 'node:assert/strict';
// The two standalone CORS middleware modules (and the recipe copy generated from the cookbook) run in composition with a
// downstream response that already varies (#1120): Origin is merged into its Vary, never replacing it.
type Middleware=(request:Request,context:{env:Record<string,string>},next:()=>Promise<Response>)=>Promise<Response>;
const load=async(path:string)=>(await import(new URL(path,import.meta.url).href) as {default:Middleware}).default;
const modules=[
  {name:'recipes/cors-api',run:await load('../recipes/cors-api/middleware/cors.mjs'),token:'Origin'},
  {name:'examples/cookbook',run:await load('../examples/cookbook/middleware/cors.mjs'),token:'origin'},
  {name:'recipes/middleware',run:await load('../recipes/middleware/middleware/cors.mjs'),token:'origin'}
];
const context={env:{ALLOWED_ORIGINS:'https://app.example.com'}};
const allowed='https://app.example.com',disallowed='https://evil.example.net';
const call=(run:Middleware,origin:string|null,downstream:()=>Response,method='GET')=>
  run(new Request('https://api.example.com/data',{method,headers:origin===null?{}:{origin}}),context,async()=>downstream());

for(const {name,run,token} of modules){
  test(`${name} cors keeps a downstream Vary and adds Origin for allowed and disallowed origins`,async()=>{
    for(const origin of [allowed,disallowed,null]){
      const response=await call(run,origin,()=>new Response('x',{headers:{Vary:'Accept-Language'}}));
      assert.equal(response.headers.get('vary'),`Accept-Language, ${token}`,`origin ${origin}`);
      assert.equal(response.headers.get('access-control-allow-origin'),origin===allowed?allowed:null);
      assert.equal(await response.text(),'x');
    }
  });
  test(`${name} cors leaves a downstream Vary: * as *`,async()=>{
    for(const origin of [allowed,disallowed])
      assert.equal((await call(run,origin,()=>new Response('x',{headers:{Vary:'*'}}))).headers.get('vary'),'*');
    assert.equal((await call(run,allowed,()=>new Response('x',{headers:{Vary:'Accept, *'}}))).headers.get('vary'),'*');
  });
  test(`${name} cors does not duplicate an Origin the downstream already varies on, in any case`,async()=>{
    for(const origin of [allowed,disallowed]){
      assert.equal((await call(run,origin,()=>new Response('x',{headers:{Vary:'origin'}}))).headers.get('vary'),'origin');
      assert.equal((await call(run,origin,()=>new Response('x',{headers:{Vary:'Accept, ORIGIN, Cookie'}}))).headers.get('vary'),'Accept, ORIGIN, Cookie');
    }
  });
  test(`${name} cors sets Vary: Origin when the downstream has none, and on preflight`,async()=>{
    for(const origin of [allowed,disallowed])assert.equal((await call(run,origin,()=>new Response('x'))).headers.get('vary'),token);
    for(const origin of [allowed,disallowed]){
      const preflight=await call(run,origin,()=>{throw new Error('preflight must not reach the handler');},'OPTIONS');
      assert.equal(preflight.status,204);assert.equal(preflight.headers.get('vary'),token);
    }
  });
  test(`${name} cors copies a downstream response whose headers are immutable`,async()=>{
    const response=await call(run,allowed,()=>{const r=Response.redirect('https://app.example.com/next',302);return r;});
    assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://app.example.com/next');
    assert.equal(response.headers.get('vary'),token);assert.equal(response.headers.get('access-control-allow-origin'),allowed);
  });
}
