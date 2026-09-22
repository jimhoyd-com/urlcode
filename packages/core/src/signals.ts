import { egressUrl, safeEgressHeaders } from './egress.ts';
import type { EgressTransport } from './proxy.ts';
export interface SignalDefinition { url:string; headers?:Record<string,string> }
interface SignalEvent { route:string; status:number; method:string }
interface SignalStats { accepted:number; delivered:number; failed:number; dropped:number }
export function validateSignal(definition:SignalDefinition):void {if(!definition||typeof definition!=='object'||Object.keys(definition).some(key=>!['url','headers'].includes(key))) throw new Error('Invalid signal');egressUrl(definition.url);safeEgressHeaders(definition.headers||{});}
/** No queue, retries, ordering promise, or durable delivery. Counters contain no URL/header data. */
export class SignalBroker {
  readonly #onStats:((stats:SignalStats)=>void)|undefined; readonly #client:EgressTransport; readonly #concurrency:number; readonly #pending=new Set<Promise<void>>(); readonly #controller=new AbortController();
  readonly #stats:SignalStats={accepted:0,delivered:0,failed:0,dropped:0}; #closed=false;
  constructor(client:EgressTransport,concurrency=8,onStats?: (stats:SignalStats)=>void) {if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>128) throw new Error('Invalid signal concurrency');this.#onStats=onStats;this.#client=client;this.#concurrency=concurrency;}
  get stats():SignalStats {return {...this.#stats};}
  emit(definition:SignalDefinition,event:SignalEvent):boolean {
    if(this.#closed||this.#pending.size>=this.#concurrency) {this.#stats.dropped++;this.#notify();return false;}
    try {validateSignal(definition);} catch {this.#stats.dropped++;this.#notify();return false;}
    if(!event.route.startsWith('/')||event.route.length>2048||!/^[A-Z]{1,16}$/.test(event.method)||!Number.isInteger(event.status)||event.status<100||event.status>599) {this.#stats.dropped++;this.#notify();return false;}
    this.#stats.accepted++;this.#notify();
    const body=Buffer.from(JSON.stringify({version:1,route:event.route,status:event.status,method:event.method}));
    const pending=Promise.resolve().then(()=>this.#client.request({url:definition.url,method:'POST',headers:{...definition.headers,'content-type':'application/json'},body,signal:this.#controller.signal})).then(result=>{if(result.status>=200&&result.status<300)this.#stats.delivered++;else this.#stats.failed++;},()=>{this.#stats.failed++;}).finally(()=>{this.#pending.delete(pending);this.#notify();});
    this.#pending.add(pending);return true;
  }
  #notify():void {try {this.#onStats?.(this.stats);} catch { /* Observers cannot alter delivery. */ }}
  async close():Promise<void> {this.#closed=true;this.#controller.abort();await Promise.allSettled([...this.#pending]);}
}
