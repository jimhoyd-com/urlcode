// Shared fixtures: a temporary private directory, synthetic events, an activated audit and a fake in-memory
// producer outbox (the producer contract without auth or store).
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionActivation, ExtensionInstance } from '@jimhoyd/urlcode/extensions';
import { createAudit } from '../src/index.ts';
import type { Audit, AuditEvent, AuditOptions, AuditProducer } from '../src/index.ts';

export const pin = 'a'.repeat(64);

export async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'urlcode-audit-'));
  // Windows can hold the sqlite file's WAL/SHM handles open briefly after close(); retry like test/addons.integration.ts.
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

export function event(overrides: Partial<Record<keyof AuditEvent, unknown>> = {}): AuditEvent {
  return { id: randomUUID(), source: 'fake', action: 'thing.done', actor: 'user-1', subject: 'subject-1', at: Date.now(), ...overrides } as AuditEvent;
}

export function activation(root: string, mounts: readonly string[] = []): ExtensionActivation {
  return { origin: 'https://audit.example.test', target: 'node', projectSha256: pin, mounts, root };
}

export async function openAudit(t: TestContext, options: Partial<AuditOptions> = {}): Promise<{ audit: Audit; dir: string; database: string }> {
  const dir = await tempDir(t), database = options.database ?? join(dir, 'audit.sqlite');
  const audit = await createAudit({ projectSha256: pin, database, ...options });
  t.after(() => audit.close());
  return { audit, dir, database };
}

export async function activeAudit(t: TestContext, options: Partial<AuditOptions> = {}, config: Record<string, unknown> = {}): Promise<{ audit: Audit; instance: ExtensionInstance; dir: string; database: string }> {
  const opened = await openAudit(t, options);
  const instance = await opened.audit.registration.activate(config, activation(opened.dir));
  t.after(() => instance.close?.());
  return { ...opened, instance };
}

export interface FakeProducer extends AuditProducer { outbox: AuditEvent[]; peeks: number; acks: string[][] }
/** An in-memory outbox: peek returns the oldest events, ack removes them. Overrides replace either method. */
export function fakeProducer(source = 'fake', overrides: Partial<Pick<AuditProducer, 'peek' | 'ack'>> = {}): FakeProducer {
  const producer: FakeProducer = {
    source, outbox: [], peeks: 0, acks: [],
    async peek(limit) { producer.peeks++; return producer.outbox.slice(0, limit); },
    async ack(ids) { producer.acks.push([...ids]); const gone = new Set(ids); producer.outbox = producer.outbox.filter(item => !gone.has(item.id)); },
    ...overrides,
  };
  return producer;
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
