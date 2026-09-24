// A stand-in for npm used by the add-on tests (URLCODE_NPM). `install` links every `file:` dependency of the site's
// package.json into node_modules/ and writes the package-lock.json entries npm writes for linked directories. It
// appends each invocation to $FAKE_NPM_LOG so tests can assert what ran. `view` answers from $FAKE_NPM_VIEW (JSON).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2), cwd = process.cwd();
if (process.env.FAKE_NPM_LOG) appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\n');
if (process.env.FAKE_NPM_FAIL && args.includes(process.env.FAKE_NPM_FAIL)) { process.stderr.write('fake npm failure\n'); process.exit(1); }
if (args[0] === 'view') { process.stdout.write(JSON.stringify(JSON.parse(process.env.FAKE_NPM_VIEW ?? 'null'))); process.exit(0); }
if (args[0] !== 'install') process.exit(0);
const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
const scope = join(cwd, 'node_modules', '@jimhoyd');
mkdirSync(scope, { recursive: true });
for (const name of readdirSync(scope)) if (!pkg.dependencies?.[`@jimhoyd/${name}`]?.startsWith('file:')) rmSync(join(scope, name), { recursive: true, force: true });
const packages = { '': { name: pkg.name, dependencies: pkg.dependencies } };
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (!spec.startsWith('file:')) continue;
  const source = spec.slice(5), target = join(cwd, 'node_modules', name);
  if (!existsSync(target)) symlinkSync(source, target, 'dir');
  packages[`node_modules/${name}`] = { version: JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version, resolved: source, link: true };
}
writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ name: pkg.name, lockfileVersion: 3, packages }, null, 2) + '\n');
