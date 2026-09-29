// The setups the store refuses at activation (#927). The checks themselves are core's, shared with auth and audit
// (`@jimhoyd/urlcode/extensions`, host-lease): a Linux network filesystem refusal and a lease table in the database.
// The store's lease table is `store_servers` (schema version 5), and its instance id also holds the audit drain lease.
import { joinHostLease } from '@jimhoyd/urlcode/extensions';
import type { HostLease, HostProbe } from '@jimhoyd/urlcode/extensions';
import type { StoreDatabase } from './database.ts';

export { hostProbe, NETWORK_FILESYSTEMS, refuseNetworkFilesystem, SERVER_LEASE } from '@jimhoyd/urlcode/extensions';
export type { HostProbe } from '@jimhoyd/urlcode/extensions';
export type ServerLease = HostLease;

/** Joins `store_servers`, refusing activation while a live peer serves the database from another host (`joinHostLease`). */
export function joinServers(db: StoreDatabase, probe?: Partial<HostProbe>, now?: () => number): Promise<ServerLease> {
  return joinHostLease(db, { table: 'store_servers', what: 'store', probe, now });
}
