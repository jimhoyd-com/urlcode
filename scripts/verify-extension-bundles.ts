import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BUNDLE_CATALOG_NAMES, extractBundle, githubBundleTransport, parseBundleCatalog, runningCoreVersion, type BundleTransport } from '../packages/core/src/extension-bundles.ts';

/**
 * Release-side check for #579: verifies a directory of extension bundle release assets (the freshly built
 * output, or the assets downloaded back from the published release) with the attestation policy and catalog
 * checks the CLI applies on `urlcode init --with` and `urlcode extension-bundles install`: the same transport,
 * so the same signer workflow and `--source-ref refs/tags/<tag>`. A release this refuses is one users cannot install.
 */
export async function verifyExtensionBundleRelease(directory:string, tag:string, transport:Pick<BundleTransport,'attest'>=githubBundleTransport):Promise<string[]> {
  const catalogPath=join(directory,'extension-bundles-catalog.json');
  await transport.attest(catalogPath,tag);
  const catalog=parseBundleCatalog(await readFile(catalogPath),tag), core=await runningCoreVersion();
  if(catalog.coreVersion!==core) throw new Error(`Catalog targets core ${catalog.coreVersion}, but this tagged source is core ${core}`);
  const names=catalog.bundles.map(item=>item.name).sort(), known=BUNDLE_CATALOG_NAMES.map(item=>item.name).sort();
  if(JSON.stringify(names)!==JSON.stringify(known)) throw new Error(`Catalog bundles (${names.join(', ')}) differ from the names this core validates locally (${known.join(', ')})`);
  const assets=(await readdir(directory)).filter(file=>file.endsWith('.tgz')).sort();
  if(JSON.stringify(assets)!==JSON.stringify(catalog.bundles.map(item=>item.asset).sort())) throw new Error('Release assets do not match the catalog inventory');
  const scratch=await mkdtemp(join(tmpdir(),'urlcode-bundle-release-verify-'));
  try {
    for(const item of catalog.bundles) {
      const path=join(directory,item.asset);
      await transport.attest(path,tag);
      await extractBundle(await readFile(path),{...item,coreVersion:catalog.coreVersion},join(scratch,item.sha256));
    }
  } finally { await rm(scratch,{recursive:true,force:true}); }
  return names;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {values}=parseArgs({options:{tag:{type:'string'},dir:{type:'string'}},strict:true});
  if(!values.tag||!values.dir) { console.error('Use --tag extension-bundles@vX.Y.Z --dir <release asset directory>'); process.exit(2); }
  try { const names=await verifyExtensionBundleRelease(resolve(values.dir),values.tag); console.log(`Verified ${values.tag} with the CLI policy: catalog and ${names.join(', ')}`); }
  catch(error) { console.error(error instanceof Error?error.message:String(error)); process.exit(1); }
}
