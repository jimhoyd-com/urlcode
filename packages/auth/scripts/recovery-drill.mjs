#!/usr/bin/env node
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAuthService} from '../src/auth-core.ts';
import {createBackup,restoreBackup} from '../src/backup.ts';

// This script deliberately accepts no paths, keys, credentials or operator modules.
// Every account, key and database is generated inside one disposable private fixture.
async function drill() {
 const root=await mkdtemp(join(tmpdir(),'urlcode-synthetic-recovery-'));
 const checks=[];
 let live,recovered;
 const check=(/** @type {string} */ name,/** @type {unknown} */ condition)=>{assert.ok(condition,name);checks.push(name);};
 try {
  const projectRoot=join(root,'project');await mkdir(projectRoot,{mode:0o700});
  const database=join(root,'live.sqlite'),snapshot=join(root,'snapshot.sqlite'),restored=join(root,'restored.sqlite');
  const options={database,encryptionKey:randomBytes(32),roles:{member:['site.read'],admin:['*']},defaultRole:'member'};
  const password=randomBytes(32).toString('base64url');
  check('private-fixture-directory',process.platform==='win32'||((await stat(root)).mode&0o777)===0o700);
  live=await createAuthService(options);
  const owner=await live.bootstrapAdmin({email:'owner@example.test',password});
  const member=await live.register({email:'member@example.test',password});
  check('live-account-authenticated',(await live.authenticate(member.token))?.id===member.user.id);
  const backup=await createBackup({database,destination:snapshot,projectRoot});
  check('online-backup-completed',backup.format==='urlcode-auth-sqlite-v1'&&backup.bytes>0);
  check('private-snapshot-file',process.platform==='win32'||((await stat(snapshot)).mode&0o777)===0o600);
  await live.revokeSessions(member.user.id);
  check('live-session-revoked-after-snapshot',await live.authenticate(member.token)===null);
  const laterLogin=await live.login({email:member.user.email,password});
  const laterAccount=await live.register({email:'after-snapshot@example.test',password});
  check('live-writes-continue-after-snapshot',(await live.authenticate(laterLogin.token))?.id===member.user.id);
  await live.close();live=undefined;
  await restoreBackup({backup:snapshot,destination:restored,projectRoot});
  check('private-isolated-restore',restored!==database&&(process.platform==='win32'||((await stat(restored)).mode&0o777)===0o600));
  const refuses = async (/** @type {typeof options} */ candidate) => {
   /** @type {Awaited<ReturnType<typeof createAuthService>> | undefined} */
   let unexpected;
   try {
    await assert.rejects(async()=>{unexpected=await createAuthService(candidate);},{code:'auth_configuration_changed'});
   } finally {await unexpected?.close();}
  };
  await refuses({...options,database:restored,encryptionKey:randomBytes(32)});
  checks.push('wrong-key-fails-closed');
  await refuses({...options,database:restored,roles:{member:['site.read','unexpected.permission'],admin:['*']}});
  checks.push('wrong-configuration-fails-closed');
  recovered=await createAuthService({...options,database:restored});
  check('snapshot-accounts-and-roles-persist',(await recovered.getUser(owner.user.id))?.roles.includes('admin')&&(await recovered.getUser(member.user.id))?.email===member.user.email);
  check('post-snapshot-account-not-restored',await recovered.getUser(laterAccount.user.id)===null);
  check('post-snapshot-session-not-restored',await recovered.authenticate(laterLogin.token)===null);
  // A restored snapshot predates the live revocation. This is an expected hazard,
  // not evidence that old cookies are safe to expose on a restored public host.
  check('snapshot-can-revive-later-revoked-session',(await recovered.authenticate(member.token))?.id===member.user.id);
  await recovered.close();recovered=undefined;
  recovered=await createAuthService({...options,database:restored});
  check('restored-service-reopens',(await recovered.authenticate(owner.token))?.id===owner.user.id);
  const fresh=await recovered.login({email:member.user.email,password});
  check('restored-password-authenticates',fresh.user.id===member.user.id);
  // This fixture has exactly two snapshot accounts. Production procedures must
  // traverse every page and additionally account for all reusable token types.
  const accounts=await recovered.listUsers({limit:100});
  assert.equal(accounts.next,undefined);assert.equal(accounts.users.length,2);
  for(const account of accounts.users)await recovered.revokeSessions(account.id);
  check('explicit-restore-session-revocation',await recovered.authenticate(owner.token)===null&&await recovered.authenticate(member.token)===null&&await recovered.authenticate(fresh.token)===null);
  await recovered.close();recovered=undefined;
  recovered=await createAuthService({...options,database:restored});
  check('session-revocation-survives-reopen',await recovered.authenticate(owner.token)===null&&await recovered.authenticate(member.token)===null&&await recovered.authenticate(fresh.token)===null);
  check('account-survives-revocation',(await recovered.login({email:member.user.email,password})).user.id===member.user.id);
  return {kind:'urlcode-auth-synthetic-recovery-drill',passed:true,checks,node:process.versions.node,sqlite:process.versions.sqlite,scope:'isolated synthetic SQLite snapshot; not production disaster recovery or an RTO/RPO measurement'};
 } finally {
  try {await recovered?.close();} finally {try {await live?.close();} finally {await rm(root,{recursive:true,force:true});}}
 }
}
// No top-level await: the drill opens and closes store worker threads, and this module's evaluation must not
// still be settling while they are torn down (#708).
function failed() {
 // Never print exception objects: assertions/service errors could contain fixture
 // state. A failing drill has no legitimate need to emit keys or capabilities.
 process.stderr.write('Synthetic recovery drill failed. It accepts no arguments; inspect the reviewed script and run the regression suite.\n');
 process.exitCode=1;
}
if(process.argv.length!==2)failed();
else drill().then(result=>{process.stdout.write(JSON.stringify(result,null,2)+'\n');}).catch(failed);
