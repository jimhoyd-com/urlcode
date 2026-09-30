import { request, Agent } from 'node:http';
import type { IncomingMessage, ClientRequest, RequestOptions } from 'node:http';
import { request as secureRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { readFile, lstat } from 'node:fs/promises';
import { closestKey, safeFile } from './config.ts';
import Ajv from 'ajv/dist/2020.js';
import { assert, ConfigError } from './errors.ts';
import type { ErrorDetails } from './errors.ts';
import { compileTrustedProxies } from './client-address.ts';
import { isRecord } from './object-guards.ts';
import { holdsIllFormedString } from './body-validation.ts';
import { CookieJar, cookieNames, jarScope } from './cookie-jar.ts';
import { parseTarget, matchRoute, contextFor, redirectLocation } from './router.ts';
import { runCompliance } from './compliance.ts';
import { handlerNames as handlers } from './types.ts';
import { bodyPolicy } from './http-policy.ts';
import { unmetSignals } from './signal-recorder.ts';
import type { SignalExpectation, SignalRecorder } from './signal-recorder.ts';
import type { CompiledRedirect, CompiledRoute, HandlerName, LogFn, PlanInventoryEntry, PolicyInventory } from './types.ts';
import type { ComplianceOptions, ComplianceReport } from './compliance.ts';
import type { CompiledRoutes, RequestContext } from './match.ts';

export type { RouteState, HandlerName } from './types.ts';
/** One configured route as the inventory reports it: a PlanInventoryEntry with the handler kind named. */
export interface RouteInventory extends PlanInventoryEntry {
  handler: HandlerName | undefined;
  /** Always reported here, so a trust change is visible in `routes` and its diff. */
  sandbox: boolean;
  /** Non-blocking `audit` observations about this route (e.g. a webhook-shaped
   * route with no declared `sandbox`/`sandboxReason`); never affects `ready`. */
  advisories?: string[];
}
/** One request case: a generated probe or a `tests/requests.json` fixture. */
export interface RequestCase {
  path: string; method?: string | undefined; status: number; headers?: Record<string, string> | undefined; body?: string | undefined;
  expectHeaders?: Record<string, string> | undefined; expectBody?: string | undefined;
  /**
   * JSON Pointers (RFC 6901) into a JSON response body and the value each must equal (deep equality), so a case can
   * assert `/balance` in a body that also carries generated ids. A string may hold `{{name}}` references; one that is
   * exactly a single reference to a number or boolean a `{json}` capture kept stands for that number or boolean.
   */
  expectJson?: Record<string, JsonValue> | undefined;
  /** Signals the request must emit; checked only where the host records signals (`urlcode test`, `urlcode audit`). */
  expectSignals?: SignalExpectation[] | undefined;
  /** Only inside `steps`: values kept from this step's response for later steps' `{{name}}` references. */
  capture?: Record<string, CaptureSpec> | undefined;
}
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
/**
 * Where a captured value comes from: a dotted path into a JSON response body, one single-valued response header, or
 * the value the fixture's cookie jar holds for a cookie name after this step's response. A failure report shows a
 * json or header capture's value where it was substituted, unless the capture declares `secret: true`; a cookie
 * value is a credential and is never shown.
 */
type CaptureSpec = ({ json: string } | { header: string }) & { secret?: true } | { cookie: string };
/** A step that closes and restarts the runtime on the same project and data directory. */
interface RestartStep { restart: true }
/** An ordered fixture: requests that share captured values, optionally with restarts between them. */
interface StepsFixture { steps: (RequestCase | RestartStep)[] }
type Fixture = RequestCase | StepsFixture;
export const isStepsFixture = (fixture: Fixture): fixture is StepsFixture => 'steps' in fixture;
const isRestartable = (app: AuditableApp): app is RestartableApp => typeof (app as Partial<RestartableApp>).restart === 'function';
const isRestart = (step: RequestCase | RestartStep): step is RestartStep => 'restart' in step;
export interface ProjectPlan { inventory: RouteInventory[]; cases: RequestCase[]; resolve: (path: string) => string | undefined }
/**
 * `captured` holds values from a step's `capture` and `setCookies` the response's Set-Cookie lines; callers use them
 * for substitution and the cookie jar only, and never print them.
 */
interface HitResult { pass: boolean; status: number; durationMs: number; error?: string; captured?: Record<string, string>; typed?: Record<string, number | boolean>; setCookies?: string[]; mismatches?: Mismatch[] }
/**
 * One failed assertion of a fixture: what it expected and what the response had, each cut to MAX_SHOWN characters
 * (from just before `firstDifference`, the first differing character index, when that is further in).
 * `actual` is null when the response had no such header or JSON value. Only `urlcode test` prints these, for the author's own project.
 */
interface Mismatch { check: 'status' | 'header' | 'body' | 'json' | 'signals'; name?: string; expected: string | number; actual: string | number | null; firstDifference?: number;
  /** A status mismatch only: the start of the response body, so a refusal's reason code (`{"error":"cross_origin_refused"}`) is shown. */
  body?: string }
const MAX_SHOWN = 200, STATUS_BODY_BYTES = 1024;
const shown = (text: string): string => text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}... (${text.length} characters)` : text;
/** Full-length mismatches; `presented` redacts and shortens them before anything prints them. */
function mismatches(test: RequestCase, status: number, headers: IncomingMessage['headers'], body: Buffer): Mismatch[] {
  const found: Mismatch[] = [];
  if (status !== test.status) found.push({ check: 'status', expected: test.status, actual: status, ...(body.length ? { body: body.subarray(0, STATUS_BODY_BYTES).toString() } : {}) });
  for (const [name, expected] of Object.entries(test.expectHeaders ?? {})) {
    const value = headers[name.toLowerCase()];
    if (value === expected) continue;
    found.push({ check: 'header', name: name.toLowerCase(), expected, actual: value === undefined ? null : Array.isArray(value) ? value.join(', ') : value });
  }
  if (test.expectBody !== undefined && body.toString() !== test.expectBody) found.push({ check: 'body', expected: test.expectBody, actual: body.toString() });
  if (test.expectJson !== undefined) {
    const document = parsedJson(body);
    for (const [path, expected] of Object.entries(test.expectJson)) {
      if (document === notJson) { found.push({ check: 'json', name: path, expected: JSON.stringify(expected), actual: 'the response body is not JSON (or is over 1 MiB)' }); break; }
      const actual = jsonPointer(document, path);
      if (!jsonMatches(expected, actual)) found.push({ check: 'json', name: path, expected: JSON.stringify(expected), actual: actual === undefined ? null : JSON.stringify(actual) });
    }
  }
  return found;
}
const notJson = Symbol('not JSON');
function parsedJson(body: Buffer): unknown {
  if (body.length > MAX_CAPTURE_BODY) return notJson;
  try { return JSON.parse(body.toString('utf8')) as unknown; } catch { return notJson; }
}
/** RFC 6901: `""` is the whole document; `~1` is `/` and `~0` is `~` in a segment. Undefined when a segment is missing. */
function jsonPointer(document: unknown, path: string): unknown {
  if (path === '') return document;
  let value = document;
  for (const raw of path.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(value)) value = /^(0|[1-9]\d*)$/.test(key) ? value[Number(key)] : undefined;
    else if (isRecord(value) && Object.hasOwn(value, key)) value = value[key];
    else return undefined;
    if (value === undefined) return undefined;
  }
  return value;
}
/** Deep JSON equality: object key order does not matter, array order does. */
function jsonMatches(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return expected === actual;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => jsonMatches(item, actual[i]));
  if (!isRecord(actual) || Array.isArray(actual)) return false;
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length && keys.every(key => Object.hasOwn(actual, key) && jsonMatches((expected as Record<string, unknown>)[key], actual[key]));
}
/**
 * Puts `{{name}}` back wherever a secret captured value (`secret: true`, or a cookie capture) appears, and
 * `<cookie NAME>` wherever a cookie value a response set appears, so a report never prints either, even in part.
 */
function redactor(secretValues: ReadonlyMap<string, string>, cookies: ReadonlyMap<string, string> = new Map()): (text: string) => string {
  // Longest first, so a value that contains another is replaced whole.
  const secrets = [...[...secretValues].map(([name, value]) => [value, `{{${name}}}`]), ...[...cookies].map(([value, name]) => [value, `<cookie ${name}>`])].sort((a, b) => b[0]!.length - a[0]!.length);
  return (text: string): string => { for (const [secret, placeholder] of secrets) text = text.split(secret!).join(placeholder); return text; };
}
/** Redacts (see `redactor`) and shortens each string of a failure's mismatches. */
function presented<R extends { mismatches?: Mismatch[] }>(result: R, redact: (text: string) => string): R {
  const list = result.mismatches;
  if (!list) return result;
  return { ...result, mismatches: list.map(item => {
    if (item.body !== undefined) item = { ...item, body: shown(redact(item.body)) };
    if (item.check === 'signals' || typeof item.expected !== 'string' || typeof item.actual !== 'string') return { ...item, expected: typeof item.expected === 'string' ? shown(redact(item.expected)) : item.expected, actual: typeof item.actual === 'string' ? shown(redact(item.actual)) : item.actual };
    const expected = redact(item.expected), actual = redact(item.actual);
    // Long texts that differ late are shown from just before the first difference, so the cut never hides it.
    let at = 0;
    while (at < expected.length && expected[at] === actual[at]) at++;
    const from = at > MAX_SHOWN - 40 ? at - 40 : 0;
    const cut = (text: string): string => from ? `...${shown(text.slice(from))}` : shown(text);
    return { ...item, expected: cut(expected), actual: cut(actual), firstDifference: at };
  }) };
}
export interface DeploymentTarget { protocol: string; hostname: string; port: number | string; /** The Host header value: the host, plus the port when it is not the scheme's default. */ authority: string }
/** A started server as the audit sees it. structural: the real type is startServer's result in src/server.ts. */
export interface AuditableApp {
  address: AddressInfo; root: string; testPlan(): ProjectPlan & { policies?: Record<string, PolicyInventory> };
  /** The site origin the runtime serves (its `--origin`, else its own address): the origin fixture cookie jars are clients of. */
  readonly origin?: string | undefined;
}
/** An app that can also close and restart itself on the same project and data directory (fixture `restart` steps). */
export interface RestartableApp extends AuditableApp { restart(): Promise<void> }
export type { ComplianceOptions, ComplianceReport } from './compliance.ts';
/**
 * The deployment under review, as the operator declares it (the CLI takes the `serve` flags
 * `--trusted-proxies` and `--metrics` on `audit`). The audit's own probe server applies neither;
 * they only decide which `deploymentAdvisories` apply.
 */
interface AuditDeployment { trustedProxies?: string | string[] | undefined; metrics?: boolean | undefined }
/** A non-blocking finding about how the project will be deployed rather than about one route. */
interface DeploymentAdvisory { code: 'client-throttle-without-trusted-proxies' | 'metrics-on-public-listener'; message: string; routes?: string[] }
interface AuditOptions { /** The recorder `app` captures signals into, so fixtures' `expectSignals` are checked. */ signals?: SignalRecorder | undefined; expectRoutes?: number | undefined; log?: LogFn | undefined; compliance?: ComplianceOptions | undefined; deployment?: AuditDeployment | undefined }
interface AuditReport {
  elapsedMs: number; ready: boolean;
  /** Empty when `ready`; otherwise one stable code per failed condition:
   * `no-active-routes`, `route-count-mismatch`, `failed-checks`, `uncovered-route-methods`. */
  notReadyReasons: string[];
  /** `configured` is every route in the table, including routes generated from `site` keys; `--expect-routes` compares against it.
   * `declared` + `generated` always equals `configured`. */
  counts: { configured: number; declared: number; generated: number; active: number; disabled: number; expired: number; byHandler: Record<string, number> };
  expectedRoutes: number | null;
  /** Where `expectedRoutes` came from: the caller's `--expect-routes`, the project's committed `tests/audit.json`, or null when unchecked. */
  expectedRoutesFrom: '--expect-routes' | 'tests/audit.json' | null;
  countMatches: boolean; checks: number; passed: number; failed: number; coveredRouteMethods: number;
  unassertedCases: number[]; uncovered: { route: string; method: string }[];
  /** HEAD pairs covered because the same route's GET is (see docs/READINESS.md#coverage-rules). Shown even when `ready`. */
  impliedRouteMethods: { route: string; method: 'HEAD'; from: 'GET' }[];
  /** Route/method pairs excused by a `coveredElsewhere` waiver, with the reason and what proved the route is served:
   * `route-covered` (another method of it is covered) or `gate-refusal` (a principal gate's asserted 401 on it). Shown even when `ready`. */
  waivedRouteMethods: { route: string; method: string; reason: string; basis: 'route-covered' | 'gate-refusal' }[];
  /** Waivers not honored (nothing proves the route is served, e.g. an error-only function route); their pairs stay in `uncovered`. */
  ignoredWaivers: { route: string; method: string; reason: string }[];
  /** Waivers whose pair already has a passing normal-response fixture: remove them. Never blocks `ready`. */
  redundantWaivers: { route: string; method: string; reason: string }[];
  /** Why coverage fell short and what to write, one entry per kind (see CoverageNote); empty when nothing is missing or unasserted. */
  coverageNotes: CoverageNote[];
  policies: Record<string, PolicyInventory>; compliance: ComplianceReport | null;
  /** Non-blocking `audit` observations, e.g. a route that looks webhook-shaped
   * but declares neither `sandbox: true` nor `sandboxReason`. Never affects `ready`. */
  advisories: { route: string; message: string }[];
  /** Non-blocking deployment findings (see AuditDeployment). Never affects `ready`. */
  deploymentAdvisories: DeploymentAdvisory[];
}
/**
 * A fixed explanation of a coverage gap: `unasserted-success` (passing cases below 400 without an assertion),
 * `gated-route-uncovered` (routes a principal gate protects with no method covered at all), `method-without-success`
 * (uncovered methods of routes another method of which is covered; `cases` are the passing asserted refusals, status
 * 400 or more, sent to them) or `waiver-without-proof` (ignored waivers). Only route patterns, methods and case
 * numbers, never fixture text.
 */
interface CoverageNote { code: 'unasserted-success' | 'gated-route-uncovered' | 'method-without-success' | 'waiver-without-proof'; message: string; routes?: string[]; methods?: { route: string; method: string }[]; cases?: number[] }

/** Narrows a compiled route to one that redirects, so redirectLocation can read its spec. */
export const hasRedirect = (route: CompiledRoute): route is CompiledRoute & { redirect: CompiledRedirect } => Boolean(route.redirect);
// Probes identify themselves so an agents policy that denies an empty
// User-Agent does not fail every generated case; fixtures may override it.
export const probeAgent = 'Mozilla/5.0 (compatible; RouteProbe/0.1)';
// Advisory only (docs/AI-AUTHORING.md, "Deciding when a route needs sandbox: true"):
// a route that runs project code, accepts POST with a declared request.body.POST
// policy, and declares neither `sandbox: true` nor `sandboxReason` looks
// plausibly webhook/callback/third-party-input-shaped. This is a nudge to
// record the trust decision, never an inferred verdict — it never fails
// `audit` or changes `ready`. The wording follows the documented criteria:
// untrusted input alone is not a reason to sandbox (#586).
function routeAdvisories(route: CompiledRoute): string[] {
  const advisories: string[] = [];
  const runsCode = Boolean(route.function) || Boolean(route.middleware?.length);
  if (runsCode && bodyPolicy(route, 'POST') && !route.sandbox && !route.sandboxReason) {
    advisories.push("This route accepts POST with a declared request.body.POST policy but declares neither sandbox: true nor sandboxReason; record the trust decision. Untrusted input alone is not a reason to sandbox: validate it with request.body.POST.schema and parameters. Reviewed first-party code stays trusted (the default; the filesystem, node:crypto signature checks, fetch and npm packages exist only there): add to the route: sandboxReason: \"Reviewed first-party code; trusted deliberately.\" Add sandbox: true only when the route's own code is unreviewed or contributed, or must not be able to leak a granted secret, with a sandboxReason saying why.");
  }
  return advisories;
}
/** `principalProviders`: the active extensions that set a request principal; a route naming one is reported `gatedBy` it. */
export function projectPlan(compiled: CompiledRoutes<CompiledRoute>, principalProviders: ReadonlySet<string> = new Set()): ProjectPlan {
  const routes = [...compiled.exact.values(), ...[...compiled.byLength.values()].flat(), ...compiled.mounts];
  const now = Date.now();
  const inventory: RouteInventory[] = routes.map(route => { const advisories = routeAdvisories(route), gatedBy = (route.extensionPolicyNames ?? []).filter(name => principalProviders.has(name)); return { path:route.pattern, handler:handlers.find(key => route[key]), methods:route.methods, middleware:route.middleware?.length || 0,
    policies:[...(route.policy ? Object.keys(route.policy.describe) : []),...(route.extensionPolicyNames??[]).map(name=>`extensions.${name}`)],
    sandbox:route.sandbox === true, ...(route.sandboxReason ? { sandboxReason:route.sandboxReason } : {}),
    ...(route.coveredElsewhere ? { coveredElsewhere:route.coveredElsewhere } : {}),
    ...(route.generated ? { generated:route.generated } : {}),
    ...(gatedBy.length ? { gatedBy } : {}),
    ...(advisories.length ? { advisories } : {}),
    state:route.enabled === false ? 'disabled' : route.expiresAt && now >= route.expiresAt ? 'expired' : 'active' }; });
  const cases: RequestCase[] = [];
  for (const [i,route] of routes.entries()) {
    const entry = inventory[i];
    if (!entry) continue;
    if (entry.state !== 'active') {
      if(!route.names.length && !route.static && !route.extension && !route.extensionPolicyNames?.length) cases.push({path:route.pattern,method:'GET',status:entry.state==='disabled'?404:410});
      continue;
    }
    if (route.extension || route.extensionPolicyNames?.length || route.proxy || route.signals?.length || route.match || route.conditional || route.function || route.middleware?.length || route.names.length) continue;
    // Required inputs need intentional fixtures; never invent business data.
    let context: RequestContext;
    try { context = contextFor(route,route.wildcard ? {'**':'sample'} : {},new URLSearchParams(),new Headers()); } catch { continue; }
    const files = route.asset instanceof Map ? route.asset : undefined;
    const prefix = route.prefix ?? '';
    const paths = route.wildcard ? [prefix + 'sample'] : route.static && files ? [...files.keys()].map(key => prefix + key.split('/').map(encodeURIComponent).join('/')) : [route.pattern];
    for (const path of paths) for (const method of route.methods) {
      if (!['GET','HEAD'].includes(method)) continue;
      const test: RequestCase = {path,method,status:(route.redirect ? route.redirect.status || 302 : route.reply?.status || 200)};
      if (hasRedirect(route)) test.expectHeaders = {location:redirectLocation(route,context,new URLSearchParams())};
      const asset=route.static ? files?.get(decodeURIComponent(path.slice(prefix.length))) : route.asset instanceof Map ? undefined : route.asset;
      if(asset) test.expectHeaders={'content-type':asset.type,etag:asset.etag,'content-length':String(asset.body.length)};
      if (route.reply && method !== 'HEAD') test.expectBody = Buffer.from(route.reply.body).toString('utf8');
      if (method === 'HEAD') test.expectBody = '';
      cases.push(test);
    }
  }
  return {inventory,cases,resolve:path => matchRoute(compiled,parseTarget(path))?.route.pattern};
}
// Bounds for ordered fixtures. A fixture file is data a project author (or an agent) wrote;
// none of these limits is a security boundary, they keep a mistake from becoming an unbounded run.
const MAX_STEPS = 50, MAX_RESTARTS = 5, MAX_TOTAL_RESTARTS = 20, MAX_CAPTURES = 16, MAX_CAPTURE_BYTES = 4096, MAX_CAPTURE_BODY = 1024 * 1024;
const nameShape = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/, cookieShape = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/, pathShape = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/, control = /[\x00-\x1f\x7f]/;
const templates = (text: string): string[] => [...text.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]{0,31})\}\}/g)].map(m => m[1] ?? '');
const jsonStrings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(jsonStrings) : isRecord(value) ? Object.values(value).flatMap(jsonStrings) : [];
const templated = (test: RequestCase): string[] => [test.path, test.body, test.expectBody, ...Object.values(test.headers ?? {}), ...Object.values(test.expectHeaders ?? {}), ...jsonStrings(test.expectJson)].filter((v): v is string => v !== undefined);
/** An RFC 6901 pointer of at most 8 segments of at most 64 characters: `~` only as `~0` or `~1`. */
const pointerShape = /^(?:\/(?:[^~/]|~[01]){0,64}){0,8}$/;
function checkCase(test: unknown, inSteps: boolean): asserts test is RequestCase {
  assert(isRecord(test), 'Invalid request test');
  // A step path may start with a {{name}} (a captured Location); it is checked again once filled in.
  assert(typeof test.path === 'string' && (test.path.startsWith('/') || (inSteps && test.path.startsWith('{{'))) && !test.path.startsWith('//') && !/[\r\n]/.test(test.path), 'Test path must be local');
  assert(Number.isInteger(test.status) && typeof test.status === 'number' && test.status >= 200 && test.status <= 599, 'Test must declare an HTTP status');
  assert(!test.method || (typeof test.method === 'string' && ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(test.method)), 'Invalid test method');
  assert(test.body === undefined || typeof test.body === 'string', 'Test body must be text');
  assert(test.expectBody === undefined || typeof test.expectBody === 'string', 'Expected body must be text');
  if (test.expectJson !== undefined) {
    assert(isRecord(test.expectJson) && Object.keys(test.expectJson).length >= 1 && Object.keys(test.expectJson).length <= 16, 'expectJson must map 1-16 JSON Pointers to the values they must equal, such as {"/balance": 100}');
    for (const path of Object.keys(test.expectJson)) assert(pointerShape.test(path), `expectJson key ${JSON.stringify(path.slice(0, 64))} is not a JSON Pointer: write "" for the whole body or /key/0/key (at most 8 segments; ~0 is ~ and ~1 is /)`);
  }
  for (const headers of [test.headers,test.expectHeaders]) assert(headers === undefined || (isRecord(headers) && Object.values(headers).every(v => typeof v === 'string')), 'Test headers must be string mappings');
  assert(inSteps || test.capture === undefined, 'capture is only valid inside steps');
  if (test.capture !== undefined) {
    assert(isRecord(test.capture) && Object.keys(test.capture).length <= MAX_CAPTURES, `capture must be a mapping of at most ${MAX_CAPTURES} names`);
    for (const [name,spec] of Object.entries(test.capture)) {
      assert(nameShape.test(name), 'Capture names use letters, digits and underscores (at most 32, not starting with a digit)');
      const secret = isRecord(spec) && Object.hasOwn(spec, 'secret');
      assert(isRecord(spec) && Object.keys(spec).length === (secret ? 2 : 1) && (!secret || (spec.secret === true && typeof spec.cookie !== 'string')), 'A capture is exactly one of {json: "a.b.0.c"}, {header: "name"} or {cookie: "name"}; a json or header capture may add secret: true (a cookie value is always secret)');
      if (typeof spec.json === 'string') assert(spec.json.length <= 256 && pathShape.test(spec.json), 'Capture json path is dotted keys and array indexes, such as items.0.id');
      else if (typeof spec.cookie === 'string') assert(cookieShape.test(spec.cookie), 'A cookie capture names one cookie, such as {cookie: "session"}');
      else assert(typeof spec.header === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(spec.header) && spec.header.toLowerCase() !== 'set-cookie', 'A capture is exactly one of {json: "a.b.0.c"}, {header: "name"} (a single-valued header, not set-cookie) or {cookie: "name"}');
    }
  }
}
const FIXTURE_FILE = 'tests/requests.json';
/** The one built-in reference, `{{origin}}`: the site origin the fixture's requests are sent to (see siteOrigin). */
const ORIGIN = 'origin';
const fixtureDetails = (pointer?: string, key?: string): ErrorDetails => ({ code: 'invalid-fixture', file: FIXTURE_FILE, pointer, key });
/**
 * JSON.parse with the failure's line and column, never the parser's excerpt of the file. A string or key holding an
 * unpaired surrogate is refused (#1016): a request sends text as UTF-8, which has no encoding for one, so the case
 * would silently send U+FFFD instead.
 */
function parseFixtureJson(text: string): unknown {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) {
    const position = Number(/position (\d+)/.exec(error instanceof Error ? error.message : '')?.[1] ?? NaN);
    let where = '';
    if (Number.isInteger(position)) {
      const before = text.slice(0, position).split('\n');
      where = ` at line ${before.length}, column ${before.at(-1)!.length + 1}`;
    }
    throw new ConfigError(`${FIXTURE_FILE} is not valid JSON${where}; check for a trailing comma, a missing comma or quote, or a comment (JSON has none)`, { code: 'invalid-fixture', file: FIXTURE_FILE });
  }
  if (holdsIllFormedString(value)) throw new ConfigError(`${FIXTURE_FILE} holds a string or key with an unpaired surrogate escape (\\uD800-\\uDFFF), which a request cannot send; to send the escape itself in a JSON body, double its backslash in the body text ("body": "{\\"a\\":\\"\\\\ud800\\"}")`, { code: 'invalid-fixture', file: FIXTURE_FILE });
  return value;
}
// The shipped schema is the fixture contract: tooling and editors validate against the same file.
const fixtureSchema = JSON.parse(await readFile(new URL('../../../schemas/requests.schema.json', import.meta.url), 'utf8')) as { $defs: Record<string, { properties?: Record<string, unknown> }> };
const fixtureAjv = new Ajv.default({ allErrors: false, verbose: true, strict: true, strictRequired: false });
const validateFixtures = fixtureAjv.compile(fixtureSchema);
/** Keys people reach for from other test tools, and what URLCode calls them. */
const fixtureKeyHints: Record<string, string> = {
  json: 'send a JSON request body as body (the serialized text) with headers {"content-type": "application/json"}',
  expectBodyJson: 'assert JSON values with expectJson ({"/balance": 100}), or the exact text with expectBody', matchBody: 'assert JSON values with expectJson ({"/balance": 100}), or the exact text with expectBody',
  expectStatus: 'the expected status is status', expectedStatus: 'the expected status is status',
  response: 'assert the response with status, expectHeaders, expectBody and expectJson', expect: 'assert the response with status, expectHeaders, expectBody and expectJson',
  url: 'the request target is path, such as /api/items?limit=2', query: 'put the query string in path, such as /api/items?limit=2',
  data: 'the request body is body (text)',
  capture: 'capture is only valid inside steps',
};
const fixtureLabel = (pointer: string): string => {
  const [item, , step] = pointer.split('/').slice(1);
  return item === undefined ? FIXTURE_FILE : `${FIXTURE_FILE} fixture ${Number(item) + 1}${step === undefined ? '' : `, step ${Number(step) + 1}`}`;
};
/** Validates against schemas/requests.schema.json, naming the fixture, the unknown key and what to write instead. */
function checkFixtureSchema(cases: unknown[]): void {
  if (validateFixtures(cases)) return;
  const e = validateFixtures.errors![0]!;
  // Report the case's own failure, not the if/then wrapper around it.
  const path = e.instancePath;
  const where = fixtureLabel(path);
  if (e.keyword === 'additionalProperties') {
    const key = String((e.params as { additionalProperty?: unknown }).additionalProperty);
    const shown = JSON.stringify(key.length > 64 ? `${key.slice(0, 64)}...` : key);
    const allowed = Object.keys((e.parentSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
    const hint = Object.hasOwn(fixtureKeyHints, key) ? `; ${fixtureKeyHints[key]}` : (() => { const close = closestKey(key, allowed); return close ? `; did you mean ${JSON.stringify(close)}?` : ''; })();
    throw new ConfigError(`${where}: unknown key ${shown}${hint} (allowed keys: ${allowed.join(', ')}; see schemas/requests.schema.json)`, fixtureDetails(path, key));
  }
  if (e.keyword === 'required') throw new ConfigError(`${where}: missing required key ${JSON.stringify(String((e.params as { missingProperty?: unknown }).missingProperty))} (every request needs path and status; see schemas/requests.schema.json)`, fixtureDetails(path));
  if (e.keyword === 'enum') throw new ConfigError(`${where}${path.slice(path.lastIndexOf('/') + 1) ? `, ${path.slice(path.lastIndexOf('/') + 1)}` : ''}: must be one of ${((e.params as { allowedValues?: unknown[] }).allowedValues ?? []).join(', ')}`, fixtureDetails(path));
  // Ajv's message comes from the schema (a type or bound), never from the fixture value.
  throw new ConfigError(`${where}${e.instancePath.split('/').length > 2 ? `, ${e.instancePath.split('/').slice(2).join('.')}` : ''}: ${e.message ?? 'is invalid'} (see schemas/requests.schema.json)`, fixtureDetails(path));
}
/** The project's committed audit expectation (#955), relative to the project root. */
export const auditExpectationFile = 'tests/audit.json';
/**
 * The route count the project commits to, `tests/audit.json` `{"expectRoutes": N}`: one reviewed value that every
 * `audit` run (the npm script, CI and a hand-typed command) compares against when no `--expect-routes` is given.
 * Undefined when the project has no such file.
 */
export async function readAuditExpectation(root: string): Promise<number | undefined> {
  try { await lstat(join(root, auditExpectationFile)); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
  const details = { code: 'invalid-audit-expectation', file: auditExpectationFile };
  const bytes = await readFile(await safeFile(root, auditExpectationFile));
  assert(bytes.length <= 4096, `${auditExpectationFile} exceeds 4 KiB`, details);
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new ConfigError(`${auditExpectationFile} is not valid JSON`, details); }
  assert(isRecord(value) && !Array.isArray(value) && Object.keys(value).length === 1 && Number.isSafeInteger(value.expectRoutes) && (value.expectRoutes as number) >= 0 && (value.expectRoutes as number) <= 100000,
    `${auditExpectationFile} must be exactly {"expectRoutes": N}, the configured route count the audit expects (a whole number, 0-100000)`, details);
  return value.expectRoutes as number;
}
export async function readFixtures(root: string, optional = false): Promise<Fixture[]> {
  if(optional) {
    try {await lstat(join(root,'tests/requests.json'));}
    catch(error){if(error instanceof Error && 'code' in error && error.code==='ENOENT')return [];throw error;}
  }
  const file=await safeFile(root,'tests/requests.json');
  const bytes = await readFile(file);
  assert(bytes.length <= 16*1024*1024, 'Request fixture file exceeds 16 MiB', fixtureDetails());
  const cases = parseFixtureJson(bytes.toString('utf8'));
  assert(Array.isArray(cases) && cases.length <= 10000 && (optional || cases.length), 'Request tests must be an array (maximum 10000)', fixtureDetails());
  let requests = 0, restarts = 0, at = 0;
  try {
    for (const test of cases as unknown[]) {
      at++;
      if (!(isRecord(test) && 'steps' in test)) {
        checkCase(test,false); requests++;
        for (const name of templated(test).flatMap(templates)) assert(name === ORIGIN, `{{${name}}} needs a steps fixture that captures it; outside steps the only reference is {{origin}}, the site origin`);
        continue;
      }
      assert(Object.keys(test).length === 1 && Array.isArray(test.steps) && test.steps.length >= 1 && test.steps.length <= MAX_STEPS, `steps must be the only key and hold 1-${MAX_STEPS} steps`);
      const known = new Set<string>([ORIGIN]); let here = 0;
      for (const step of test.steps as unknown[]) {
        if (isRecord(step) && 'restart' in step) {
          assert(step.restart === true && Object.keys(step).length === 1, 'A restart step is exactly {"restart": true}');
          assert(++here <= MAX_RESTARTS && ++restarts <= MAX_TOTAL_RESTARTS, `At most ${MAX_RESTARTS} restarts per fixture and ${MAX_TOTAL_RESTARTS} per file`);
          continue;
        }
        checkCase(step,true); requests++;
        for (const name of templated(step).flatMap(templates)) assert(known.has(name), 'A {{name}} reference needs an earlier step in the same fixture to capture it');
        for (const name of Object.keys(step.capture ?? {})) { assert(name !== ORIGIN, '{{origin}} is the site origin and cannot be captured; choose another capture name'); known.add(name); }
      }
    }
  } catch (error) {
    // Name the fixture a field check failed in; the file-level bounds already name the file.
    if (error instanceof ConfigError && error.details.file === undefined) throw new ConfigError(`${FIXTURE_FILE} fixture ${at}: ${error.message}`, fixtureDetails(`/${at - 1}`));
    throw error;
  }
  assert(requests <= 10000, 'Request tests exceed 10000 requests in total');
  // The checks above keep their specific wording; the shipped schema then rejects anything they do not know, such as an unknown key.
  checkFixtureSchema(cases);
  return cases as Fixture[]; // trust boundary: fixture JSON, validated field by field above
}
/**
 * One request a fixture run sent: `test` is the request as sent (captured values filled in), `original` as written.
 * `shown` is the target `test.path` with every secret value put back as `{{name}}` (or `<cookie NAME>`): the one to
 * print locally. A report on a live deployment prints `original`: its values can be real.
 */
interface FixtureStep { case: number; fixture: number; test: RequestCase; original: RequestCase; shown: string; result: HitResult }
interface FixtureHost {
  app: AuditableApp; agent: Agent; target?: DeploymentTarget | undefined;
  /** The recorder the local runtime captures signals into. Absent (a deployment): `expectSignals` is not checked. */
  signals?: SignalRecorder | undefined;
  /** Close and restart the runtime on the same project and data directory. Absent: the host cannot restart. */
  restart?: (() => Promise<void>) | undefined;
  /** Called with the 1-based fixture number and a reason when a fixture with a restart step is skipped because the host cannot restart. Absent: such a fixture is refused with an error. */
  skipped?: ((fixture: number, reason: string) => void) | undefined;
}
const fill = (text: string, values: Map<string,string>): string | undefined => {
  let missing = false;
  const out = text.replace(/\{\{([A-Za-z_][A-Za-z0-9_]{0,31})\}\}/g, (_, name: string) => { const v = values.get(name); if (v === undefined) missing = true; return v ?? ''; });
  return missing ? undefined : out;
};
/** Fills `{{name}}` in every string of an `expectJson` value; a string that is exactly one reference to a typed capture becomes that number or boolean. */
function fillJson(value: JsonValue, values: Map<string,string>, typed: ReadonlyMap<string,JsonValue>): JsonValue | undefined {
  if (typeof value === 'string') { const whole = /^\{\{([A-Za-z_][A-Za-z0-9_]{0,31})\}\}$/.exec(value)?.[1]; return whole !== undefined && typed.has(whole) ? typed.get(whole) : fill(value,values); }
  if (Array.isArray(value)) { const out: JsonValue[] = []; for (const item of value) { const f = fillJson(item,values,typed); if (f === undefined) return undefined; out.push(f); } return out; }
  if (value !== null && typeof value === 'object') { const out: Record<string,JsonValue> = {}; for (const [k,v] of Object.entries(value)) { const f = fillJson(v,values,typed); if (f === undefined) return undefined; out[k] = f; } return out; }
  return value;
}
function resolveStep(test: RequestCase, values: Map<string,string>, typed: ReadonlyMap<string,JsonValue> = new Map()): RequestCase | undefined {
  const map = (headers: Record<string,string> | undefined): Record<string,string> | undefined | null => {
    if (headers === undefined) return undefined;
    const out: Record<string,string> = {};
    for (const [k,v] of Object.entries(headers)) { const f = fill(v,values); if (f === undefined) return null; out[k] = f; }
    return out;
  };
  const path = fill(test.path,values), body = test.body === undefined ? undefined : fill(test.body,values), expectBody = test.expectBody === undefined ? undefined : fill(test.expectBody,values);
  const headers = map(test.headers), expectHeaders = map(test.expectHeaders);
  const expectJson = test.expectJson === undefined ? undefined : fillJson(test.expectJson,values,typed) as Record<string,JsonValue> | undefined;
  if (path === undefined || !path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path) || headers === null || expectHeaders === null || (test.body !== undefined && body === undefined) || (test.expectBody !== undefined && expectBody === undefined) || (test.expectJson !== undefined && expectJson === undefined)) return undefined;
  return { ...test, path, headers, body, expectHeaders, expectBody, expectJson };
}
/**
 * The origin a fixture's cookie jar is a client of: the deployment under verification, or the site origin the local
 * runtime serves (its `--origin`, else its own loopback address).
 */
const siteOrigin = (app: AuditableApp, target?: DeploymentTarget): string => target ? `${target.protocol}//${target.authority}` : app.origin ?? `http://127.0.0.1:${app.address.port}`;
/** What `{{name}}` resolves to: `{{origin}}` (read per request, as a restart without `--origin` moves the loopback port) and the captured values. */
const references = (host: FixtureHost, captured: ReadonlyMap<string,string> = new Map()): Map<string,string> => new Map([[ORIGIN, siteOrigin(host.app, host.target)], ...captured]);
/** The Set-Cookie values of a single-request fixture's response, which no jar keeps, still never print. */
function responseCookies(lines: readonly string[] = []): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of lines) { const pair = line.split(';', 1)[0] ?? '', at = pair.indexOf('='), value = at < 0 ? '' : pair.slice(at + 1).trim(); if (value) values.set(value, pair.slice(0, at).trim()); }
  return values;
}
/**
 * Runs every fixture in file order. A step after a failed step in the same fixture is reported failed with error
 * `skipped` and never sent, so a broken chain cannot pass. Each `steps` fixture has its own cookie jar, created empty
 * when the fixture starts and dropped when it ends: its steps send the cookies earlier steps' responses set, and no
 * other fixture or run ever sees them. A restart keeps the jar (the client outlives a server restart).
 */
export async function runFixtures(fixtures: Fixture[], host: FixtureHost, visit: (step: FixtureStep) => void | Promise<void>, firstCase = 1): Promise<void> {
  let n = firstCase;
  for (const [f,fixture] of fixtures.entries()) {
    if (!isStepsFixture(fixture)) {
      const resolved = resolveStep(fixture,references(host));
      if (!resolved) { await visit({case:n++,fixture:f+1,test:fixture,original:fixture,shown:fixture.path,result:{pass:false,status:0,durationMs:0,error:'unresolved'}}); continue; }
      host.signals?.take();
      const {setCookies, captured: _none, typed: _unused, ...result} = await hit(host.app,resolved,host.agent,host.target);
      await visit({case:n++,fixture:f+1,test:resolved,original:fixture,shown:resolved.path,result:presented(checkSignals(resolved,host,result),redactor(new Map(),responseCookies(setCookies)))}); continue;
    }
    if (fixture.steps.some(isRestart) && host.restart === undefined) {
      const reason = 'contains a restart step, which needs a runtime this host can close and restart';
      assert(host.skipped !== undefined, `Fixture ${f+1} ${reason}`);
      host.skipped(f+1,reason); continue;
    }
    // `secret` holds the captured values a report must not show (secret: true and cookie captures); `typed` the
    // numbers and booleans json captures kept, for an expectJson value that is exactly one reference.
    const values = new Map<string,string>(), secret = new Map<string,string>(), typed = new Map<string,JsonValue>(), jar = new CookieJar(jarScope(siteOrigin(host.app, host.target))); let broken = false;
    for (const step of fixture.steps) {
      if (isRestart(step)) { if (!broken) { try { await host.restart?.(); } catch { broken = true; } } continue; }
      const resolved = broken ? undefined : resolveStep(step,references(host,values),typed);
      let result: HitResult = {pass:false,status:0,durationMs:0,error:'skipped'}, shown = step.path;
      if (resolved) {
        // An explicit Cookie header is sent as written; the jar adds only the cookies it does not name.
        const explicit = Object.entries(resolved.headers ?? {}).find(([name]) => name.toLowerCase() === 'cookie')?.[1];
        const stored = jar.send(resolved.path, cookieNames(explicit ?? '')).map(({name,value}) => `${name}=${value}`);
        host.signals?.take();
        const hitResult = await hit(host.app,resolved,host.agent,host.target,stored.length ? [...(explicit ? [explicit] : []),...stored].join('; ') : undefined);
        shown = redactor(secret,jar.values())(resolved.path);
        const sent = checkSignals(resolved,host,hitResult);
        jar.store(sent.setCookies ?? [],resolved.path);
        const {captured: kept, typed: numbers, setCookies: _stored, ...response} = sent;
        let captured = kept, visible: HitResult = response;
        // A cookie capture reads the jar after this response, as the next request to this path would send it.
        for (const [name,spec] of Object.entries(resolved.capture ?? {})) {
          if (!visible.pass || !('cookie' in spec)) continue;
          const value = jar.send(resolved.path).find(cookie => cookie.name === spec.cookie)?.value;
          if (value === undefined || !acceptable(value)) { visible = {...visible,pass:false,error:'capture'}; captured = undefined; break; }
          (captured ??= {})[name] = value;
        }
        if (visible.pass) for (const [name,value] of Object.entries(captured ?? {})) {
          const spec = resolved.capture![name]!;
          values.set(name,value);
          if ('cookie' in spec || spec.secret === true) secret.set(name,value); else secret.delete(name);
          if (numbers !== undefined && Object.hasOwn(numbers,name)) typed.set(name,numbers[name]!); else typed.delete(name);
        }
        result = presented(visible,redactor(secret,jar.values()));
      } else if (!broken) result = {pass:false,status:0,durationMs:0,error:'unresolved'};
      if (!result.pass) broken = true;
      await visit({case:n++,fixture:f+1,test:resolved ?? step,original:step,shown,result});
    }
  }
}
/**
 * Fails a sent request whose captured signals break its `expectSignals`. The report names each unmet entry, how many
 * captured signals matched it, and what was captured (destination origin and the fixed payload only).
 */
function checkSignals(test: RequestCase, host: FixtureHost, result: HitResult): HitResult {
  const records = host.signals?.take() ?? [];
  if (!host.signals || test.expectSignals === undefined || result.error !== undefined) return result;
  const unmet = unmetSignals(test.expectSignals, records);
  if (!unmet.length) return result;
  const captured = records.map(({ destination, payload }) => `${payload.method} ${payload.route} ${payload.status} to ${destination}`).join('; ') || 'none';
  return { ...result, pass: false, mismatches: [...(result.mismatches ?? []), ...unmet.map(({ index, expected, matched }): Mismatch => ({
    check: 'signals', name: index < 0 ? 'none' : `expectSignals.${index}`, expected: index < 0 ? 'no signal' : JSON.stringify(expected), actual: `${matched} matched; captured: ${captured}` }))] };
}
const acceptable = (text: string): boolean => text.length > 0 && Buffer.byteLength(text) <= MAX_CAPTURE_BYTES && !control.test(text);
/** A json or header capture; cookie captures read the jar in runFixtures. */
function extract(spec: { json: string } | { header: string }, headers: IncomingMessage['headers'], body: Buffer): { text: string; typed?: number | boolean } | undefined {
  let value: unknown;
  if ('header' in spec) value = headers[spec.header.toLowerCase()];
  else {
    if (body.length > MAX_CAPTURE_BODY) return undefined;
    try { value = JSON.parse(body.toString('utf8')); } catch { return undefined; }
    for (const key of spec.json.split('.')) {
      if (Array.isArray(value)) value = /^\d+$/.test(key) ? value[Number(key)] : undefined;
      else if (isRecord(value) && Object.hasOwn(value,key)) value = value[key];
      else return undefined;
    }
  }
  const text = typeof value === 'string' ? value : (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' ? String(value) : undefined;
  if (text === undefined || !acceptable(text)) return undefined;
  return typeof value === 'string' ? { text } : { text, typed: value as number | boolean };
}
export function deploymentTarget(value: string): DeploymentTarget {
  let url: URL;
  try { url=new URL(value); } catch { assert(false,'Target must be an absolute HTTP(S) origin'); }
  assert(['http:','https:'].includes(url.protocol) && url.origin===value.replace(/\/$/,'') && !url.username && !url.password,
    'Target must be a bare HTTP(S) origin without path or credentials');
  return {protocol:url.protocol,hostname:url.hostname,port:url.port || (url.protocol==='https:'?443:80),authority:url.host};
}
/** `cookie`, when given, replaces the case's own Cookie header: the fixture runner's merge of it with the jar. */
export function hit(app: AuditableApp,test: RequestCase,agent: Agent,target?: DeploymentTarget,cookie?: string): Promise<HitResult> {
  return new Promise(resolve => {
    const began=performance.now();
    const fail=()=>resolve({pass:false,status:0,durationMs:performance.now()-began,error:'transport'});
    let req: ClientRequest|undefined;
    try {
      const send=target?.protocol==='https:' ? secureRequest : request;
      const given=cookie===undefined ? test.headers || {} : {...Object.fromEntries(Object.entries(test.headers || {}).filter(([name])=>name.toLowerCase()!=='cookie')),cookie};
      // A body is always framed with its length: Node sends a GET/HEAD/DELETE body unframed otherwise, which the server
      // cannot tell from the next request, so a fixture could not check how a route answers a body on those methods.
      const framed=test.body!==undefined && !Object.keys(given).some(name=>['content-length','transfer-encoding'].includes(name.toLowerCase()));
      const own=framed ? {...given,'content-length':String(Buffer.byteLength(test.body!))} : given;
      const options: RequestOptions=target
        ? {host:target.hostname,port:target.port,path:test.path,method:test.method || 'GET',headers:{host:target.authority,'user-agent':probeAgent,...own},agent,timeout:10000}
        : {host:'127.0.0.1',port:app.address.port,path:test.path,method:test.method || 'GET',headers:{'user-agent':probeAgent,...own},agent,timeout:10000};
      req=send(options,(res: IncomingMessage)=>{
        let size=0;const chunks: Buffer[]=[];
        // A body no assertion or capture reads is kept only up to STATUS_BODY_BYTES, for a status mismatch's report.
        res.on('data',(chunk: Buffer)=>{size+=chunk.length;if(size>16*1024*1024)res.destroy(new Error('Response limit'));else if(test.expectBody!==undefined || ((test.capture || test.expectJson) && size<=MAX_CAPTURE_BODY) || size-chunk.length<STATUS_BODY_BYTES)chunks.push(chunk);});
        res.on('error',fail);
        res.on('end',()=>{
          const status=res.statusCode ?? 0,durationMs=performance.now()-began,body=Buffer.concat(chunks),setCookies=res.headers['set-cookie'] ?? [];
          const found=mismatches(test,status,res.headers,body);
          let pass=!found.length;
          if(!pass)return resolve({status,durationMs,pass,setCookies,mismatches:found});
          if(!test.capture)return resolve({status,durationMs,pass,setCookies});
          // Values are kept only for later steps; a missing one fails the step without saying what the response held.
          const captured: Record<string,string>={},typed: Record<string,number|boolean>={};
          for(const [name,spec] of Object.entries(test.capture)){if('cookie' in spec)continue;const value=extract(spec,res.headers,body);if(value===undefined){pass=false;break;}captured[name]=value.text;if(value.typed!==undefined)typed[name]=value.typed;}
          resolve(pass?{status,durationMs,pass,captured,typed,setCookies}:{status,durationMs,pass,setCookies,error:'capture'});
        });
      });
      req.on('error',fail);req.on('timeout',()=>req?.destroy(new Error('Timeout')));req.end(test.body);
    } catch { req?.destroy();fail(); }
  });
}
// `compliance` is the option object for runCompliance (profile, rules, ignore,
// origin, host); absent, the report carries `compliance: null` and readiness
// is unchanged. A compliance verdict is reported beside readiness, never
// folded into it: the exit code decision belongs to the caller.
export function deploymentAdvisories(policies: Record<string, PolicyInventory>, deployment: AuditDeployment = {}): DeploymentAdvisory[] {
  const found: DeploymentAdvisory[] = [];
  // Parsed the way the server parses it, so a malformed list fails here rather than silencing the finding.
  const trusted = compileTrustedProxies(deployment.trustedProxies ?? []).length > 0;
  const clientThrottled = Object.entries(policies).filter(([,policy]) => policy.throttle && policy.throttle.partition !== 'route' && policy.throttle.target !== 'delegated').map(([route]) => route).sort();
  if (clientThrottled.length && !trusted) found.push({ code: 'client-throttle-without-trusted-proxies', routes: clientThrottled,
    message: 'A throttle partitions by client, but no trusted proxies are declared. Behind a load balancer or reverse proxy every caller then resolves to the proxy address and shares one budget. Start the server with --trusted-proxies naming those proxies (and pass the same flag to audit); a server that takes connections directly from clients needs nothing.' });
  if (deployment.metrics) found.push({ code: 'metrics-on-public-listener',
    message: '--metrics serves /_urlcode/metrics on the same listener as public traffic. Block that path at the proxy or network edge, or scrape through a private network path only.' });
  return found;
}
const unique = (items: string[]): string[] => [...new Set(items)].sort();
/**
 * `servedRoutes` holds the routes with at least one covered method; `refusals` maps a route/method key to the passing,
 * asserted cases that answered it with 400 or more.
 */
function coverageNotesFor(unassertedCases: number[], uncovered: { route: string; method: string }[], ignoredWaivers: { route: string }[], metadata: ReadonlyMap<string, RouteInventory>, servedRoutes: ReadonlySet<string>, refusals: ReadonlyMap<string, number[]>): CoverageNote[] {
  const notes: CoverageNote[] = [];
  if (unassertedCases.length) notes.push({ code: 'unasserted-success', cases: unassertedCases,
    message: 'These cases passed with a status below 400 but assert nothing else, so they cover no route: a status alone also matches a catch-all page or a wrong handler. Add expectBody, expectJson or expectHeaders that only the intended response has.' });
  // A route with some covered method is reached (signed in, where gated): what is missing is a method's own success case.
  const partial = uncovered.filter(({ route }) => servedRoutes.has(route));
  if (partial.length) {
    const cases = [...new Set(partial.flatMap(({ route, method }) => refusals.get(JSON.stringify([route, method])) ?? []))].sort((a, b) => a - b);
    notes.push({ code: 'method-without-success', methods: partial.map(({ route, method }) => ({ route, method })), ...(cases.length ? { cases } : {}),
      message: 'Other methods of these routes are covered, so the route is reached (signed in, where it is gated); these methods have no passing case with a status below 400 that asserts the response. A refusal (400 or more) proves only the refusal and covers no method: add a success case for each method listed' + (cases.length ? ' (the listed cases are refusals sent to them)' : '') + ', or, where another fixture exercises one, waive it with coveredElsewhere.' });
  }
  const gated = unique(uncovered.filter(({ route }) => !servedRoutes.has(route) && metadata.get(route)?.gatedBy?.length).map(({ route }) => route));
  if (gated.length) notes.push({ code: 'gated-route-uncovered', routes: gated,
    message: 'These routes are behind a sign-in gate (auth: true) and none of their methods is covered, so no case reached them signed in: an anonymous request only reaches the refusal. Cover them with a steps fixture that signs in through the provider\'s own endpoint (the fixture\'s cookie jar keeps the session, and "origin": "{{origin}}" satisfies the same-origin check), or, where no fixture can sign in, waive the methods with coveredElsewhere and assert the anonymous 401.' });
  const waived = unique(ignoredWaivers.map(({ route }) => route));
  if (waived.length) notes.push({ code: 'waiver-without-proof', routes: waived,
    message: 'A coveredElsewhere waiver counts only once the route is shown to be served: another of its methods covered by a passing, asserted fixture, or, on a sign-in-gated route, a passing 401 fixture with expectBody, expectJson or expectHeaders.' });
  return notes;
}
export async function auditProject(app: AuditableApp, {signals,expectRoutes,log=()=>{},compliance,deployment}: AuditOptions = {}): Promise<AuditReport> {
  const began=performance.now();
  const plan=app.testPlan(), fixtures=await readFixtures(app.root,true);
  // The committed expectation is read only when the caller gave none, so a malformed file cannot hide behind the flag.
  const committed=expectRoutes===undefined?await readAuditExpectation(app.root):undefined;
  const metadata=new Map(plan.inventory.map(r=>[r.path,r]));
  const covered=new Set<string>(), gateRefused=new Set<string>(), refusals=new Map<string,number[]>(), unassertedCases: number[]=[];let passed=0,failed=0,checks=0;
  const agent=new Agent({keepAlive:true,maxSockets:1});
  // One accounting for generated cases and fixture steps, single or ordered: a step counts as
  // a check, and covers a route/method only when it passes and asserts the response. Coverage
  // uses the route the substituted path actually matched.
  const record=(n: number,test: RequestCase,result: HitResult,source: 'generated'|'fixture'): void=>{
    checks++;const method=test.method || 'GET';
    let route: string|undefined;try {route=plan.resolve(test.path);} catch { /* Invalid-path negative fixture. */ }
    const meta=route===undefined?undefined:metadata.get(route);
    // Error-only fixtures cannot prove a function's normal path works.
    const assertsResponse=test.expectBody!==undefined || test.expectJson!==undefined || Object.keys(test.expectHeaders || {}).length>0;
    if(result.pass && meta?.state==='active' && result.status<400 && !assertsResponse)unassertedCases.push(n);
    if(result.pass && assertsResponse && meta?.state==='active' && (result.status<400 || (meta.handler==='respond' && source==='generated')))covered.add(JSON.stringify([route,method]));
    // An asserted 401 on a route a principal gate protects proves the route is served behind that gate (a waiver basis).
    if(result.pass && assertsResponse && meta?.state==='active' && result.status===401 && meta.gatedBy?.length)gateRefused.add(route!);
    // A fixture's asserted refusal covers nothing, but names the method a success case is missing for.
    if(source==='fixture' && result.pass && assertsResponse && meta?.state==='active' && result.status>=400){const pair=JSON.stringify([route,method]);refusals.set(pair,[...(refusals.get(pair) ?? []),n]);}
    if(result.pass)passed++;else failed++;
    log({event:'check',case:n,source,pass:result.pass,status:result.status,expectedStatus:test.status});
  };
  try {
    for (const [i,test] of plan.cases.entries()) record(i+1,test,await hit(app,test,agent),'generated');
    const restart=isRestartable(app)?()=>app.restart():undefined;
    await runFixtures(fixtures,{app,agent,restart,signals},step=>record(step.case,step.test,step.result,'fixture'),plan.cases.length+1);
  } finally {agent.destroy();}
  const key=(route: string,method: string): string=>JSON.stringify([route,method]);
  // HEAD is GET without a body: the runtime strips it for every handler, so a covered GET implies HEAD on the same route.
  const impliedRouteMethods: AuditReport['impliedRouteMethods']=[];
  for(const r of plan.inventory)if(r.state==='active' && r.methods.includes('HEAD') && covered.has(key(r.path,'GET')) && !covered.has(key(r.path,'HEAD')))impliedRouteMethods.push({route:r.path,method:'HEAD',from:'GET'});
  for(const {route} of impliedRouteMethods)covered.add(key(route,'HEAD'));
  const missing=plan.inventory.filter(r=>r.state==='active').flatMap(r=>r.methods.filter(m=>!covered.has(key(r.path,m))).map(method=>({route:r.path,method})));
  const waivedRouteMethods: AuditReport['waivedRouteMethods']=[],ignoredWaivers: AuditReport['ignoredWaivers']=[],redundantWaivers: AuditReport['redundantWaivers']=[];
  const uncovered=missing.filter(({route,method})=>{
    const reason=metadata.get(route)?.coveredElsewhere?.[method];
    if(reason===undefined)return true;
    // A waiver excuses a missing fixture only where the route is shown to be served: another method of it is
    // covered normally, or (for a route no anonymous request can reach) its gate's asserted 401 was observed.
    const basis=[...covered].some(pair=>(JSON.parse(pair) as [string,string])[0]===route)?'route-covered' as const:gateRefused.has(route)?'gate-refusal' as const:undefined;
    if(basis)waivedRouteMethods.push({route,method,reason,basis});else ignoredWaivers.push({route,method,reason});
    return !basis;
  });
  for(const r of plan.inventory)if(r.state==='active')for(const [method,reason] of Object.entries(r.coveredElsewhere??{}))if(covered.has(key(r.path,method)))redundantWaivers.push({route:r.path,method,reason});
  const counts: AuditReport['counts']={configured:plan.inventory.length,declared:plan.inventory.filter(r=>!r.generated).length,generated:plan.inventory.filter(r=>r.generated).length,active:0,disabled:0,expired:0,byHandler:{}};
  for(const route of plan.inventory){counts[route.state]++;const handler=String(route.handler);counts.byHandler[handler]=(counts.byHandler[handler]||0)+1;}
  const expectedRoutesFrom: AuditReport['expectedRoutesFrom']=expectRoutes!==undefined?'--expect-routes':committed!==undefined?auditExpectationFile:null;
  const expected=expectRoutes ?? committed;
  const countMatches=expected===undefined || counts.configured===expected;
  const advisories=plan.inventory.flatMap(route=>(route.advisories??[]).map(message=>({route:route.path,message})));
  const servedRoutes=new Set([...covered].map(pair=>(JSON.parse(pair) as [string,string])[0]));
  const coverageNotes=coverageNotesFor(unassertedCases,uncovered,ignoredWaivers,metadata,servedRoutes,refusals);
  // The per-route capability table: which policies apply and whether this
  // host enforces, compiles or delegates each one. Refusals never get here.
  const notReadyReasons=[...(counts.active>0?[]:['no-active-routes']),...(countMatches?[]:['route-count-mismatch']),...(failed?['failed-checks']:[]),...(uncovered.length?['uncovered-route-methods']:[])];
  return {elapsedMs:performance.now()-began,ready:!notReadyReasons.length,notReadyReasons,counts,expectedRoutes:expected ?? null,expectedRoutesFrom,countMatches,checks,passed,failed,coveredRouteMethods:covered.size,unassertedCases,uncovered,impliedRouteMethods,waivedRouteMethods,ignoredWaivers,redundantWaivers,coverageNotes,policies:plan.policies ?? {},compliance:compliance?await runCompliance(app,compliance):null,advisories,deploymentAdvisories:deploymentAdvisories(plan.policies ?? {},deployment)};
}
