import type {DatabaseSync} from 'node:sqlite';
import type {AuthAbusePolicy} from './abuse.ts';
export function abuseOperation(operation:string,args:Record<string,unknown>,db:DatabaseSync,policy:AuthAbusePolicy|undefined,fail:(status:number,code:string)=>never):{value:unknown}|undefined {
 if(!operation.startsWith('abuse'))return;
 const now=Number(args.now),key=String(args.key);
 const ensure=(count=1)=>{db.prepare('DELETE FROM auth_abuse WHERE key IN (SELECT key FROM auth_abuse WHERE expires<=? LIMIT 1000)').run(now);if(Number(db.prepare('SELECT count(*) AS n FROM auth_abuse').get()?.n)+count>100000)fail(503,'auth_capacity_reached');};
 if(operation==='abuseBackoffCheck'){const row=db.prepare('SELECT blocked_until FROM auth_abuse WHERE key=? AND expires>?').get(key,now);return {value:Boolean(row&&Number(row.blocked_until)>now)};}
 if(operation==='abuseFailure'){
  const config=policy?.passwordBackoff;if(!config)return {value:undefined};
  const row=db.prepare('SELECT count FROM auth_abuse WHERE key=? AND expires>?').get(key,now);if(!row)ensure();
  const count=Math.min(64,Number(row?.count??0)+1),delay=count<config.threshold?0:Math.min(config.maxDelayMs,config.initialDelayMs*2**Math.min(30,count-config.threshold));
  db.prepare('INSERT INTO auth_abuse VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,expires=excluded.expires,blocked_until=excluded.blocked_until').run(key,count,now+config.resetAfterMs,now+delay);return {value:undefined};
 }
 if(operation==='abuseAdmit'){
  const limits=args.limits as {key:string;limit:number;windowMs:number;challengeAfter?:number}[];
  let challengeRequired=false;
  const rows=limits.map(item=>({item,row:db.prepare('SELECT count,expires FROM auth_abuse WHERE key=? AND expires>?').get(item.key,now)}));
  if(rows.some(({item,row})=>Number(row?.count??0)>=item.limit))fail(429,'auth_rate_limited');
  const added=rows.filter(({row})=>!row).length;if(added)ensure(added);
  for(const {item,row} of rows){const count=Number(row?.count??0)+1;db.prepare('INSERT INTO auth_abuse VALUES(?,?,?,0) ON CONFLICT(key) DO UPDATE SET count=excluded.count,expires=excluded.expires,blocked_until=0').run(item.key,count,row?Number(row.expires):now+item.windowMs);if(item.challengeAfter!==undefined&&count>item.challengeAfter)challengeRequired=true;}
  return {value:{challengeRequired}};
 }
 return;
}
