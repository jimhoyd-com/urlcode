// Trusted operator code: the account list this proof's Auth.js Credentials provider checks passwords against.
// Auth.js does not store users or passwords for the Credentials provider; `authorize()` is the application's own
// lookup. This is the smallest honest version of that: one private JSON file of scrypt hashes written by
// scripts/setup.mjs, read on every sign-in. It is not an account system (no sign-up, reset, lockout or rotation).
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const keyLength = 64;
// A fixed hash to compare against when the email is unknown, so both outcomes cost one scrypt.
const decoy = { salt: 'decoy-salt', hash: Buffer.alloc(keyLength).toString('base64url') };

async function readUsers(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
}

/** Adds each account that is not already present (by email) and returns every account's stable id by email. */
export async function ensureUsers(file, accounts) {
  const users = await readUsers(file);
  for (const account of accounts) {
    if (users.some(user => user.email === account.email)) continue;
    const salt = randomBytes(16).toString('base64url');
    const hash = (await derive(account.password, salt, keyLength)).toString('base64url');
    users.push({ id: randomUUID(), email: account.email, name: account.name, salt, hash });
  }
  await writeFile(`${file}.tmp`, JSON.stringify(users, null, 2) + '\n', { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  return Object.fromEntries(users.map(user => [user.email, user.id]));
}

/** The Credentials provider's `authorize()`: the account for a matching email and password, else null. */
export async function verifyPassword(file, email, password) {
  if (typeof email !== 'string' || typeof password !== 'string' || password.length > 1024) return null;
  const user = (await readUsers(file)).find(entry => entry.email === email.trim().toLowerCase());
  const { salt, hash } = user ?? decoy;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await derive(password, salt, keyLength);
  return timingSafeEqual(actual, expected) && user ? { id: user.id, email: user.email, name: user.name } : null;
}
