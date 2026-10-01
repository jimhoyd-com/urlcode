import {loadDocument} from './config.ts';
import {prepareFunctionSnapshot} from './policy.ts';
import type {OperatorPolicy} from './policy.ts';
import {loadOperatorHost} from './operator-host.ts';
import type {OperatorHost} from './operator-host.ts';
import {runProjectTests} from './project-tests.ts';
import type {ProjectTestOptions,ProjectTestResult} from './project-tests.ts';
import {localReviewNote,localReviewOrigin} from './cli-command-metadata.ts';

/**
 * The one fixture-execution core behind `urlcode test` and both MCP runners (#1095). `urlcode test` (which MCP
 * `run_test` spawns as a child process) and MCP `run_tests` (in the server process) decide the local review, choose
 * the host's revision pin and replay the fixtures here, so a fix to any of them (#778, #964) reaches both tools. Each
 * adapter keeps what callers depend on: the CLI prints the failing events and the summary and sets the exit status,
 * `run_test` wraps that child's bounded output, and `run_tests` returns the summary with every event.
 */
export interface LocalReview {revision:string;origin:string}

/**
 * The local review rule (#932, #940, #964): with no operator pin (no verified `--policy`, no `PROJECT_SHA256`) one
 * run is pinned to the project's current revision, reads no policy (so no grant exists) and defaults the origin to
 * loopback. An operator pin always wins, so a stale one still refuses. The CLI applies it to every local-review check.
 */
export async function localReviewFor(project:string,{pinned,origin}:{pinned:boolean;origin?:string|undefined}):Promise<LocalReview|undefined> {
 if(pinned||process.env.PROJECT_SHA256)return undefined;
 return {revision:(await prepareFunctionSnapshot(await loadDocument(project))).projectSha256,origin:origin??localReviewOrigin};
}
/** The `local_review` event both the CLI (on stderr) and `run_tests` (in `events`) report. */
export function localReviewEvent(review:LocalReview):{event:'local_review';revision:string;origin:string;note:string} {
 return {event:'local_review',revision:review.revision,origin:review.origin,note:localReviewNote};
}
/** The revision a run's operator host loads under: the verified policy's pin, else the local review's. */
export function hostRevision(policy:OperatorPolicy|undefined,review:LocalReview|undefined):string|undefined {
 return policy?.projectSha256??review?.revision;
}
/** The per-fixture events the CLI adapter prints without --verbose: failures and warnings. `run_tests` returns all of them. */
export function reportedWithoutVerbose(event:object):boolean {
 const {event:kind,pass}=event as {event?:string;pass?:boolean};
 return (kind==='test'&&pass===false)||kind==='warning'||kind==='extension_warning';
}

export interface FixtureRunOptions extends Pick<ProjectTestOptions,'log'|'origin'|'aliasOrigins'> {policy?:OperatorPolicy|undefined;review?:LocalReview|undefined}
/**
 * One fixture run on an operator host that is already loaded (#1112): the host's extensions and its plugins, the
 * verified policy's grants and the operator's alias origins all reach the run from here, so `urlcode test` (and so
 * `run_test`) and `run_tests` cannot replay a fixture against different hooks. A local review's origin replaces the
 * given one. With no host file the host is empty and nothing is added.
 */
export async function runFixturesOnHost(project:string,host:OperatorHost,{policy,review,log,origin,aliasOrigins}:FixtureRunOptions):Promise<ProjectTestResult> {
 return runProjectTests(project,{log,origin:review?.origin??origin,aliasOrigins,extensions:host.extensions,plugins:host.plugins,...(policy?{permissions:policy}:{})});
}

export interface HermeticFixtureOptions extends FixtureRunOptions {hostFile?:string|undefined}
/**
 * One in-process fixture run on its own hermetic host (RIM-EXT-HERMETIC-001): the operator host file, when given, is
 * loaded again on a fresh, empty data directory under the run's revision pin, run through `runFixturesOnHost` and
 * closed afterward, so the run never reads the site's live data or what an earlier run wrote.
 */
export async function runHermeticFixtures(project:string,{hostFile,...options}:HermeticFixtureOptions):Promise<ProjectTestResult> {
 const host=await loadOperatorHost(hostFile,project,{revision:hostRevision(options.policy,options.review),hermetic:true});
 try{return await runFixturesOnHost(project,host,options);}
 finally{await host.close?.();}
}
