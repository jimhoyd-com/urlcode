import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { authExtension } from '../src/auth.ts';
import { initAuthentication } from '../src/scaffold.ts';
import { activatedUi } from './support/render.ts';
test('auth scaffold separates operator authority and creates independent private keys', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-scaffold-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const output = await initAuthentication(join(root, 'site'));
    assert.ok(relative(output.project, output.hostFile).startsWith('..'));
    assert.ok(relative(output.project, output.operatorFile).startsWith('..'));
    const yaml = await readFile(join(output.project, 'urlcode.yaml'), 'utf8');
    assert.ok(yaml.includes("registration: 'off'"));
    assert.ok(yaml.includes('extension: auth'));
    assert.ok(yaml.includes('auth: true'));
    assert.ok(!yaml.includes('admin'));
    const host = await readFile(output.hostFile, 'utf8');
    assert.ok(host.includes('process.env.PROJECT_SHA256'));
    assert.ok(!host.includes('inspectExtensionRevision'));
    assert.ok(!host.includes('createHash'));
    assert.ok(host.includes("origin.protocol !== 'https:'"));
    const encryption = await readFile(join(output.directory, 'data/encryption.key')), csrf = await readFile(join(output.directory, 'data/csrf.key'));
    assert.equal(encryption.length, 32);
    assert.equal(csrf.length, 32);
    assert.notDeepEqual(encryption, csrf);
    if (process.platform !== 'win32') {
        assert.equal((await stat(join(output.directory, 'data'))).mode & 0o777, 0o700);
        assert.equal((await stat(join(output.directory, 'data/encryption.key'))).mode & 0o777, 0o600);
    }
    const service = await readFile(output.operatorFile, 'utf8');
    assert.ok(service.includes("defaultRole: 'member'"));
    assert.ok(service.includes("roles: {member: [], admin: ['*']}"));
    assert.ok(!service.includes(encryption.toString('hex')));
    await writeFile(output.operatorFile, service.replace("'@jimhoyd/urlcode-auth'", JSON.stringify(new URL('../src/auth-core.ts', import.meta.url).href)));
    const { default: operator } = await import(pathToFileURL(output.operatorFile).href);
    try {
        const ui = await activatedUi(t, import.meta.dirname, 'a'.repeat(64), 'https://scaffold.example');
        await authExtension({ service: operator, csrfKey: csrf, projectSha256: 'a'.repeat(64), ui }).activate({ registration: 'off' }, { origin: 'https://scaffold.example', target: 'node', projectSha256: 'a'.repeat(64), mounts: ['/account'], root: import.meta.dirname });
        assert.equal(operator.getRegistrationMode(), 'off');
    }
    finally {
        await operator.close();
    }
    const readme = await readFile(join(output.directory, 'README.md'), 'utf8');
    assert.ok(readme.includes('paste-reviewed-64-character-sha256'));
    assert.ok(readme.includes('--host-file'));
    assert.ok(!readme.includes('@jimhoyd/urlcode-admin'));
    // The generated site records the versions it was generated against (#212): this package exactly, and each
    // required peer at the version installed beside it. Optional delivery adapters remain opt-in. Nothing is
    // installed by the initializer.
    const own = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
        version: string;
        peerDependencies: Record<string, string>;
        peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    const manifest = JSON.parse(await readFile(join(output.directory, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; private: boolean };
    assert.equal(manifest.private, true);
    assert.equal(manifest.dependencies['@jimhoyd/urlcode-auth'], own.version);
    const requiredPeers = Object.keys(own.peerDependencies).filter((name) => own.peerDependenciesMeta?.[name]?.optional !== true);
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@jimhoyd/urlcode-auth', ...requiredPeers].sort());
    assert.equal(manifest.dependencies['@aws-sdk/client-sesv2'], undefined);
    assert.deepEqual(manifest.dependencies, output.dependencies);
    for (const [name, specifier] of Object.entries(manifest.dependencies))
        if (!output.unpinnedDependencies.includes(name)) assert.match(specifier, /^\d+\.\d+\.\d+/, `${name} must be pinned exactly`);
    assert.ok(readme.includes('run `npm install` here'));
    await assert.rejects(stat(join(output.directory, 'package-lock.json')), { code: 'ENOENT' });
});
test('scaffold never overwrites existing directories, files or symlink destinations', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-scaffold-existing-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const existing = join(root, 'existing');
    await mkdir(existing);
    await writeFile(join(existing, 'keep'), 'original');
    await assert.rejects(initAuthentication(existing), { code: 'EEXIST' });
    assert.equal(await readFile(join(existing, 'keep'), 'utf8'), 'original');
    const file = join(root, 'file');
    await writeFile(file, 'original');
    await assert.rejects(initAuthentication(file), { code: 'EEXIST' });
    assert.equal(await readFile(file, 'utf8'), 'original');
    const alias = join(root, 'alias');
    await symlink(existing, alias);
    await assert.rejects(initAuthentication(alias), { code: 'EEXIST' });
});
