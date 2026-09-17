import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const sourceCommit=process.env.URLCODE_SOURCE_SHA;
assert(/^[a-f0-9]{40}$/.test(sourceCommit||''),'URLCODE_SOURCE_SHA must identify the checked-out commit');
// One audited build path serves both the manually dispatched candidate and a
// tagged release; only the recorded channel differs.
const channel=process.env.URLCODE_CHANNEL||'alpha-candidate';
assert(['alpha-candidate','release'].includes(channel),'URLCODE_CHANNEL must be alpha-candidate or release');
const pkg=JSON.parse(await readFile('package.json','utf8'));
if(channel==='release'){
  assert(process.env.URLCODE_RELEASE_VERSION===pkg.version,`Tag version ${process.env.URLCODE_RELEASE_VERSION} does not match package.json ${pkg.version}`);
  assert(!pkg.private,'A private package cannot be released');
  assert(typeof pkg.license==='string' && pkg.license.length,'A release requires a declared license');
}
await mkdir('candidate'); // Refuse stale artifacts from an earlier build.
const npm=process.platform==='win32'?'npm.cmd':'npm';
const sbom=execFileSync(npm,['sbom','--omit=dev','--sbom-format','cyclonedx'],{maxBuffer:16*1024*1024});
JSON.parse(sbom);await writeFile('candidate/sbom.cdx.json',sbom);
execFileSync(npm,['pack','--ignore-scripts','--pack-destination','candidate'],{stdio:'inherit'});
const digest=data=>createHash('sha256').update(data).digest('hex');
const artifacts={};for(const name of await readdir('candidate'))artifacts[name]=digest(await readFile('candidate/'+name));
await writeFile('candidate/manifest.json',JSON.stringify({sourceCommit,version:pkg.version,node:process.version,versions:process.versions,lockfileSha256:digest(await readFile('package-lock.json')),artifacts,channel,license:pkg.license??'undecided'},null,2)+'\n');
// Plain sha256sum format so an installer can verify a download without a JSON parser.
await writeFile('candidate/SHA256SUMS',Object.entries(artifacts).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([name,hash])=>`${hash}  ${name}`).join('\n')+'\n');
