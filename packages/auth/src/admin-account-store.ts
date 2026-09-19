import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {AuthRecord,SessionRecord} from './auth-store.ts';
import type {AdminAccountAction,AdminAccountDelivery} from './admin-account-operations.ts';
interface Context {db:DatabaseSync;now:number;deletionGraceMs:number;roles:Record<string,string[]>;account(id:string):AuthRecord|null;fresh(hash:string,now:number):{user:AuthRecord;session:SessionRecord};isRestricted(user:AuthRecord):boolean;save(user:AuthRecord):void;audit(actor:string,action:string,subject:string,now:number,reason?:string):void;fail(status:number,code:string):never}
interface Plan {actorId:string;actorVersion:number;action:AdminAccountAction;reason:string;parameters:{roles?:string[];email?:string;credentialId?:string;externalId?:string};targets:{id:string;version:number;primaryHash:string;secondaryHash:string}[]}
const externalId=(provider:string,subject:string)=>createHash('sha256').update(provider+'\0'+subject).digest('hex');
/** All calls are inside the existing store revision/active-key checked transaction. */
export function adminAccountOperation(operation:string,args:Record<string,unknown>,context:Context):{value:unknown}|undefined{
 if(!operation.startsWith('adminAccount'))return;
 const {db,now}=context,fail:(status:number,code:string)=>never=context.fail;
 const permissions=(roles:string[])=>[...new Set(roles.flatMap(role=>context.roles[role]??[]))];
 const administrator=(user:AuthRecord)=>permissions(user.roles).includes('*');
 const authorize=(actor:AuthRecord,target:AuthRecord,permission:string,nextRoles?:string[])=>{
  const granted=permissions(actor.roles);if(context.isRestricted(actor)||!granted.includes('*')&&!granted.includes(permission))fail(403,'permission_denied');if(actor.id===target.id)fail(403,'self_administration_denied');
  for(const permission of [...permissions(target.roles),...permissions(nextRoles??target.roles)])if(!granted.includes('*')&&!granted.includes(permission))fail(403,'delegation_ceiling_exceeded');
 };
 const activity=(kind:string,id:string)=>{const row=db.prepare('SELECT added,last_used FROM auth_method_activity WHERE kind=? AND method_id=?').get(kind,id);return {...(typeof row?.added==='number'?{added:row.added}:{}),...(typeof row?.last_used==='number'?{lastUsed:row.last_used}:{})};};
 const identities=(id:string)=>db.prepare('SELECT provider,subject FROM auth_external WHERE account_id=? LIMIT 16').all(id).map(row=>({provider:String(row.provider),subject:String(row.subject),id:externalId(String(row.provider),String(row.subject))}));
 const validate=(actor:AuthRecord,plan:Plan)=>{
  const targets=plan.targets.map(entry=>{const user=context.account(entry.id);if(!user)fail(404,'account_not_found');if(user.version!==entry.version)fail(409,'account_changed');authorize(actor,user,'auth.users.manage',plan.parameters.roles);
   if(plan.action==='cancel-deletion'){if(user.status!=='pending-delete'||!user.deleteAfter||user.deleteAfter<=now)fail(409,'deletion_unavailable');}
   else if(user.status==='pending-delete')fail(409,'account_pending_deletion');
   if(['force-password-reset','resend-verification','request-email-change'].includes(plan.action)&&user.status!=='active')fail(409,'account_not_active');
   if(plan.action==='resend-verification'&&user.emailVerified)fail(409,'email_already_verified');
   if(plan.action==='remove-passkey'){
    if(!db.prepare('SELECT id FROM auth_passkeys WHERE id=? AND account_id=?').get(plan.parameters.credentialId!,user.id))fail(404,'method_not_found');
    if(user.mfaPasskeys?.includes(plan.parameters.credentialId!))fail(409,'factor_reset_case_required');
    if(!user.passwordHash&&identities(user.id).length===0&&Number(db.prepare('SELECT count(*) AS n FROM auth_passkeys WHERE account_id=?').get(user.id)?.n)<=1)fail(409,'last_sign_in_method');
   }
   if(plan.action==='remove-external'){
    const methods=identities(user.id);if(!methods.some(method=>method.id===plan.parameters.externalId))fail(404,'method_not_found');
    if(!user.passwordHash&&methods.length<=1&&Number(db.prepare('SELECT count(*) AS n FROM auth_passkeys WHERE account_id=?').get(user.id)?.n)===0)fail(409,'last_sign_in_method');
   }
   if(['remove-passkey','remove-external'].includes(plan.action)&&!user.passwordHash&&!user.totpSecret&&user.mfaPasskeys?.length){
    const remainingKeys=db.prepare('SELECT id FROM auth_passkeys WHERE account_id=?').all(user.id).map(row=>String(row.id)).filter(id=>plan.action!=='remove-passkey'||id!==plan.parameters.credentialId);
    const remainingExternal=identities(user.id).filter(method=>plan.action!=='remove-external'||method.id!==plan.parameters.externalId);
    if(!remainingExternal.length&&!remainingKeys.some(primary=>user.mfaPasskeys!.some(factor=>factor!==primary&&remainingKeys.includes(factor))))fail(409,'last_sign_in_method');
   }
   if(plan.action==='request-email-change'){
    if(user.email===plan.parameters.email)fail(400,'email_unchanged');if(db.prepare('SELECT id FROM auth_accounts WHERE email=?').get(plan.parameters.email!))fail(409,'email_unavailable');if(db.prepare('SELECT account_id FROM auth_email_changes WHERE account_id=? AND expires>?').get(user.id,now))fail(409,'email_change_pending');
   }
   return user;
  });
  const disabling=(user:AuthRecord)=>['schedule-deletion','force-password-reset'].includes(plan.action)||plan.action==='assign-roles'&&!permissions(plan.parameters.roles!).includes('*');
  if(targets.some(user=>administrator(user)&&user.status==='active'&&!context.isRestricted(user)&&disabling(user))){
   const disabled=new Set(targets.filter(disabling).map(user=>user.id));const remaining=db.prepare("SELECT data FROM auth_accounts WHERE administrator=1 AND status='active'").all().some(row=>{const user=JSON.parse(String(row.data)) as AuthRecord;return !disabled.has(user.id)&&!context.isRestricted(user);});if(!remaining)fail(409,'last_administrator_required');
  }
  return targets;
 };
 const revoke=(id:string)=>{for(const table of ['auth_sessions','auth_tokens','auth_email_codes','auth_email_changes','auth_factor_recovery','auth_second_factor_proofs','auth_trusted_devices','auth_manual_recovery'])db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(id);};
 if(operation==='adminAccountInspect'){
  const actor=context.fresh(String(args.hash),now).user,target=context.account(String(args.accountId));if(!target)fail(404,'account_not_found');authorize(actor,target,'auth.users.read');context.audit(actor.id,'admin.authentication_inspected',target.id,now,String(args.reason));
  return {value:{accountId:target.id,password:!!target.passwordHash,totp:!!target.totpSecret,passkeys:db.prepare('SELECT id FROM auth_passkeys WHERE account_id=? LIMIT 16').all(target.id).map(row=>({id:String(row.id),...activity('passkey',String(row.id)),secondFactor:target.mfaPasskeys?.includes(String(row.id))??false})),external:identities(target.id).map(({id,provider,subject})=>({id,provider,...activity('oidc',provider+'\0'+subject)}))}};
 }
 if(operation==='adminAccountStage'){
  const actor=context.fresh(String(args.hash),now).user,targets=(args.accountIds as string[]).map(id=>{const user=context.account(id);if(!user)fail(404,'account_not_found');const tokens=(args.tokens as {accountId:string;primaryHash:string;secondaryHash:string}[]).find(item=>item.accountId===id)!;return {id,version:user.version,primaryHash:tokens.primaryHash,secondaryHash:tokens.secondaryHash};});
  const plan:Plan={actorId:actor.id,actorVersion:actor.version,action:args.action as AdminAccountAction,reason:String(args.reason),parameters:args.parameters as Plan['parameters'],targets};const users=validate(actor,plan);
  db.prepare('DELETE FROM auth_admin_operations WHERE expires<=?').run(now);if(Number(db.prepare('SELECT count(*) AS n FROM auth_admin_operations').get()?.n)>=1000)fail(503,'auth_capacity_reached');
  db.prepare('INSERT INTO auth_admin_operations(id,data,expires) VALUES(?,?,?)').run(String(args.operationId),JSON.stringify(plan),now+300000);
  const deliveries:unknown[]=[];for(const user of users){
   const base={accountId:user.id,email:user.email,...(user.profile?.locale?{locale:user.profile.locale}:{})};
   if(['remove-passkey','remove-external'].includes(plan.action)&&!user.passwordHash&&!user.totpSecret&&user.mfaPasskeys?.length){
    const remainingKeys=db.prepare('SELECT id FROM auth_passkeys WHERE account_id=?').all(user.id).map(row=>String(row.id)).filter(id=>plan.action!=='remove-passkey'||id!==plan.parameters.credentialId);
    const remainingExternal=identities(user.id).filter(method=>plan.action!=='remove-external'||method.id!==plan.parameters.externalId);
    if(!remainingExternal.length&&!remainingKeys.some(primary=>user.mfaPasskeys!.some(factor=>factor!==primary&&remainingKeys.includes(factor))))fail(409,'last_sign_in_method');
   }
   if(plan.action==='request-email-change'){deliveries.push({...base,kind:'token',purpose:'cancel-email-change',tokenSlot:'secondary'},{...base,email:plan.parameters.email,kind:'token',purpose:'verify-email-change',tokenSlot:'primary'});}
   else if(['force-password-reset','resend-verification','schedule-deletion'].includes(plan.action))deliveries.push({...base,kind:'token',purpose:plan.action==='force-password-reset'?'reset-password':plan.action==='resend-verification'?'verify-email':'cancel-deletion',tokenSlot:'primary'});
   else deliveries.push({...base,kind:'notice',action:plan.action} satisfies AdminAccountDelivery);
   context.audit(actor.id,'admin.'+plan.action+'.staged',user.id,now,plan.reason);
  }
  return {value:{operationId:String(args.operationId),deliveries}};
 }
 if(operation==='adminAccountComplete'||operation==='adminAccountCancel'){
  const actor=context.fresh(String(args.hash),now).user,row=db.prepare('SELECT data FROM auth_admin_operations WHERE id=? AND expires>?').get(String(args.operationId),now);if(!row)fail(409,'administration_unavailable');const plan=JSON.parse(String(row.data)) as Plan;if(plan.actorId!==actor.id||plan.actorVersion!==actor.version)fail(409,'administration_actor_changed');
  if(operation==='adminAccountCancel'){db.prepare('DELETE FROM auth_admin_operations WHERE id=?').run(String(args.operationId));for(const target of plan.targets)context.audit(actor.id,'admin.'+plan.action+'.cancelled',target.id,now,plan.reason);return {value:undefined};}
  const users=validate(actor,plan);
  for(const user of users){const tokens=plan.targets.find(target=>target.id===user.id)!;
   if(!['resend-verification','request-email-change'].includes(plan.action)){user.version++;revoke(user.id);}
   switch(plan.action){
    case 'verify-email':user.emailVerified=true;break;
    case 'force-password-reset':user.passwordHash='';db.prepare("INSERT INTO auth_tokens VALUES(?,?,'reset-password',?,?)").run(tokens.primaryHash,user.id,now+1800000,user.version);break;
    case 'schedule-deletion':user.status='pending-delete';user.deleteAfter=now+context.deletionGraceMs;db.prepare("INSERT INTO auth_tokens VALUES(?,?,'cancel-deletion',?,?)").run(tokens.primaryHash,user.id,user.deleteAfter,user.version);break;
    case 'cancel-deletion':user.status='active';delete user.deleteAfter;break;
    case 'remove-passkey':db.prepare("DELETE FROM auth_method_activity WHERE kind='passkey' AND method_id=? AND account_id=?").run(plan.parameters.credentialId!,user.id);db.prepare('DELETE FROM auth_passkeys WHERE id=? AND account_id=?').run(plan.parameters.credentialId!,user.id);break;
    case 'remove-external':{const method=identities(user.id).find(item=>item.id===plan.parameters.externalId)!;db.prepare('DELETE FROM auth_external WHERE provider=? AND subject=? AND account_id=?').run(method.provider,method.subject,user.id);db.prepare("DELETE FROM auth_method_activity WHERE kind='oidc' AND method_id=? AND account_id=?").run(method.provider+'\0'+method.subject,user.id);break;}
    case 'assign-roles':user.roles=plan.parameters.roles!;break;
    case 'resend-verification':db.prepare("DELETE FROM auth_tokens WHERE account_id=? AND purpose='verify-email'").run(user.id);db.prepare("INSERT INTO auth_tokens VALUES(?,?,'verify-email',?,?)").run(tokens.primaryHash,user.id,now+1800000,user.version);break;
    case 'request-email-change':db.prepare('DELETE FROM auth_email_changes WHERE account_id=?').run(user.id);db.prepare('INSERT INTO auth_email_changes VALUES(?,?,?,?,?,?,?)').run(user.id,plan.parameters.email!,tokens.primaryHash,tokens.secondaryHash,now+86400000,now+172800000,user.version);break;
   }
   context.save(user);context.audit(actor.id,'admin.'+plan.action,user.id,now,plan.reason);
  }
  db.prepare('DELETE FROM auth_admin_operations WHERE id=?').run(String(args.operationId));return {value:{affected:users.length}};
 }
 return;
}
