import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync, backup } from 'node:sqlite';
import { open, lstat, stat, realpath, mkdtemp, rm, link } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
export interface BackupOptions {
    database: string;
    destination: string;
    projectRoot: string;
}
export interface RestoreOptions {
    backup: string;
    destination: string;
    projectRoot: string;
}
export interface BackupResult {
    format: 'urlcode-auth-sqlite-v1';
    bytes: number;
}
function outside(project: string, path: string): boolean { const rel = relative(project, path); return Boolean(rel && (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))); }
function patched(version: string): boolean { const [a = 0, b = 0, c = 0] = version.split('.').map(Number); return a > 3 || a === 3 && (b > 51 || b === 51 && c >= 3 || b === 50 && c >= 7 || b === 44 && c >= 6); }
async function snapshot(sourceInput: string, destinationInput: string, projectRoot: string): Promise<BackupResult> {
    if (!isMainThread || !patched(process.versions.sqlite || ''))
        throw new Error('Backup requires a patched SQLite host');
    if (!isAbsolute(sourceInput) || !isAbsolute(destinationInput) || !isAbsolute(projectRoot))
        throw new Error('Backup paths must be absolute');
    const project = await realpath(projectRoot), sourceInfo = await lstat(sourceInput), source = await realpath(sourceInput), parent = await realpath(dirname(destinationInput)), destination = join(parent, basename(destinationInput));
    if (!outside(project, source) || !outside(project, destination))
        throw new Error('Auth backups and databases must be outside the project');
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.nlink !== 1 || process.platform !== 'win32' && (sourceInfo.mode & 0o077) !== 0 || sourceInfo.size > 1073741824)
        throw new Error('Backup source must be a private regular database below 1 GiB');
    const parentInfo = await stat(parent);
    if (!parentInfo.isDirectory() || process.platform !== 'win32' && (parentInfo.mode & 0o077) !== 0)
        throw new Error('Backup destination directory must be private');
    if (resolve(source) === resolve(destination))
        throw new Error('Backup cannot replace its source');
    try {
        await lstat(destination);
        throw new Error('Backup destination already exists');
    }
    catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
            throw error;
    }
    const temporary = await mkdtemp(join(parent, '.urlcode-backup-')), file = join(temporary, 'snapshot.sqlite');
    let worker: Worker | undefined;
    try {
        const created = await open(file, 'wx', 0o600);
        await created.close();
        worker = new Worker(new URL(import.meta.url), { workerData: { urlcodeAuthBackup: true, source, destination: file }, env: {}, execArgv: [], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 32 } });
        worker.stdout.resume();
        worker.stderr.resume();
        const active = worker;
        await new Promise<void>((accept, reject) => {
            let done = false;
            const finish = (error?: Error) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                if (error)
                    reject(error);
                else
                    accept();
            };
            const timer = setTimeout(() => { void active.terminate(); finish(new Error('Backup exceeded time limit')); }, 30000);
            active.once('message', (message: {
                ok?: boolean;
            }) => finish(message.ok ? undefined : new Error('Database backup validation failed')));
            active.once('error', () => finish(new Error('Database backup failed')));
            active.once('exit', code => {
                if (!done)
                    finish(new Error(`Database backup worker exited (${code})`));
            });
        });
        await active.terminate();
        worker = undefined;
        const copied = await lstat(file);
        if (!copied.isFile() || copied.size > 1073741824)
            throw new Error('Backup exceeds size limit');
        const handle = await open(file, 'r');
        try {
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        // Linking is atomic and refuses any existing destination, including a raced-in symlink.
        await link(file, destination);
        await rm(file);
        const directory = await open(parent, 'r');
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
        return { format: 'urlcode-auth-sqlite-v1', bytes: copied.size };
    }
    finally {
        await worker?.terminate();
        await rm(temporary, { recursive: true, force: true });
    }
}
/** Consistent online SQLite snapshot, including committed WAL pages. Never copies a live database file. */
export function createBackup(options: BackupOptions): Promise<BackupResult> { return snapshot(options.database, options.destination, options.projectRoot); }
/** Restores to a new isolated path only. Operator retains matching keys and static configuration separately. */
export function restoreBackup(options: RestoreOptions): Promise<BackupResult> { return snapshot(options.backup, options.destination, options.projectRoot); }
if (!isMainThread && workerData?.urlcodeAuthBackup) {
    const source = new DatabaseSync(String(workerData.source), { readOnly: true, allowExtension: false });
    try {
        source.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
        if (source.prepare('PRAGMA user_version').get()?.user_version !== 1 || source.prepare('PRAGMA application_id').get()?.application_id !== 1430345032)
            throw new Error('Unsupported auth database');
        const schema = source.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
        if (schema.some(row => !['table', 'index'].includes(String(row.type)) || !String(row.name).startsWith('auth_')))
            throw new Error('Unexpected database schema');
        await backup(source, String(workerData.destination), { rate: 128 });
        const check = new DatabaseSync(String(workerData.destination), { readOnly: true, allowExtension: false });
        try {
            check.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
            const integrity = check.prepare('PRAGMA integrity_check').all();
            if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok' || check.prepare('PRAGMA foreign_key_check').all().length)
                throw new Error('Invalid backup integrity');
        }
        finally {
            check.close();
        }
        parentPort!.postMessage({ ok: true });
    }
    catch {
        parentPort!.postMessage({ ok: false });
    }
    finally {
        source.close();
        parentPort!.close();
    }
}
