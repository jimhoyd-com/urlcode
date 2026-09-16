import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const sourceCommit=process.env.URLCODE_SOURCE_SHA;
assert(/^[a-f0-9]{40}$/.test(sourceCommit||''),'URLCODE_SOURCE_SHA must identify the checked-out commit');
await mkdir('candidate'); // Refuse stale artifacts from an earlier build.
const npm=process.platform==='win32'?'npm.cmd':'npm';
const sbom=execFileSync(npm,['sbom','--omit=dev','--sbom-format','cyclonedx'],{maxBuffer:16*1024*1024});
JSON.parse(sbom);await writeFile('candidate/sbom.cdx.json',sbom);
execFileSync(npm,['pack','--ignore-scripts','--pack-destination','candidate'],{stdio:'inherit'});
const digest=data=>createHash('sha256').update(data).digest('hex');
const artifacts={};for(const name of await readdir('candidate'))artifacts[name]=digest(await readFile('candidate/'+name));
await writeFile('candidate/manifest.json',JSON.stringify({sourceCommit,node:process.version,versions:process.versions,lockfileSha256:digest(await readFile('package-lock.json')),artifacts,channel:'alpha-candidate',license:'undecided'},null,2)+'\n');
