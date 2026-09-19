import test from 'node:test';
import assert from 'node:assert/strict';
import { addTurnstileWidgets } from '../src/challenge-ui.ts';
import { pageResponse } from '../src/auth-ui.ts';
test('typed challenge widget only augments trusted POST forms and enables a fixed CSP origin',()=>{
    const markup='<form method="post" action="/account/login"><input name="csrf" value="proof"></form><form method="get" action="/search"></form>';
    const plain=pageResponse('Sign in',markup);
    assert.ok(!Buffer.from(plain.body!).toString().includes('cloudflare'));
    const result=pageResponse('Sign in',markup,200,[],'/account/assets/passkeys.js',undefined,{siteKey:'0x_TEST_SITE_KEY',action:'auth'});
    const html=Buffer.from(result.body!).toString(),csp=result.headers.find(([name])=>name==='content-security-policy')![1];
    assert.equal((html.match(/class="cf-turnstile"/g)||[]).length,1);
    assert.ok(html.includes('data-response-field-name="challengeToken"'));
    assert.ok(html.includes('https://challenges.cloudflare.com/turnstile/v0/api.js'));
    assert.match(csp,/frame-src https:\/\/challenges.cloudflare.com/);
    assert.match(csp,/script-src 'nonce-[^']+' https:\/\/challenges.cloudflare.com/);
    assert.ok(!csp.includes('script-src \'unsafe-inline\''));
    assert.ok(html.includes('/account/assets/passkeys.js'));
    assert.equal(addTurnstileWidgets('<p>No form</p>',{siteKey:'test',action:'auth'}).enabled,false);
});
test('challenge widget refuses script injection, arbitrary origins/actions and unbounded forms',()=>{
    for(const widget of [{siteKey:'"><script>',action:'auth'},{siteKey:'valid',action:'other'},{siteKey:'valid',action:'auth',script:'https://evil.test'}])assert.throws(()=>addTurnstileWidgets('<form method="post"></form>',widget as never));
    assert.throws(()=>addTurnstileWidgets('<form method="post"></form>'.repeat(17),{siteKey:'test',action:'auth'}));
});
