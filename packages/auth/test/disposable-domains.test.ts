import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { disposableDomainData } from '../src/disposable-domain-data.ts';
import { isDisposableEmailDomain, disposableDomainsRevision } from '../src/disposable-domains.ts';
test('bundled domain data has reviewed provenance and exact suffix boundaries', () => {
    assert.equal(disposableDomainData.length, 8883);
    assert.equal(new Set(disposableDomainData).size, disposableDomainData.length);
    assert.equal(createHash('sha256').update(disposableDomainData.join('\n')+'\n').digest('hex'), '87bf71873ced728237615c546eff8fa36962dfa261d366e13ef9e0bad3224aad');
    assert.match(disposableDomainsRevision, /^[a-f0-9]{40}$/);
    assert.equal(isDisposableEmailDomain('MAILINATOR.COM'), true);
    assert.equal(isDisposableEmailDomain('nested.mailinator.com'), true);
    assert.equal(isDisposableEmailDomain('urlcode-boundary-check-mailinator.com'), false);
    assert.equal(isDisposableEmailDomain('mailinator.com.example.test'), false);
    assert.equal(isDisposableEmailDomain('example.test'), false);
    assert.equal(isDisposableEmailDomain('bücher.example'), false);
    for (const value of ['mailinator.com.', 'https://mailinator.com', 'bad@domain.test', 'a..test', 'a test']) assert.throws(() => isDisposableEmailDomain(value));
});
