import {randomUUID} from 'node:crypto';
import type {AuthAccount,AuthExports} from '@jimhoyd/urlcode-auth';
import type {AuditExports,AuditStoredEvent} from '@jimhoyd/urlcode-audit';
import {auditFilters} from './admin-reporting.ts';
import {AdminHttpError} from './admin-ui.ts';
const EVENTS=5000,BYTES=4*1024*1024,DURATION_MS=5000;
/**
 * A complete bounded range of the audit log, or nothing: never a silently truncated result or a page the caller was
 * no longer allowed to read. Every pending producer event is flushed first, so the range includes what was just
 * written; auth re-validates the caller's live session, `audit.read`/`audit.export` and freshness before every page;
 * pruning that overtakes the export refuses it; and the export is itself recorded before it is released.
 */
export async function exportAuditRange(audit:AuditExports,auth:AuthExports,account:AuthAccount,query:URLSearchParams,reason:string):Promise<{from:number;to:number;events:AuditStoredEvent[]}> {
 if(query.has('after'))throw new AdminHttpError(400,'Range exports start at the beginning of the selected range');
 const {limit:_limit,order:_order,...filters}=auditFilters(query);
 if(filters.from===undefined||filters.to===undefined)throw new AdminHttpError(400,'Choose both UTC range endpoints');
 const from=filters.from,to=Math.min(filters.to,Date.now());
 if(from>to)throw new AdminHttpError(400,'Choose a range that has started');
 await audit.flush();
 const events:AuditStoredEvent[]=[],started=Date.now(),cursors=new Set<string>();
 let after:string|undefined,bytes=0,first:bigint|undefined;
 do {
  await auth.administration.reauthorize(account.actor,{permissions:['audit.read','audit.export'],fresh:true});
  if(Date.now()-started>DURATION_MS)throw new AdminHttpError(413,'Choose a smaller audit range');
  const page=await audit.query({...filters,from,to,limit:100,order:'asc',...(after?{after}:{})});
  if(first===undefined&&page.events[0])first=BigInt(page.events[0].seq);
  // Retention removed rows this export had already reached: what remains of the range is no longer complete.
  if(first!==undefined&&page.oldest!==undefined&&BigInt(page.oldest)>first)throw new AdminHttpError(503,'Audit range was pruned during export');
  bytes+=Buffer.byteLength(JSON.stringify(page.events));
  if(events.length+page.events.length>EVENTS||bytes>BYTES)throw new AdminHttpError(413,'Choose a smaller audit range');
  events.push(...page.events);
  after=page.next;
  if(after){if(cursors.has(after))throw new AdminHttpError(503,'Audit pagination unavailable');cursors.add(after);}
 } while(after);
 try{await audit.record([{id:randomUUID(),source:'admin',action:'admin.audit_exported',actor:account.id,subject:`range:${from}:${to}:${events.length}`,at:Date.now(),reason}]);}
 catch{throw new AdminHttpError(503,'The export could not be recorded');}
 return {from,to,events};
}
