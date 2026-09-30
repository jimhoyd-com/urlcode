import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, asConfigError, assert, hostLoadError } from './errors.ts';
import type { RuntimeOptions } from './runtime.ts';
import { createRunDirectory, removeRunDirectory } from './temp-dirs.ts';
import { extensionContract } from './addon-manifest.ts';

/** Explicitly loaded operator code. Never discovered in application directories. */
export interface OperatorHost {
  extensions?: RuntimeOptions['extensions'];
  plugins?: RuntimeOptions['plugins'];
  close?(): void | Promise<void>;
}
/**
 * Where `composeHost` finds the revision pin the CLI derived from a verified `--policy` (#723). It is a
 * `Symbol.for` key so a host file that imports another copy of core reads the same value; it holds only the
 * policy's `projectSha256`, is set only while `loadOperatorHost` imports the host file, and no project file can set it.
 */
export const operatorRevisionKey = Symbol.for('urlcode.host.operatorRevision');
/**
 * Set (to `true`) only while `loadOperatorHost` imports the host file for a read-only inspection command (explain,
 * plan-feature, context, review, report, studio, extensions, openapi, mcp). Like the revision key it is a
 * `Symbol.for` key a second copy of core reads too, and no project file can set it (#910).
 */
export const inspectionHostKey = Symbol.for('urlcode.host.inspection');
/**
 * Set (to the run's fresh, empty data directory) only while `loadOperatorHost` imports the host file for a hermetic
 * run (RIM-EXT-HERMETIC-001): `composeHost` then gives every extension `data` = that directory and
 * `hermetic: true`. A `Symbol.for` key like the others, so a second copy of core reads it too; no project file sets it.
 */
export const hermeticDataKey = Symbol.for('urlcode.host.hermeticData');
/**
 * Set (to a fresh `WeakSet`) only while `loadOperatorHost` imports the host file for a hermetic run, beside
 * `hermeticDataKey`: a contract-2 `composeHost` adds every registration it composed on that run's directory (#976).
 * The load then refuses unless every registration the host exports is in the set, so a host that spreads or extends a
 * composed host cannot carry a registration `composeHost` never built, and one built by an older copy of core (which
 * knows no set) confirms nothing. A `Symbol.for` key, so a second copy of this core adds to the same set. It checks
 * correctness, not a hostile host file: host.mjs is trusted operator code and could write anywhere itself.
 */
export const hermeticConfirmedKey = Symbol.for('urlcode.host.hermeticConfirmed');
/**
 * The revision an unpinned inspection composes its registrations with: the SHA-256 of a fixed label, never a project's
 * revision, so every activation refuses it (`prepareExtensions` names it before any other check). Reading
 * registrations never needs the pin; activating or serving always does. Every copy of core derives the same value.
 */
export const unpinnedInspectionRevision = createHash('sha256').update('urlcode:unpinned-inspection').digest('hex');
/** Where the reviewed revision comes from, named with a command that prints it; shared by every pin refusal. */
export const revisionPinGuidance = 'pass the reviewed operator policy with --policy (or URLCODE_POLICY), or set PROJECT_SHA256 to the reviewed revision (`urlcode permissions --project app` prints it as projectSha256). Read-only explain, plan-feature, context and review need no pin, and a local validate, test, routes or audit run may pass --local-review to pin the current revision for that run only (serve and dev never accept it)';
/**
 * The pin `composeHost` uses: the verified policy revision when the CLI supplied one, otherwise `PROJECT_SHA256`; both
 * set and different refuses. With neither, an inspection load gets `unpinnedInspectionRevision`.
 */
export function hostRevisionPin(): string {
  const slot = globalThis as Record<symbol, unknown>;
  const fromPolicy = slot[operatorRevisionKey];
  const fromEnv = process.env.PROJECT_SHA256;
  if (typeof fromPolicy !== 'string') return fromEnv === undefined || fromEnv === '' ? slot[inspectionHostKey] === true ? unpinnedInspectionRevision : '' : fromEnv;
  assertRevisionsAgree(fromPolicy, fromEnv);
  return fromPolicy;
}
function assertRevisionsAgree(policy: string, env: string | undefined): void {
  if (env !== undefined && env !== '' && env !== policy) throw new ConfigError(`PROJECT_SHA256 (${env}) differs from the --policy revision (${policy}); with --policy the host is pinned to the policy's projectSha256, so unset PROJECT_SHA256 or set it to the same reviewed revision`, { code: 'revision-pin-mismatch' });
}
const hermeticUnconfirmed = `A hermetic run (test, audit, benchmark, MCP run_tests, or validate and routes with --local-review) needs every extension the host file exports composed on its fresh temporary data directory, and at least one was not: build host.mjs with composeHost from this core (@jimhoyd/urlcode/extensions) and extensions built for URLCode extension contract ${extensionContract}, which keep every file under context.data, and export only the registrations it returns (wrap a hand-written registration in a defineExtension definition and pass it to composeHost). No request was replayed; an older composeHost may already have opened files wherever its extensions keep them`;
interface LoadOptions {
  /** The `projectSha256` of an operator policy the CLI already loaded and validated with `--policy`. */
  revision?: string | undefined;
  /** A read-only command: without a pin the host composes unpinned registrations that cannot activate (#910). */
  inspection?: boolean | undefined;
  /**
   * A run that replays requests (`test`, `audit`, `benchmark`, MCP `run_tests`), or a local review (`validate` or
   * `routes` with `--local-review` and no operator pin): the host is composed on a fresh, empty temporary data
   * directory (RIM-EXT-HERMETIC-001), which the returned host's `close()` removes. Each hermetic load imports the host
   * file anew, so a second run in the same process composes its own extensions, and refuses a host exporting any
   * registration that `composeHost` did not compose on that directory (`hermetic-host-unconfirmed`, #976).
   */
  hermetic?: boolean | undefined;
}
export async function loadOperatorHost(given: string | undefined, project: string, { revision, inspection, hermetic }: LoadOptions = {}): Promise<OperatorHost> {
  if (given === undefined) return {};
  // Always named explicitly; a relative name resolves against the working directory (a site's `--host-file host.mjs`).
  const file = resolve(given);
  assert(['.mjs', '.js'].includes(extname(file)), 'Host file must be an ES module path (.mjs or .js)');
  const root = await realpath(project), path = await realpath(file), rel = relative(root, path);
  assert(isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep), 'Host file must be outside the application project');
  const info = await stat(path);
  assert(info.isFile() && info.size <= 1048576, 'Host file must be a regular file of at most 1 MiB');
  let module: Record<string, unknown>;
  // Importing runs host.mjs, including composeHost and every extension's host() hook. Core's own refusals (and an
  // extension's, already named by composeHost) keep their message; anything else is reported as the host file's.
  if (revision !== undefined) assertRevisionsAgree(revision, process.env.PROJECT_SHA256);
  const data = hermetic === true ? await createRunDirectory('hermetic') : undefined;
  const removeData = async (): Promise<void> => { if (data !== undefined) await removeRunDirectory(data); };
  const slot = globalThis as Record<symbol, unknown>, previous = slot[operatorRevisionKey], previousInspection = slot[inspectionHostKey], previousData = slot[hermeticDataKey], previousConfirmed = slot[hermeticConfirmedKey];
  const confirmed = new WeakSet<object>();
  if (revision !== undefined) slot[operatorRevisionKey] = revision;
  if (inspection === true) slot[inspectionHostKey] = true;
  if (data !== undefined) { slot[hermeticDataKey] = data; slot[hermeticConfirmedKey] = confirmed; }
  // A hermetic load must run host.mjs (and so composeHost) again: the module cache would hand back the extensions an
  // earlier load composed on another data directory.
  try { module = await import(pathToFileURL(path).href + (data === undefined ? '' : `?urlcode-hermetic=${randomUUID()}`)) as Record<string, unknown>; }
  catch (error) { await removeData(); throw asConfigError(error) ?? hostLoadError(error); }
  finally {
    if (previous === undefined) delete slot[operatorRevisionKey]; else slot[operatorRevisionKey] = previous;
    if (previousInspection === undefined) delete slot[inspectionHostKey]; else slot[inspectionHostKey] = previousInspection;
    if (previousData === undefined) delete slot[hermeticDataKey]; else slot[hermeticDataKey] = previousData;
    if (previousConfirmed === undefined) delete slot[hermeticConfirmedKey]; else slot[hermeticConfirmedKey] = previousConfirmed;
  }
  const host: unknown = module.default;
  try {
    assert(host !== null && typeof host === 'object' && !Array.isArray(host), 'Host file must default-export an operator configuration object');
    assert(Object.keys(host).every(key => ['extensions', 'plugins', 'close'].includes(key)), 'Unknown operator host setting');
    const result = host as OperatorHost;
    assert(result.extensions === undefined || Array.isArray(result.extensions), 'Host extensions must be an array');
    assert(result.plugins === undefined || Array.isArray(result.plugins), 'Host plugins must be an array');
    assert(result.close === undefined || typeof result.close === 'function', 'Host close must be a function');
    if (data === undefined) return result;
    // Every registration must be one this load's composeHost built on the run's directory (#976): an older copy's, or a
    // hand-made one (also one spread or pushed beside composed ones), would keep its files wherever it always did,
    // which may be the site's live data.
    if (result.extensions?.some(registration => registration === null || typeof registration !== 'object' || !confirmed.has(registration))) {
      try { await result.close?.(); } catch { /* the refusal below is the error to report */ }
      throw new ConfigError(hermeticUnconfirmed, { code: 'hermetic-host-unconfirmed' });
    }
    // The run's data goes with the host: its extensions release their files first.
    return { ...result, async close() { try { await result.close?.(); } finally { await removeData(); } } };
  } catch (error) { await removeData().catch(() => undefined); throw error; }
}
