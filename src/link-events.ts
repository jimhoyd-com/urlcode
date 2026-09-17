import {assert} from './errors.ts';

export interface LinkEvent { outcome: string; code?: string | null; [field: string]: unknown }
export interface LinkObserverOptions { observe: (event: LinkEvent) => unknown; includeCode?: boolean; maxQueue?: number; timeoutMs?: number }
export interface LinkObserverStats { queued: number; delivered: number; dropped: number; failed: number; timedOut: number; closed: boolean }
export interface LinkObserver { emit(event: LinkEvent): void; stats(): LinkObserverStats; close(): Promise<LinkObserverStats> }
type Log = (event: Record<string, unknown>) => void;

// Trusted-operator observation of finished link requests. The observer is
// supplied by the embedding operator process, never by route YAML or guest
// code, and it runs after the response is over: it can never change, delay or
// fail a redirect. Work is bounded by an explicit queue; overload drops events
// and counts the drops rather than growing memory behind the operator's back.
const outcomes=new Set(['completed','aborted','missing','disabled','expired','invalid_code','invalid_record','unavailable']);
export function createLinkObserver(options: unknown, log: Log = () => {}): LinkObserver | undefined {
  if(options===undefined)return undefined;
  assert(options && typeof options==='object' && !Array.isArray(options),'Link events must be an options object');
  const {observe,includeCode=false,maxQueue=256,timeoutMs=1000}=options as Partial<LinkObserverOptions>;
  assert(Object.keys(options).every(key=>['observe','includeCode','maxQueue','timeoutMs'].includes(key)),'Unsupported link event option');
  assert(typeof observe==='function','Link events require an observe(event) function');
  assert(typeof includeCode==='boolean','Link event code disclosure must be a boolean');
  assert(Number.isInteger(maxQueue)&&maxQueue>=1&&maxQueue<=4096,'Link event queue must be 1–4096');
  assert(Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=10000,'Link event timeout must be 1–10000 ms');
  const queue: LinkEvent[]=[];
  let delivered=0,dropped=0,failed=0,timedOut=0,closed=false,draining: Promise<void>|undefined;
  const report: Log=event=>{try{log(event);}catch{/* Logging cannot fail the observer. */}};
  async function deliver(event: LinkEvent): Promise<void> {
    let timer: ReturnType<typeof setTimeout>|undefined;
    try {
      // A slow collector must not pin the queue: the budget is per event and the
      // observer keeps running afterwards, whatever the abandoned call does.
      await Promise.race([
        Promise.resolve(observe!(event)),
        new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),timeoutMs);timer.unref?.();}),
      ]);
      delivered++;
    } catch(error) {
      failed++;
      const timeout=(error as {message?: unknown}|null|undefined)?.message==='timeout';
      if(timeout)timedOut++;
      report({event:'link_observer',status:'failed',reason:timeout?'timeout':'error'});
    } finally { clearTimeout(timer); }
  }
  async function pump(): Promise<void> {
    if(draining)return;
    draining=(async()=>{while(queue.length)await deliver(queue.shift()!);})();
    try{await draining;}finally{draining=undefined;}
  }
  return {
    // Called from the request path. It must stay synchronous and total.
    emit(event: LinkEvent): void {
      try {
        if(closed||!outcomes.has(event.outcome)){dropped++;return;}
        if(queue.length>=maxQueue){
          dropped++;
          if(dropped===1||dropped%maxQueue===0)report({event:'link_observer',status:'dropped',dropped});
          return;
        }
        const {code:_code,...redacted}=event;
        queue.push(includeCode?{...event}:redacted);
        void pump();
      } catch { dropped++; }
    },
    stats:()=>({queued:queue.length,delivered,dropped,failed,timedOut,closed}),
    async close(): Promise<LinkObserverStats> {
      closed=true;
      // Drain what was already accepted, then stop; a stuck collector cannot
      // hold shutdown open past its own per-event budget plus this deadline.
      void pump();
      const deadline=new Promise<boolean>(resolve=>{const timer=setTimeout(()=>resolve(false),timeoutMs*2+1000);timer.unref?.();});
      while(draining)if(!await Promise.race([draining.then(()=>true,()=>true),deadline]))break;
      dropped+=queue.length;queue.length=0;
      return this.stats();
    },
  };
}
