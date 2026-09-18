import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {adminPage} from '../src/admin-presentation.ts';
const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
async function run(...args:string[]){try{return {code:0,...await promisify(execFile)(process.execPath,['--conditions=development','--no-warnings',cli,...args])};}catch(error){const failure=error as {code:number;stdout:string;stderr:string};return {code:failure.code,stdout:failure.stdout,stderr:failure.stderr};}}

test('cli rejects unknown commands with exit code 1 and prints usage for --help',async()=>{
 for(const args of [['bogus'],['init'],['init','--directory','x','extra'],['start','--directory','x']]){const result=await run(...args);assert.equal(result.code,1,args.join(' '));assert.match(result.stderr,/Admin initialization failed/);assert.equal(result.stdout,'');}
 const help=await run('--help');assert.equal(help.code,0);assert.match(help.stdout,/urlcode-admin init --directory NEW_DIRECTORY/);assert.equal(help.stderr,'');
 assert.equal((await run()).code,0);
});

test('admin page shell replaces only the generic heading and keeps content headings',()=>{
 const html=(content:string)=>new TextDecoder().decode(adminPage('Users',content).body);
 const shell=html('<aside class="ui-sidebar">nav</aside><p>body</p><h1>Inside content</h1>');
 assert.deepEqual(shell.match(/<h1>[^]*?<\/h1>/g),['<h1>Users</h1>','<h1>Inside content</h1>']);
 assert.ok(shell.includes('href="#admin-content"'));assert.ok(!shell.includes('href="#main"'));
 assert.deepEqual(html('<p>plain</p>').match(/<h1>[^]*?<\/h1>/g),['<h1>Users</h1>']);
 assert.deepEqual(html('<aside class="ui-sidebar">nav</aside><p>&lt;h1&gt;escaped&lt;/h1&gt;</p>').match(/<h1>[^]*?<\/h1>/g),['<h1>Users</h1>']);
});
