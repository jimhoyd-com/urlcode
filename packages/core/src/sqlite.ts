// The public `@jimhoyd/urlcode/sqlite` subpath: helpers the bundled SQLite-backed extensions (store, auth)
// share to serve each database from one process. They are implementation helpers for an extension that chooses a
// SQLite file, not URLCode rules: an extension on another database never imports them. Kept apart from
// `@jimhoyd/urlcode/extensions`, so the generic extension contract never loads `node:sqlite`.
export { holdServerLock, hostProbe, NETWORK_FILESYSTEMS, refuseNetworkFilesystem, serverLockHeld, serverLockPath } from './server-lock.ts';
export type { HostProbe, ServerLock } from './server-lock.ts';
