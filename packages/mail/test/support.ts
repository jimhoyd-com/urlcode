// Shared test helpers: a synthetic contribution covering every slot kind, and direct activation.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { ExtensionActivation, ExtensionInstance } from '@jimhoyd/urlcode/extensions';
import { createMail } from '../src/index.ts';
import type { MailContribution, MailOptions } from '../src/index.ts';

export const sha = 'a'.repeat(64);
export const origin = 'https://mail.example.test';

export const demo: MailContribution = {
  namespace: 'demo',
  templates: {
    notice: { subject: 'Account notice', text: 'Something changed.\n\nReview it at {link}.', slots: { link: 'page-link' } },
    token: { subject: 'Confirm', text: 'Confirm by opening:\n\n{link}', slots: { link: 'token-link' } },
    code: { subject: 'Your code', text: 'Your code is {code}. Enter it at {link}', slots: { code: 'code', link: 'page-link' } },
    note: { subject: 'A note', text: 'Note:\n{body}', slots: { body: 'text' } },
    plain: { subject: 'Plain', text: 'Nothing to fill in.', slots: {} },
  },
};

export async function tempSite(t: TestContext): Promise<{ site: string; project: string }> {
  const site = await mkdtemp(join(tmpdir(), 'urlcode-mail-'));
  t.after(() => rm(site, { recursive: true, force: true }));
  const project = join(site, 'app');
  await mkdir(project, { mode: 0o700 });
  return { site, project };
}

export function activation(project: string, overrides: Partial<ExtensionActivation> = {}): ExtensionActivation {
  return { origin, target: 'node', projectSha256: sha, mounts: [], root: project, ...overrides };
}

type Setup = Partial<Omit<MailOptions, 'projectSha256' | 'site'>> & { config?: Record<string, unknown>; context?: Partial<ExtensionActivation> };

/** createMail over a temporary site, activated (unless `activate: false`), closed after the test. */
export async function activated(t: TestContext, setup: Setup = {}, activate = true): Promise<ReturnType<typeof createMail> & { site: string; project: string; instance: ExtensionInstance | undefined }> {
  const { site, project } = await tempSite(t);
  const { config, context, ...options } = setup;
  const mail = createMail({ contributions: [demo], ...options, projectSha256: sha, site });
  t.after(() => mail.close());
  const instance = activate ? await mail.registration.activate(config ?? {}, activation(project, context)) : undefined;
  return { ...mail, site, project, instance };
}

/** Rejects with a MailError of `code`; returns it. */
export async function refusal(promise: Promise<unknown>, code: string): Promise<Error & { code: string; status: number }> {
  try { await promise; }
  catch (error) {
    const mailError = error as Error & { code: string; status: number };
    if (mailError?.name !== 'MailError' || mailError.code !== code) throw new Error(`expected MailError ${code}, got ${String(mailError?.name)} ${String(mailError?.code)}: ${String(mailError?.message)}`, { cause: error });
    return mailError;
  }
  throw new Error(`expected MailError ${code}, but it resolved`);
}
