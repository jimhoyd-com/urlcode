import {createHash} from 'node:crypto';
interface VelocityLimit {limit:number;windowMs:number}
export interface AuthAbuseOptions {
 passwordBackoff?:{threshold?:number;initialDelayMs?:number;maxDelayMs?:number;resetAfterMs?:number};
 client?:VelocityLimit;signupClient?:VelocityLimit;signupDomain?:VelocityLimit;challengeAfter?:number;
}
export interface AuthAbusePolicy extends Omit<AuthAbuseOptions,'passwordBackoff'> {
 passwordBackoff?:{threshold:number;initialDelayMs:number;maxDelayMs:number;resetAfterMs:number};
}
const integer=(value:unknown,min:number,max:number)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
export function normalizeAbusePolicy(value:AuthAbuseOptions|undefined):AuthAbusePolicy|undefined {
 if(value===undefined)return;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['passwordBackoff','client','signupClient','signupDomain','challengeAfter'].includes(key)))throw new Error('Invalid abuse policy');
 const policy:AuthAbusePolicy={};
 for(const name of ['client','signupClient','signupDomain'] as const){const item=value[name];if(item!==undefined){if(!item||Object.keys(item).some(key=>!['limit','windowMs'].includes(key))||!integer(item.limit,1,100000)||!integer(item.windowMs,1000,86400000))throw new Error('Invalid velocity limit');policy[name]={limit:item.limit,windowMs:item.windowMs};}}
 if(value.passwordBackoff!==undefined){const item=value.passwordBackoff;if(!item||Object.keys(item).some(key=>!['threshold','initialDelayMs','maxDelayMs','resetAfterMs'].includes(key)))throw new Error('Invalid backoff policy');const backoff={threshold:item.threshold??5,initialDelayMs:item.initialDelayMs??1000,maxDelayMs:item.maxDelayMs??900000,resetAfterMs:item.resetAfterMs??86400000};if(!integer(backoff.threshold,1,20)||!integer(backoff.initialDelayMs,100,60000)||!integer(backoff.maxDelayMs,backoff.initialDelayMs,86400000)||!integer(backoff.resetAfterMs,backoff.maxDelayMs,604800000))throw new Error('Invalid backoff policy');policy.passwordBackoff=backoff;}
 if(value.challengeAfter!==undefined){if(!policy.client||!integer(value.challengeAfter,1,policy.client.limit-1))throw new Error('Challenge threshold requires a client limit');policy.challengeAfter=value.challengeAfter;}
 return Object.freeze(policy);
}
/** Pseudonymous, bounded counter keys. No raw address, email or domain is stored. */
export const abuseKey=(scope:string,value:string)=>createHash('sha256').update('urlcode-auth-abuse:'+scope+'\0'+value).digest('hex');
