import test from 'node:test';
import assert from 'node:assert/strict';
import { Markup } from '@jimhoyd/urlcode-ui';
import { addTurnstileWidgets } from '../src/challenge-ui.ts';
import { screenResponse } from '../src/auth-ui.ts';
import { activatedUi } from './support/render.ts';
import type { TestContext } from 'node:test';
import type { TurnstileWidget } from '../src/challenge-ui.ts';
const screen = (markup: string) => ({ name: 'auth/forgot-password', view: { intro: '', form: new Markup(markup) } });
const decode = (response: { body: Uint8Array }) => Buffer.from(response.body).toString();
async function render(t: TestContext, markup: string, turnstile?: TurnstileWidget, scriptPath?: string) {
    const ui = await activatedUi(t, import.meta.dirname, 'a'.repeat(64));
    return screenResponse('Forgot password', screen(markup), { ui, ...(turnstile ? { turnstile } : {}), ...(scriptPath ? { scriptPath } : {}) });
}
test('typed challenge widget only augments trusted POST forms and enables a fixed CSP origin',async t=>{
    const markup='<form method="post" action="/account/login"><input name="csrf" value="proof"></form><form method="get" action="/search"></form>';
    assert.ok(!decode(await render(t,markup)).includes('cloudflare'));
    const result=await render(t,markup,{siteKey:'0x_TEST_SITE_KEY',action:'auth'},'/account/assets/passkeys.js');
    const html=decode(result),csp=result.headers.find(([name])=>name==='content-security-policy')![1]!;
    assert.equal((html.match(/class="cf-turnstile"/g)||[]).length,1);
    assert.ok(html.includes('data-response-field-name="challengeToken"'));
    assert.ok(html.includes('https://challenges.cloudflare.com/turnstile/v0/api.js'));
    assert.match(csp,/frame-src[^;]*https:\/\/challenges\.cloudflare\.com/);
    // Both the auth scripts and the challenge script carry the kit's single page nonce, and the CSP admits only it plus the challenge origin.
    const nonce=/<style nonce="([A-Za-z0-9+/=]+)">/.exec(html)![1]!;
    assert.match(csp,new RegExp(`script-src[^;]*'nonce-${nonce.replace(/[+/=]/g,c=>'\\'+c)}'`));
    assert.match(csp,/script-src[^;]*https:\/\/challenges\.cloudflare\.com/);
    assert.ok(!csp.includes("script-src 'unsafe-inline'"));
    assert.deepEqual([...html.matchAll(/<script nonce="([^"]+)" src="([^"]+)"/g)].map(match=>[match[1],match[2]]),[[nonce,'/account/assets/passkeys.js'],[nonce,'https://challenges.cloudflare.com/turnstile/v0/api.js']]);
    assert.equal(result.headers.find(([name])=>name==='cache-control')?.[1],'no-store');
    assert.equal(addTurnstileWidgets('<p>No form</p>',{siteKey:'test',action:'auth'}).enabled,false);
});
test('challenge widget refuses script injection, arbitrary origins/actions and unbounded forms',()=>{
    for(const widget of [{siteKey:'"><script>',action:'auth'},{siteKey:'valid',action:'other'},{siteKey:'valid',action:'auth',script:'https://evil.test'}])assert.throws(()=>addTurnstileWidgets('<form method="post"></form>',widget as never));
    assert.throws(()=>addTurnstileWidgets('<form method="post"></form>'.repeat(17),{siteKey:'test',action:'auth'}));
});
