import type {DatabaseSync} from 'node:sqlite';
import type {AuthRecord,SessionRecord} from './auth-store.ts';
import type {ManualRecoveryCase} from './manual-recovery.ts';
interface Context {
 db:DatabaseSync;enabled:boolean;now:number;
 account(id:string):AuthRecord|null;active(id:string):AuthRecord;
 fresh(hash:string,now:number):{user:AuthRecord;session:SessionRecord};
 authorizeCase(actor:AuthRecord,target:AuthRecord):void;
 save(user:AuthRecord):void;addSession(session:SessionRecord):void;
 audit(actor:string,action:string,subject:string,now:number,reason?:string):void;
 isAdministrator(user:AuthRecord):boolean;isRestricted(user:AuthRecord):boolean;
 fail(status:number,code:string):never;
}
/** Called only inside the store's revision-checked BEGIN IMMEDIATE dispatch. */
export function manualRecoveryOperation(operation:string,args:Record<string,unknown>,context:Context):{value:unknown}|undefined {
 if(!operation.startsWith('manualRecovery'))return;
 const {db,now}=context;const fail:(status:number,code:string)=>never=context.fail;if(!context.enabled)fail(403,'manual_recovery_disabled');
 const rowCase=(id:string)=>{const row=db.prepare('SELECT data FROM auth_cases WHERE id=?').get(id);if(!row)fail(404,'case_not_found');const item=JSON.parse(String(row.data)) as ManualRecoveryCase;if(item.action!=='restore-access')fail(400,'invalid_recovery_case');return item;};
 const saveCase=(item:ManualRecoveryCase)=>db.prepare('UPDATE auth_cases SET data=? WHERE id=?').run(JSON.stringify(item),item.id);
 const availableEmail=(email:string,accountId:string)=>{const row=db.prepare('SELECT id FROM auth_accounts WHERE email=?').get(email);if(row&&row.id!==accountId)fail(409,'email_unavailable');};
 const targetFor=(item:ManualRecoveryCase)=>{const target=context.account(item.accountId);if(!target||target.version!==item.targetVersion)fail(409,'case_target_changed');return target;};
 const authorize=(item:ManualRecoveryCase,target:AuthRecord)=>{context.authorizeCase(context.active(item.makerId),target);if(item.approverId)context.authorizeCase(context.active(item.approverId),target);};
 switch(operation){
 case 'manualRecoveryCreate':{
  const maker=context.fresh(String(args.hash),now).user,target=context.account(String(args.accountId));if(!target)fail(404,'account_not_found');context.authorizeCase(maker,target);
  availableEmail(String(args.email),target.id);
  if(Number(db.prepare('SELECT count(*) AS n FROM auth_cases').get()?.n)>=10000)fail(503,'auth_capacity_reached');
  const item:ManualRecoveryCase={id:String(args.id),accountId:target.id,action:'restore-access',reason:String(args.reason),makerId:maker.id,status:'pending',created:now,expires:now+86400000,targetVersion:target.version,recovery:{email:String(args.email),evidence:args.evidence as ManualRecoveryCase['recovery']['evidence'],state:'review'}};
  db.prepare('INSERT INTO auth_cases(id,data) VALUES(?,?)').run(item.id,JSON.stringify(item));context.audit(maker.id,'recovery.case_created',target.id,now,item.reason);return {value:item};
 }
 case 'manualRecoveryList':return {value:db.prepare("SELECT data FROM auth_cases WHERE id>? AND json_extract(data,'$.action')='restore-access' ORDER BY id LIMIT ?").all(String(args.after),Number(args.limit)).map(row=>JSON.parse(String(row.data)))};
 case 'manualRecoveryCheck':{const credential=db.prepare('SELECT * FROM auth_manual_recovery WHERE hash=? AND active=1 AND expires>?').get(String(args.tokenHash),now);if(!credential)fail(401,'invalid_recovery');const item=rowCase(String(credential.case_id)),target=targetFor(item);authorize(item,target);return {value:undefined};}
 case 'manualRecoveryApprove':{
  const checker=context.fresh(String(args.hash),now).user,item=rowCase(String(args.id));if(item.status!=='pending'||item.expires<=now)fail(409,'case_unavailable');if(item.makerId===checker.id)fail(403,'distinct_approver_required');
  const target=targetFor(item);authorize(item,target);context.authorizeCase(checker,target);availableEmail(item.recovery.email,target.id);
  db.prepare('INSERT INTO auth_manual_recovery(hash,case_id,account_id,version,approver_id,maker_version,approver_version,active,expires) VALUES(?,?,?,?,?,?,?,0,?)').run(String(args.tokenHash),item.id,target.id,target.version,checker.id,context.active(item.makerId).version,checker.version,now+1800000);
  item.status='applied';item.approverId=checker.id;item.recovery.state='delivery';saveCase(item);context.audit(checker.id,'recovery.case_approved',target.id,now,String(args.reason));return {value:{case:item,email:item.recovery.email,oldEmail:target.email}};
 }
 case 'manualRecoveryActivate':case 'manualRecoveryCancel':{
  const checker=context.fresh(String(args.hash),now).user,item=rowCase(String(args.id)),credential=db.prepare('SELECT * FROM auth_manual_recovery WHERE hash=? AND case_id=?').get(String(args.tokenHash),item.id);
  if(!credential||credential.approver_id!==checker.id||item.approverId!==checker.id)fail(409,'recovery_unavailable');
  if(operation==='manualRecoveryCancel'){db.prepare('DELETE FROM auth_manual_recovery WHERE case_id=?').run(item.id);item.recovery.state='cancelled';item.status='closed';saveCase(item);context.audit(checker.id,'recovery.delivery_cancelled',item.accountId,now);return {value:undefined};}
  if(Number(credential.expires)<=now||credential.active!==0||item.recovery.state!=='delivery')fail(409,'recovery_unavailable');
  const target=targetFor(item);authorize(item,target);if(context.active(item.makerId).version!==credential.maker_version||checker.version!==credential.approver_version)fail(409,'recovery_approval_changed');availableEmail(item.recovery.email,target.id);
  db.prepare('UPDATE auth_manual_recovery SET active=1 WHERE hash=?').run(String(args.tokenHash));item.recovery.state='ready';saveCase(item);context.audit(checker.id,'recovery.delivery_confirmed',item.accountId,now);return {value:undefined};
 }
 case 'manualRecoveryRedeem':{
  const credential=db.prepare('SELECT * FROM auth_manual_recovery WHERE hash=? AND active=1 AND expires>?').get(String(args.tokenHash),now);if(!credential)fail(401,'invalid_recovery');
  const item=rowCase(String(credential.case_id));if(item.recovery.state!=='ready')fail(401,'invalid_recovery');const target=targetFor(item);authorize(item,target);if(context.active(item.makerId).version!==credential.maker_version||context.active(item.approverId!).version!==credential.approver_version)fail(409,'recovery_approval_changed');availableEmail(item.recovery.email,target.id);
  if(context.isAdministrator(target)&&!db.prepare("SELECT data FROM auth_accounts WHERE administrator=1 AND status='active' AND id<>?").all(target.id).some(row=>!context.isRestricted(JSON.parse(String(row.data)) as AuthRecord)))fail(409,'last_administrator_required');
  target.email=item.recovery.email;target.emailVerified=true;target.passwordHash=String(args.passwordHash);target.status='active';target.mfaRecoveryRequired=true;target.version++;
  delete target.totpSecret;delete target.totpPending;delete target.totpPendingUntil;delete target.mfaPasskeys;target.totpCounter=-1;
  db.prepare('UPDATE auth_accounts SET email=? WHERE id=?').run(target.email,target.id);context.save(target);
  for(const table of ['auth_sessions','auth_tokens','auth_recovery','auth_method_activity','auth_passkeys','auth_external','auth_email_codes','auth_email_changes','auth_factor_recovery','auth_second_factor_proofs','auth_trusted_devices','auth_manual_recovery'])db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(target.id);
  const session=args.session as SessionRecord;session.accountId=target.id;session.recoveryEnrollment=1;session.primaryMethod='recovery';session.mfaAuthenticatedAt=0;session.mfaVersion=0;context.addSession(session);
  item.recovery.state='redeemed';saveCase(item);context.audit(target.id,'recovery.access_restored',target.id,now,item.id);return {value:target};
 }
 default:return;
 }
}
