import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {AuthError} from './auth-store.ts';
import type {AuthStore} from './auth-store.ts';
export type AdminAccountAction='verify-email'|'force-password-reset'|'schedule-deletion'|'cancel-deletion'|'remove-passkey'|'remove-external'|'request-email-change'|'assign-roles'|'resend-verification';
export type AdminAccountDelivery={kind:'token';accountId:string;email:string;locale?:string;purpose:'verify-email'|'reset-password'|'cancel-deletion'|'verify-email-change'|'cancel-email-change';token:string}|{kind:'notice';accountId:string;email:string;locale?:string;action:AdminAccountAction};
export type AdminAccountRequest={actorToken:string;accountIds:string[];reason:string}&(
 {action:'assign-roles';roles:string[]}|{action:'request-email-change';email:string}|{action:'remove-passkey';credentialId:string}|{action:'remove-external';externalId:string}|{action:'verify-email'|'force-password-reset'|'schedule-deletion'|'cancel-deletion'|'resend-verification'});
export interface AdminAuthenticationMethods {accountId:string;password:boolean;totp:boolean;passkeys:{id:string;secondFactor:boolean;added?:number;lastUsed?:number}[];external:{id:string;provider:string;added?:number;lastUsed?:number}[]}
export interface AdminAccountService {
 inspectAccountAuthentication(input:{actorToken:string;accountId:string;reason:string}):Promise<AdminAuthenticationMethods>;
 stageAccountAdministration(input:AdminAccountRequest):Promise<{operationId:string;deliveries:AdminAccountDelivery[]}>;
 completeAccountAdministration(input:{actorToken:string;operationId:string}):Promise<{affected:number}>;
 cancelAccountAdministration(input:{actorToken:string;operationId:string}):Promise<void>;
}
interface Dependencies {store:AuthStore;check():void;now():number;roles:Record<string,string[]>;permittedEmail(value:string):string}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const valid=(value:unknown,max:number)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
/** Operator-side service. Only declared delivery callbacks receive staged tokens. */
export function createAdminAccountOperations(deps:Dependencies):AdminAccountService {
 const fail=()=>{throw new AuthError(400,'invalid_administration');};
 const actor=(value:string)=>{deps.check();if(!/^[A-Za-z0-9_-]{43}$/.test(value))fail();return hash(value);};
 const reason=(value:string)=>{if(!valid(value,256)||!value.trim())fail();return value.trim();};
 return {
  async inspectAccountAuthentication(input){const actorHash=actor(input.actorToken);if(!valid(input.accountId,256))fail();return deps.store.call('adminAccountInspect',{hash:actorHash,accountId:input.accountId,reason:reason(input.reason),now:deps.now()});},
  async stageAccountAdministration(input){
   const actorHash=actor(input.actorToken),why=reason(input.reason);if(!Array.isArray(input.accountIds)||input.accountIds.length<1||input.accountIds.length>50||new Set(input.accountIds).size!==input.accountIds.length||input.accountIds.some(value=>!valid(value,256)))fail();
   if(!['verify-email','force-password-reset','schedule-deletion','cancel-deletion','remove-passkey','remove-external','request-email-change','assign-roles','resend-verification'].includes(input.action))fail();
   if(input.accountIds.length>1&&!['assign-roles','resend-verification'].includes(input.action))fail();
   const parameters:Record<string,unknown>={};
   if(input.action==='assign-roles'){if(!Array.isArray(input.roles)||input.roles.length<1||input.roles.length>32||new Set(input.roles).size!==input.roles.length||input.roles.some(value=>!Object.hasOwn(deps.roles,value)))fail();parameters.roles=[...input.roles];}
   if(input.action==='request-email-change')parameters.email=deps.permittedEmail(input.email);
   if(input.action==='remove-passkey'){if(!valid(input.credentialId,1024))fail();parameters.credentialId=input.credentialId;}
   if(input.action==='remove-external'){if(!/^[a-f0-9]{64}$/.test(input.externalId))fail();parameters.externalId=input.externalId;}
   const raw=new Map(input.accountIds.map(id=>[id,{primary:randomBytes(32).toString('base64url'),secondary:randomBytes(32).toString('base64url')}]));
   type PlannedDelivery=Exclude<AdminAccountDelivery,{kind:'token'}>|(Omit<Extract<AdminAccountDelivery,{kind:'token'}>,'token'>&{tokenSlot:'primary'|'secondary'});
   const result=await deps.store.call<{operationId:string;deliveries:PlannedDelivery[]}>('adminAccountStage',{hash:actorHash,operationId:randomUUID(),accountIds:input.accountIds,action:input.action,reason:why,parameters,tokens:input.accountIds.map(accountId=>({accountId,primaryHash:hash(raw.get(accountId)!.primary),secondaryHash:hash(raw.get(accountId)!.secondary)})),now:deps.now()});
   return {operationId:result.operationId,deliveries:result.deliveries.map(delivery=>delivery.kind==='notice'?delivery:{kind:'token',accountId:delivery.accountId,email:delivery.email,...(delivery.locale?{locale:delivery.locale}:{}),purpose:delivery.purpose,token:raw.get(delivery.accountId)![delivery.tokenSlot]})};
  },
  async completeAccountAdministration(input){const actorHash=actor(input.actorToken);if(!valid(input.operationId,256))fail();return deps.store.call('adminAccountComplete',{hash:actorHash,operationId:input.operationId,now:deps.now()});},
  async cancelAccountAdministration(input){const actorHash=actor(input.actorToken);if(!valid(input.operationId,256))fail();await deps.store.call('adminAccountCancel',{hash:actorHash,operationId:input.operationId,now:deps.now()});},
 };
}
