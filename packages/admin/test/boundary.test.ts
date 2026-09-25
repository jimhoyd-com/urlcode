// Admin holds none of auth's secrets: it imports auth and audit as types only, and its source (and the built dist)
// names no session cookie, CSRF key, raw actor token, auth HTTP helper, auth mount or freshness literal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const forbidden = ['__Host-urlcode', 'csrfKey', 'actorToken', 'AuthHttp', 'authMount', "'/account'", '300000', '300_000', '5 * 60', '5*60'];
function files(directory: string, extension: RegExp): [string, string][] {
    return readdirSync(join(root, directory), { recursive: true }).map(String).filter(name => extension.test(name)).map(name => [join(directory, name), readFileSync(join(root, directory, name), 'utf8')]);
}

test('admin/src imports auth and audit as types only and names none of auth\'s secrets', () => {
    const sources = files('src', /\.ts$/);
    assert.ok(sources.length > 10);
    for (const [name, source] of sources) {
        for (const match of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'(@jimhoyd\/urlcode-(?:auth|audit)[^']*)';/gms))
            assert.ok(match[1], `${name} imports a value from ${match[2]}`);
        assert.doesNotMatch(source, /import\(\s*['"]@jimhoyd\/urlcode-(?:auth|audit)/, `${name} imports auth or audit dynamically`);
        for (const word of forbidden) assert.ok(!source.includes(word), `${name} names ${word}`);
    }
});

test('the built dist keeps the same boundary', { skip: !existsSync(join(root, 'dist')) && 'dist is not built' }, () => {
    const built = files('dist', /\.js$/);
    assert.ok(built.length > 10);
    for (const [name, source] of built) {
        assert.doesNotMatch(source, /from\s+['"]@jimhoyd\/urlcode-(?:auth|audit)/, `${name} loads auth or audit at runtime`);
        assert.doesNotMatch(source, /import\(\s*['"]@jimhoyd\/urlcode-(?:auth|audit)/, `${name} loads auth or audit at runtime`);
        for (const word of forbidden) assert.ok(!source.includes(word), `${name} names ${word}`);
    }
});
