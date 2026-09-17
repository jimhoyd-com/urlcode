import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistrationPolicy, isHoneypotFilled } from '../src/registration.ts';
import type { RegistrationInput, MetadataField } from '../src/registration.ts';
test('registration enforces versioned terms and stores an explicit acceptance timestamp', () => {
    const policy = createRegistrationPolicy({ termsVersion: '2026-09' });
    assert.throws(() => policy.validate({}, { now: 100 }), /acceptance/);
    const profile = policy.validate({ termsAccepted: true, displayName: 'Example', locale: 'en-us' }, { now: 100 });
    assert.deepEqual(profile.terms, { version: '2026-09', acceptedAt: 100 });
    assert.equal(profile.locale, 'en-US');
    assert.deepEqual(policy.validate({ displayName: 'Changed' }, { now: 200, existing: profile }).terms, profile.terms);
    assert.throws(() => createRegistrationPolicy({ termsVersion: '2027-01' }).validate({}, { now: 200, existing: profile }), /acceptance/);
});
test('typed metadata preserves private server values and excludes them from public views', () => {
    const policy = createRegistrationPolicy({ metadata: { nickname: { type: 'string', scope: 'public', maxLength: 10, required: true }, review: { type: 'string', scope: 'private', default: 'pending' }, age: { type: 'number', scope: 'unsafe', minimum: 18, maximum: 120 }, consent: { type: 'boolean', scope: 'public', default: false } } });
    const profile = policy.validate({ metadata: { nickname: 'hello', age: 20 } }, { now: 0 });
    assert.equal(profile.metadata.review, 'pending');
    assert.equal(profile.metadata.consent, false);
    assert.throws(() => policy.validate({ metadata: { review: 'approved' } }, { now: 0, existing: profile }), /operator/);
    const approved = policy.validate({ metadata: { review: 'approved' } }, { now: 0, existing: profile, operator: true });
    const edited = policy.validate({ metadata: { nickname: 'new' } }, { now: 0, existing: approved });
    assert.equal(edited.metadata.review, 'approved');
    assert.equal(policy.publicProfile(edited).metadata.review, undefined);
    assert.equal(policy.publicProfile(edited).metadata.age, 20);
    assert.equal(policy.publicSchema().metadata?.review, undefined);
    const schema = policy.publicSchema();
    schema.metadata!.nickname!.maxLength = 999;
    assert.equal(policy.publicSchema().metadata?.nickname?.maxLength, 10);
    for (const metadata of [{ age: 17 }, { age: NaN }, { consent: 'yes' }, { unknown: 'x' }, { nickname: 'x'.repeat(11) }])
        assert.throws(() => policy.validate({ metadata } as RegistrationInput, { now: 0, existing: profile }));
});
test('reserved security fields, malformed schemas and invalid defaults fail closed', () => {
    for (const name of ['roles', 'session_id', 'emailVerified', 'passwordHash', 'constructor'])
        assert.throws(() => createRegistrationPolicy({ metadata: { [name]: { type: 'string', scope: 'public' } } }), /Reserved/);
    assert.throws(() => createRegistrationPolicy({ metadata: { favorite: { type: 'string', scope: 'public', enum: ['a'], default: 'b' } } }), /default/);
    assert.throws(() => createRegistrationPolicy({ metadata: { favorite: { type: 'string', scope: 'public', extra: true } as unknown as MetadataField } }), /schema/);
    assert.throws(() => createRegistrationPolicy({ metadata: { favorite: { type: 'number', scope: 'unsafe', minimum: 5, maximum: 1 } } }), /bounds/);
    assert.throws(() => createRegistrationPolicy().validate({ roles: ['admin'] } as unknown as RegistrationInput, { now: 0 }), /Unknown/);
});
test('profiles enforce display name, configured locale, size and immutable schema snapshots', () => {
    const fields = { favorite: { type: 'string', scope: 'public', enum: ['a', 'b'] } } as Record<string, MetadataField>;
    const policy = createRegistrationPolicy({ metadata: fields, locales: ['en', 'fr'] });
    fields.favorite!.enum!.push('c');
    assert.throws(() => policy.validate({ metadata: { favorite: 'c' } }, { now: 1 }));
    assert.throws(() => policy.validate({ locale: 'de' }, { now: 1 }), /not enabled/);
    assert.throws(() => policy.validate({ displayName: 'x'.repeat(101) }, { now: 1 }), /display/);
    assert.throws(() => policy.validate({ displayName: 'x\ny' }, { now: 1 }), /display/);
    const big = createRegistrationPolicy({ metadata: Object.fromEntries(Array.from({ length: 8 }, (_, n) => ['field' + n, { type: 'string', scope: 'public', maxLength: 4096 }])) });
    assert.throws(() => big.validate({ metadata: Object.fromEntries(Array.from({ length: 8 }, (_, n) => ['field' + n, 'x'.repeat(4096)])) }, { now: 1 }), /total bound/);
});
test('honeypot distinguishes absent/blank values from supplied bot fields without granting an account', () => {
    assert.equal(isHoneypotFilled(undefined), false);
    assert.equal(isHoneypotFilled(''), false);
    assert.equal(isHoneypotFilled('bot'), true);
    assert.equal(isHoneypotFilled(null), true);
    assert.equal(isHoneypotFilled({}), true);
});
