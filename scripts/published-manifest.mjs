// The core manifest keeps `prepare` so a git-dependency install builds dist/ from source. A packed tarball already
// ships dist/ and does not contain scripts/build.ts, so the lifecycle script would name a missing file and make npm
// flag an install script on every install (#592). Every path that packs core (the release packer and the package
// smoke test) packs through withPublishedManifest, so the published manifest never carries it.
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export const unpublishedScripts=Object.freeze(['prepare']);

/** The manifest text npm should pack: unchanged unless it declares a script that must not be published. */
export function publishedManifest(text){
 const manifest=JSON.parse(text);
 const scripts={...manifest.scripts};
 if(!unpublishedScripts.some(name=>Object.hasOwn(scripts,name)))return text;
 for(const name of unpublishedScripts)delete scripts[name];
 return JSON.stringify({...manifest,scripts},null,2)+'\n';
}

/** Runs `pack` with the published manifest in place, restoring the original bytes afterwards even when it throws. */
export async function withPublishedManifest(directory,pack){
 const path=join(directory,'package.json'),original=await readFile(path,'utf8'),published=publishedManifest(original);
 if(published===original)return pack();
 await writeFile(path,published);
 try {return await pack();} finally {await writeFile(path,original);}
}
