import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createAuthService, sessionReference } from '../src/auth-core.ts';
import { authExtension } from '../src/auth.ts';
import { createPresentation } from '../src/presentation.ts';
import { createRegistrationPolicy } from '../src/registration.ts';
import { activatedUi } from './support/render.ts';
test('OIDC carries request locale through enrollment and MFA with escaped catalogue values', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-localized-flows-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member', registrationPolicy: createRegistrationPolicy({ termsVersion: '<version>', metadata: { team: { type: 'string', scope: 'public', required: true } } }) });
    cleanup(t, () => service.close());
    let forceMfa = false;
    const flowService = new Proxy(service, { get(target, key) { if (key === 'getExternalProof')
            return async (provider: string, subject: string) => { const found = await target.getExternalProof(provider, subject); return found && forceMfa ? { ...found, user: { ...found.user, totpEnabled: true } } : found; }; return Reflect.get(target, key); } });
    const issuer = 'https://issuer.example', provider = { async start() { const state = randomBytes(32).toString('base64url'); return { url: issuer + '/authorize?state=' + state, flow: { state, nonce: state, verifier: state } }; }, async complete() { return { issuer, subject: 'subject', email: 'reader@example.test', emailVerified: true }; } };
    const presentation = createPresentation({ catalogues: { fr: { 'page.completeYourAccount': 'Terminer <img src=x>', 'field.displayName': 'Nom affiché', 'field.locale': 'Langue préférée', 'message.acceptTerms': 'J’accepte {version} <b>conditions</b>', 'action.register': 'Créer le compte', 'provider.signIn': 'Continuer avec {provider}', 'page.secondFactor': 'Deuxième facteur', 'field.totp': 'Code authentificateur', 'action.completeSignIn': 'Terminer la connexion' } } });
    const origin = 'https://example.test', projectSha256 = 'a'.repeat(64), ui = await activatedUi(t, import.meta.dirname, projectSha256, origin), instance = await authExtension({ service: flowService, csrfKey: randomBytes(32), projectSha256, ui, presentation, providers: { demo: provider } }).activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname }), cookies = new Map<string, string>();
    async function call(target: string, data?: Record<string, string>) { const url = new URL(target, origin), response = await instance.handle({ method: data ? 'POST' : 'GET', target, path: url.pathname, query: url.searchParams, headers: new Headers({ cookie: [...cookies].map(([name, value]) => name + '=' + value).join('; '), origin, accept: 'text/html', 'accept-language': 'en', ...(data ? { 'content-type': 'application/json' } : {}) }), headerCounts: { cookie: 1, origin: 1 }, body: Buffer.from(data ? JSON.stringify(data) : ''), origin, route: '/account/*', mount: '/account', client: null }); for (const [name, value] of response.headers)
        if (name === 'set-cookie') {
            const [key, content] = value.split(';')[0]!.split('=');
            if (value.includes('Max-Age=0'))
                cookies.delete(key!);
            else
                cookies.set(key!, content!);
        } return response; }
    const initial = await call('/account/login?lang=fr');
    const initialHtml = Buffer.from(initial.body ?? '').toString();
    assert.match(initialHtml, /Continuer avec demo/);
    assert.match(initialHtml, /class="ui-field-separator"/);
    assert.match(initialHtml, /providers\/demo\/start\?lang=fr/);
    async function callback() { const csrf = JSON.parse(Buffer.from((await call('/account/csrf')).body ?? '').toString()).csrf as string; const start = await call('/account/providers/demo/start?lang=fr', { csrf }); const state = new URL(start.headers.find(([name]) => name === 'location')![1]).searchParams.get('state'); return Buffer.from((await call('/account/providers/demo/callback?state=' + state)).body ?? '').toString(); }
    const enrollment = await callback();
    assert.match(enrollment, /lang="fr"/);
    assert.match(enrollment, /Nom affiché/);
    assert.match(enrollment, /Langue préférée/);
    assert.match(enrollment, /J’accepte &lt;version&gt; &lt;b&gt;conditions&lt;\/b&gt;/);
    assert.match(enrollment, /Créer le compte/);
    assert.doesNotMatch(enrollment, /<img src=x>|<b>conditions/);
    const member = await service.register({ email: 'reader@example.test', password: 'correct horse battery staple', profile: { termsAccepted: true, metadata: { team: 'support' } } });
    await service.linkExternal({ sessionReference: sessionReference(member.token),  provider: 'oidc-' + createHash('sha256').update(issuer).digest('hex').slice(0, 56), subject: 'subject' });
    forceMfa = true;
    const mfa = await callback();
    assert.match(mfa, /lang="fr"/);
    assert.match(mfa, /Deuxième facteur/);
    assert.match(mfa, /Code authentificateur/);
    assert.match(mfa, /Terminer la connexion/);
    const independent = Buffer.from((await call('/account/login?lang=en')).body ?? '').toString();
    assert.match(independent, /lang="en"/);
    assert.doesNotMatch(independent, /Continuer avec demo/);
});
