import { readFile, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseSafeReleaseTrain, safeReleaseTrainTag } from '../packages/core/src/release-train.ts';

const execFile=promisify(execFileCallback);
const bundleTag=/^extension-bundles@v[0-9][0-9A-Za-z._-]{0,100}$/;
const artifactTag=/^extensions@v[0-9][0-9A-Za-z._-]{0,100}$/;
const commit=/^[a-f0-9]{40}$/;
const version=/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
function fail(condition:unknown,message:string):asserts condition { if(!condition)throw new Error(message); }
interface Inputs { coreVersion:string; bundleRelease:string; bundleCommit:string; artifactRelease:string; artifactCommit:string; }
function inputs(env:NodeJS.ProcessEnv):Inputs {
  const result={coreVersion:env.CORE_VERSION??'',bundleRelease:env.BUNDLE_RELEASE??'',bundleCommit:env.BUNDLE_COMMIT??'',artifactRelease:env.ARTIFACT_RELEASE??'',artifactCommit:env.ARTIFACT_COMMIT??''};
  fail(version.test(result.coreVersion),'CORE_VERSION must be an exact semantic version');
  fail(bundleTag.test(result.bundleRelease)&&commit.test(result.bundleCommit),'BUNDLE_RELEASE and BUNDLE_COMMIT must be immutable extension-bundle pins');
  fail(artifactTag.test(result.artifactRelease)&&commit.test(result.artifactCommit),'ARTIFACT_RELEASE and ARTIFACT_COMMIT must be immutable artifact pins');
  fail(result.bundleRelease===`extension-bundles@v${result.coreVersion}`,'BUNDLE_RELEASE must match CORE_VERSION');
  return result;
}
function payload(tag:string,sourceCommit:string,input:Inputs):Buffer { return Buffer.from(JSON.stringify({format:1,tag,commit:sourceCommit,sequence:1,coreVersion:input.coreVersion,extensionBundles:{tag:input.bundleRelease,commit:input.bundleCommit,coreVersion:input.coreVersion},artifacts:{tag:input.artifactRelease,commit:input.artifactCommit}},null,2)+'\n'); }
async function command(program:string,args:string[]):Promise<string>{return (await execFile(program,args,{encoding:'utf8'})).stdout.trim();}
async function tag(input:Inputs):Promise<void>{
  fail(process.env.GITHUB_REF_TYPE==='branch'&&process.env.GITHUB_REF==='refs/heads/main','Release-train tag dispatches must run from refs/heads/main');
  const release=safeReleaseTrainTag(input.coreVersion),repository=process.env.GITHUB_REPOSITORY??'',sha=process.env.GITHUB_SHA??'';
  fail(commit.test(sha)&&repository.length>0,'GITHUB_SHA and GITHUB_REPOSITORY are required');
  let published=false;
  try { await command('gh',['release','view',release]); published=true; } catch { /* absent release is expected for a new immutable tag */ }
  fail(!published,`Release already exists: ${release}`);
  await command('gh',['api','--method','POST',`repos/${repository}/git/refs`,'-f',`ref=refs/tags/${release}`,'-f',`sha=${sha}`]);
  await command('gh',['workflow','run','release-train.yml','--ref',release,'-f',`core_version=${input.coreVersion}`,'-f',`bundle_release=${input.bundleRelease}`,'-f',`bundle_commit=${input.bundleCommit}`,'-f',`artifact_release=${input.artifactRelease}`,'-f',`artifact_commit=${input.artifactCommit}`]);
}
async function main():Promise<void>{
  const operation=process.argv[2],input=inputs(process.env),release=safeReleaseTrainTag(input.coreVersion);
  const manifest=JSON.parse(await readFile('package.json','utf8')) as {version?:unknown};
  fail(manifest.version===input.coreVersion,'CORE_VERSION must match the tagged core package version');
  if(operation==='tag'){await tag(input);return;}
  fail(operation==='build'||operation==='validate','Use tag, build or validate');
  const sha=process.env.GITHUB_SHA,output=process.env.OUTPUT;
  fail(process.env.GITHUB_REF_TYPE==='tag'&&process.env.GITHUB_REF_NAME===release&&typeof sha==='string'&&commit.test(sha),'Release train publication must run on its exact immutable tag');
  fail(typeof output==='string'&&output.length>0,'OUTPUT is required');
  if(operation==='build'){await writeFile(output,payload(release,sha,input),{flag:'wx'});return;}
  const bytes=await readFile(output);parseSafeReleaseTrain(bytes,release);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
