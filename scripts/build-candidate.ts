import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const sourceCommit=process.env.URLCODE_SOURCE_SHA;
assert(/^[a-f0-9]{40}$/.test(sourceCommit||''),'URLCODE_SOURCE_SHA must identify the checked-out commit');
// One audited build path serves both the manually dispatched candidate and a
// tagged release; only the recorded channel differs.
const channel=process.env.URLCODE_CHANNEL||'candidate';
assert(['candidate','release'].includes(channel),'URLCODE_CHANNEL must be candidate or release');
const pkg=JSON.parse(await readFile('package.json','utf8'));
if(channel==='release'){
  assert(process.env.URLCODE_RELEASE_VERSION===pkg.version,`Tag version ${process.env.URLCODE_RELEASE_VERSION} does not match package.json ${pkg.version}`);
  assert(!pkg.private,'A private package cannot be released');
  assert(typeof pkg.license==='string' && pkg.license.length,'A release requires a declared license');
}
// The package ships dist/, emitted from the tagged sources by Node's type
// stripping (scripts/build.ts); record what produced it so a download can be
// reproduced and compared file by file.
const build=JSON.parse(await readFile('dist/BUILD-MANIFEST.json','utf8').catch(()=>{throw new Error('dist/BUILD-MANIFEST.json is missing; run npm run build first');}));
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
const typescript=lock.packages['node_modules/typescript']?.version;
assert(typescript,'package-lock.json does not lock typescript');
await mkdir('candidate'); // Refuse stale artifacts from an earlier build.
const npm=process.platform==='win32'?'npm.cmd':'npm';
const sbom=execFileSync(npm,['sbom','--omit=dev','--sbom-format','cyclonedx'],{maxBuffer:16*1024*1024});
JSON.parse(sbom);await writeFile('candidate/sbom.cdx.json',sbom);
execFileSync(npm,['pack','--ignore-scripts','--pack-destination','candidate'],{stdio:'inherit'});
const digest=data=>createHash('sha256').update(data).digest('hex');
const artifacts={};for(const name of await readdir('candidate'))artifacts[name]=digest(await readFile('candidate/'+name));
await writeFile('candidate/manifest.json',JSON.stringify({sourceCommit,node:process.version,versions:process.versions,lockfileSha256:digest(await readFile('package-lock.json')),builder:process.version,typescript,dist:build,artifacts,channel,version:pkg.version,license:pkg.license},null,2)+'\n');
// Plain sha256sum format so an installer can verify a download without a JSON parser.
await writeFile('candidate/SHA256SUMS',Object.entries(artifacts).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([name,hash])=>`${hash}  ${name}`).join('\n')+'\n');
