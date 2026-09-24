import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSafeReleaseTrain, resolveSafeReleaseTrain, safeReleaseTrainTag, TRAIN_ASSET, type SafeReleaseTrainTransport } from '../packages/core/src/release-train.ts';
import { ConfigError } from '../packages/core/src/errors.ts';

const core='0.5.9',release=safeReleaseTrainTag(core);
function train(overrides:Record<string,unknown>={}):Buffer {
  return Buffer.from(JSON.stringify({format:1,tag:release,commit:'a'.repeat(40),sequence:42,coreVersion:core,extensionBundles:{tag:'extension-bundles@v0.5.9',commit:'b'.repeat(40),coreVersion:core},artifacts:{tag:'extensions@v1.2.0',commit:'c'.repeat(40)},...overrides}));
}

test('safe release train parsing accepts exact immutable component pins and rejects ambiguous metadata',()=>{
  const parsed=parseSafeReleaseTrain(train(),release);
  assert.deepEqual(parsed.extensionBundles,{tag:'extension-bundles@v0.5.9',commit:'b'.repeat(40),coreVersion:core});
  assert.equal(parsed.artifacts.tag,'extensions@v1.2.0');
  assert.throws(()=>parseSafeReleaseTrain(train({tag:'urlcode-train@v0.5.8'}),release),/does not match/);
  assert.throws(()=>parseSafeReleaseTrain(train({coreVersion:'0.5.8',extensionBundles:{tag:'extension-bundles@v0.5.8',commit:'b'.repeat(40),coreVersion:'0.5.8'}}),release),/does not match/);
  assert.throws(()=>parseSafeReleaseTrain(train({sequence:0}),release),/invalid sequence/);
  assert.throws(()=>parseSafeReleaseTrain(train({extensionBundles:{tag:'extension-bundles@v0.5.9',commit:'b'.repeat(40),coreVersion:'0.5.8'}}),release),/incompatible extension bundles/);
  assert.throws(()=>parseSafeReleaseTrain(train({extra:true}),release),/unknown or missing fields/);
});

test('safeReleaseTrainTag binds the recommended immutable train to an exact core version',()=>{
  assert.equal(safeReleaseTrainTag('0.5.9'),'urlcode-train@v0.5.9');
  assert.equal(safeReleaseTrainTag('1.0.0-alpha.1'),'urlcode-train@v1.0.0-alpha.1');
  assert.throws(()=>safeReleaseTrainTag('latest'),/Invalid running core version/);
});

test('safe release train resolution verifies its signed release asset and binds the source commit',async()=>{
  const seen:{release:string;commit?:string}[]=[];
  const transport:SafeReleaseTrainTransport={
    release:async requested=>{assert.equal(requested,release);return [{name:TRAIN_ASSET,url:'train'}];},
    download:async url=>{assert.equal(url,'train');return train();},
    attest:async(_path,requested,sourceCommit)=>{seen.push(sourceCommit===undefined?{release:requested}:{release:requested,commit:sourceCommit});},
  };
  const resolved=await resolveSafeReleaseTrain(release,core,transport);
  assert.equal(resolved.sequence,42);
  assert.deepEqual(seen,[{release,commit:'a'.repeat(40)}]);
});

test('safe release train resolution fails closed for another core tag or a mismatched attested source',async()=>{
  const wrongCore:SafeReleaseTrainTransport={release:async()=>[{name:TRAIN_ASSET,url:'train'}],download:async()=>train({coreVersion:'0.6.0',extensionBundles:{tag:'extension-bundles@v0.6.0',commit:'b'.repeat(40),coreVersion:'0.6.0'}}),attest:async()=>{}};
  await assert.rejects(()=>resolveSafeReleaseTrain(release,core,wrongCore),/tag does not match its core version/);
  await assert.rejects(()=>resolveSafeReleaseTrain('urlcode-train@v0.6.0',core,wrongCore),/does not match running core 0\.5\.9/);
  const refusing:SafeReleaseTrainTransport={release:async()=>[{name:TRAIN_ASSET,url:'train'}],download:async()=>train(),attest:async(_path,_release,sourceCommit)=>{if(sourceCommit!=='d'.repeat(40))throw new ConfigError(`source digest mismatch: ${sourceCommit}`);}};
  await assert.rejects(()=>resolveSafeReleaseTrain(release,core,refusing),/source digest mismatch: a{40}/);
});
