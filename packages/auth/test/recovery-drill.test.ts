import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {devConditionArgs} from './support/conditions.ts';
const execute=promisify(execFile);
const script=fileURLToPath(new URL('../scripts/recovery-drill.mjs',import.meta.url));
test('operator recovery drill proves snapshot boundaries and persistent session revocation without emitting capabilities',async()=>{
 const {stdout,stderr}=await execute(process.execPath,[...devConditionArgs,script],{timeout:30000,maxBuffer:65536,env:{...process.env,NODE_OPTIONS:'',NODE_NO_WARNINGS:'1'}});
 assert.equal(stderr,'');
 const result=JSON.parse(stdout);
 assert.deepEqual(Object.keys(result).sort(),['checks','kind','node','passed','scope','sqlite']);
 assert.equal(result.kind,'urlcode-auth-synthetic-recovery-drill');assert.equal(result.passed,true);
 assert.equal(result.checks.length,18);assert.equal(new Set(result.checks).size,18);
 for(const name of ['online-backup-completed','wrong-key-fails-closed','wrong-configuration-fails-closed','post-snapshot-account-not-restored','snapshot-can-revive-later-revoked-session','session-revocation-survives-reopen'])assert.ok(result.checks.includes(name));
 assert.doesNotMatch(stdout,/@example\.test|(?:\/private)?\/tmp\/|encryptionKey|passwordHash|__Host-|[A-Za-z0-9_-]{43}/);
 assert.match(result.scope,/not production disaster recovery/);
});
test('operator recovery drill refuses paths and credentials rather than touching caller data',async()=>{
 await assert.rejects(execute(process.execPath,[...devConditionArgs,script,'--database','do-not-open.sqlite'],{timeout:10000,maxBuffer:65536,env:{...process.env,NODE_OPTIONS:'',NODE_NO_WARNINGS:'1'}}),(error:unknown)=>{
  assert.ok(error&&typeof error==='object'&&'stdout'in error&&'stderr'in error&&'code'in error);
  assert.equal(error.code,1);assert.equal(error.stdout,'');
  assert.equal(error.stderr,'Synthetic recovery drill failed. It accepts no arguments; inspect the reviewed script and run the regression suite.\n');
  return true;
 });
});
