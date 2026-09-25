import type { TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAbuse } from '../src/index.ts';
import type { AbuseChallengeProvider } from '../src/index.ts';

export const pin = 'a'.repeat(64);
/** A created abuse instance on a private temporary database with a controllable clock; activated unless told not to. */
export async function setup(t: TestContext, options: { maxKeys?: number; challenge?: AbuseChallengeProvider; activate?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'abuse-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = 1_800_000_000_000;
  const database = join(dir, 'abuse.sqlite');
  const abuse = await createAbuse({ projectSha256: pin, database, key: randomBytes(32), now: () => clock, ...(options.challenge ? { challenge: options.challenge } : {}) });
  t.after(() => abuse.close());
  if (options.activate !== false) await abuse.registration.activate(options.maxKeys !== undefined ? { maxKeys: options.maxKeys } : {}, { origin: 'https://abuse.example.test', target: 'node', projectSha256: pin, mounts: [], root: dir });
  return { abuse, dir, database, now: () => clock, tick: (ms: number) => { clock += ms; } };
}
export const rejectsWith = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
