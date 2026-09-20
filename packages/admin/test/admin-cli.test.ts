import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {devConditionArgs} from './support/conditions.ts';
const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
async function run(...args:string[]){try{return {code:0,...await promisify(execFile)(process.execPath,[...devConditionArgs,'--no-warnings',cli,...args])};}catch(error){const failure=error as {code:number;stdout:string;stderr:string};return {code:failure.code,stdout:failure.stdout,stderr:failure.stderr};}}

test('cli rejects unknown commands with exit code 1 and prints usage for --help',async()=>{
 for(const args of [['bogus'],['init'],['init','--directory','x','extra'],['start','--directory','x']]){const result=await run(...args);assert.equal(result.code,1,args.join(' '));assert.match(result.stderr,/Admin initialization failed/);assert.equal(result.stdout,'');}
 const help=await run('--help');assert.equal(help.code,0);assert.match(help.stdout,/urlcode-admin init --directory NEW_DIRECTORY/);assert.equal(help.stderr,'');
 assert.equal((await run()).code,0);
});

