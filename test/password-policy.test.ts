import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPasswordBreachChecker } from '../src/password-policy.ts';
const password = 'synthetic long password phrase', digest = createHash('sha1').update(password).digest('hex').toUpperCase();
test('breach lookup sends only five hash characters, requests padding and rejects observed passwords', async () => {
    let count = 1;
    const check = createPasswordBreachChecker({ fetch: async (input, init) => { assert.equal(String(input), 'https://api.pwnedpasswords.com/range/' + digest.slice(0, 5)); assert.equal(init?.body, undefined); assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).get('add-padding'), 'true'); return new Response(digest.slice(5) + ':' + count + '\r\n' + 'A'.repeat(35) + ':0\r\n'); } });
    await assert.rejects(check(password), { code: 'password_compromised' });
    count = 0;
    await check(password);
});
test('breach transport fails closed with bounded bodies, errors and deadlines', async () => {
    for (const response of [new Response('', { status: 503 }), new Response('invalid'), new Response('A'.repeat(1048577))])
        await assert.rejects(createPasswordBreachChecker({ fetch: async () => response })(password), { code: 'password_check_unavailable' });
    const check = createPasswordBreachChecker({ timeoutMs: 10, fetch: async () => { throw new Error(password); } });
    await assert.rejects(check(password), error => error instanceof Error && !error.message.includes(password));
    const stalled = createPasswordBreachChecker({ timeoutMs: 10, fetch: () => new Promise(() => { }) });
    await Promise.all(Array.from({ length: 4 }, () => assert.rejects(stalled(password), { code: 'password_check_unavailable' })));
    await assert.rejects(stalled(password), { code: 'password_check_unavailable' });
});
