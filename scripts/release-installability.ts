// Read-only npm propagation check: a published version is installable once its install metadata and archive agree.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

interface PublishedPackage { name: string; version: string }
interface InstallabilityOptions {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}
class PropagationPending extends Error {}

/** Check the abbreviated metadata npm install reads, then the actual archive. */
export async function waitForInstallability(pkg: PublishedPackage, options: InstallabilityOptions = {}): Promise<void> {
  const request = options.fetch ?? fetch;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  // The packument (the full `versions` document install reads) can lag the
  // per-version endpoint by several minutes on npm's registry CDN even after
  // a real, successful publish (observed ~10 minutes on the 0.5.5 release).
  // 120 * 10s gives comfortable headroom over that without raising the caps.
  const attempts = options.attempts ?? 120;
  const interval = options.intervalMs ?? 10000;
  assert(Number.isInteger(attempts) && attempts > 0 && attempts <= 120, 'Invalid propagation attempt limit');
  assert(Number.isFinite(interval) && interval >= 0 && interval <= 60000, 'Invalid propagation interval');
  const get = async (url: string, metadata = false) => {
    let response: Response;
    try {
      response = await request(url, { headers: metadata ? { accept: 'application/vnd.npm.install-v1+json' } : {}, signal: AbortSignal.timeout(15000), redirect: 'error' });
    } catch (error) {
      throw new PropagationPending(`Registry request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 404 || response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new PropagationPending(`Registry returned HTTP ${response.status}`);
    }
    assert(response.ok, `Registry refused ${pkg.name}@${pkg.version}: HTTP ${response.status}`);
    return response;
  };
  let reason = 'Version missing from install metadata';
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(interval);
    try {
      const metadata = await (await get(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`, true)).json() as {
        versions?: Record<string, { name?: string; version?: string; dist?: { tarball?: string; integrity?: string } }>;
      };
      const version = metadata.versions?.[pkg.version];
      if (!version) throw new PropagationPending('Version missing from install metadata');
      assert.equal(version.name, pkg.name, 'Registry package identity mismatch');
      assert.equal(version.version, pkg.version, 'Registry version mismatch');
      const tarball = new URL(version.dist?.tarball ?? '');
      assert(tarball.protocol === 'https:' && tarball.hostname === 'registry.npmjs.org' && !tarball.username && !tarball.password && !tarball.port, 'Unexpected registry tarball URL');
      const integrity = version.dist?.integrity;
      assert(integrity && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity), 'Registry archive must have SHA512 integrity');
      const response = await get(tarball.href);
      let bytes: ArrayBuffer;
      try { bytes = await response.arrayBuffer(); }
      catch { throw new PropagationPending('Archive transfer interrupted'); }
      assert.equal(`sha512-${createHash('sha512').update(Buffer.from(bytes)).digest('base64')}`, integrity, 'Registry archive integrity mismatch; stop and investigate');
      return;
    } catch (error) {
      if (!(error instanceof PropagationPending)) throw error;
      reason = error.message;
    }
  }
  throw new Error(`${pkg.name}@${pkg.version} is not installable after ${attempts} checks: ${reason}. Inspect the original publication run; do not move its tag.`);
}
