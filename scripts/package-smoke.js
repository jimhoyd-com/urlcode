import { mkdtemp, readFile, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = await mkdtemp(join(tmpdir(),'urlcode-package-'));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run through npm run test:package');
function command(bin,args,cwd=process.cwd()) {
  const result = spawnSync(bin === npm ? process.execPath : bin,bin === npm ? [npm,...args] : args,{ cwd,encoding:'utf8',timeout:120000 });
  assert.equal(result.status,0,result.stderr || result.error?.message); return result.stdout;
}
try {
  const [pack] = JSON.parse(command(npm,['pack','--ignore-scripts','--json','--pack-destination',root]));
  for (const file of pack.files) assert.ok(!/(?:^|\/)\.env(?:$|\.(?!example$))/.test(file.path), 'Secret file in package');
  assert.ok(pack.files.some(f => f.path === 'starters/default/gitignore.template'));
  // Install the actual archive, not a symlink to the working tree.
  const install = join(root,'install'); await mkdir(install);
  command(npm,['install','--ignore-scripts','--no-audit','--no-fund','--prefix',install,join(root,pack.filename)]);
  const cli = join(install,'node_modules','urlcode','src','cli.js');
  {
    const project = join(root,'app');
    command(process.execPath,[cli,'init',project]);
    assert.ok((await readFile(join(project,'.gitignore'),'utf8')).includes('.env.*'));
    command(process.execPath,[cli,'test','--project',project]);
    command(process.execPath,[cli,'audit','--project',project,'--expect-routes','2']);
    command(process.execPath,[cli,'benchmark','--project',project,'--requests','10']);
    // The unmodified starter source is also usable as a copied/cloned app.
    const copied = join(root,'app-copy');
    await cp(resolve('starters','default'),copied,{recursive:true});
    command(process.execPath,[cli,'test','--project',copied]);
  }
  console.log('Packed installation and unified starter init/copy paths passed');
} finally { await rm(root,{ recursive:true,force:true }); }
