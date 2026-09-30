// What a packed manifest drops from the checkout's package.json, for core and every add-on:
//
// - The `prepare` script. Core keeps it so a git-dependency install builds dist/ from source. A packed tarball
//   already ships dist/ and does not contain scripts/build.ts, so the lifecycle script would name a missing file and
//   make npm flag an install script on every install (#592).
// - Every `development` export condition. In this checkout it points each entry at its TypeScript source, so the
//   workspace resolves and type-checks by package name with no build (#1056). A tarball ships no `src/`, and a
//   consumer's bundler may enable `development` on its own (Vite does in dev), so a published entry must never name it.
//
// Every path that packs core or an add-on (the release packer, the package smoke test and the integration tests)
// packs through publishedManifest or withPublishedManifest, and the package audit checks the result.
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export const unpublishedScripts=Object.freeze(['prepare']);
export const unpublishedConditions=Object.freeze(['development']);

const withoutConditions=value=>{
 if(!value||typeof value!=='object'||Array.isArray(value))return value;
 return Object.fromEntries(Object.entries(value).filter(([key])=>!unpublishedConditions.includes(key)).map(([key,entry])=>[key,withoutConditions(entry)]));
};

/** The manifest text npm should pack: unchanged unless it declares a script or export condition that must not be published. */
export function publishedManifest(text){
 const manifest=JSON.parse(text);
 const scripts={...manifest.scripts};
 const exports=withoutConditions(manifest.exports);
 const dropsScripts=unpublishedScripts.some(name=>Object.hasOwn(scripts,name));
 if(!dropsScripts&&JSON.stringify(exports)===JSON.stringify(manifest.exports))return text;
 for(const name of unpublishedScripts)delete scripts[name];
 return JSON.stringify({...manifest,...(manifest.scripts?{scripts}:{}),...(manifest.exports?{exports}:{})},null,2)+'\n';
}

/** Runs `pack` with the published manifest in place, restoring the original bytes afterwards even when it throws. */
export async function withPublishedManifest(directory,pack){
 const path=join(directory,'package.json'),original=await readFile(path,'utf8'),published=publishedManifest(original);
 if(published===original)return pack();
 await writeFile(path,published);
 try {return await pack();} finally {await writeFile(path,original);}
}
