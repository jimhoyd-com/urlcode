import { ConfigError, assert } from './errors.ts';
import { createGithubTransport, exactKeys, isRecord, peekCatalogCommit, textField, verifiedReleaseAsset, type ReleaseAsset } from './extension-transport.ts';

/**
 * A signed, immutable recommendation for one tested core/bundles/artifacts tuple.
 *
 * This module deliberately has no mutable "latest" URL. A caller first obtains a
 * release tag from its policy/discovery channel, then this resolver verifies that
 * exact tag before returning the immutable component pins to lock in a project.
 */
const trainTag=/^urlcode-train@v[0-9][0-9A-Za-z._-]{0,100}$/;
const bundleTag=/^extension-bundles@v[0-9][0-9A-Za-z._-]{0,100}$/;
const artifactTag=/^extensions@v[0-9][0-9A-Za-z._-]{0,100}$/;
const version=/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const commit=/^[a-f0-9]{40}$/;
const TRAIN_ASSET='safe-release-train.json';
export const SAFE_RELEASE_TRAIN_REPOSITORY='jimhoyd-com/urlcode';
export const SAFE_RELEASE_TRAIN_WORKFLOW='jimhoyd-com/urlcode/.github/workflows/release-train.yml';
const text=(value:unknown,what:string):string=>textField(value,`${what} in safe release train`);

/**
 * The core-owned default recommendation is an immutable tag tied to exactly
 * the running core version. It is intentionally not a `latest` alias: a
 * missing tag means no recommendation has been published for this core yet.
 */
export function safeReleaseTrainTag(coreVersion:string):string {
  assert(version.test(coreVersion),'Invalid running core version');
  return `urlcode-train@v${coreVersion}`;
}

export interface SafeReleaseTrainComponent { tag:string; commit:string; }
export interface SafeReleaseTrain {
  format:1;
  tag:string;
  commit:string;
  sequence:number;
  coreVersion:string;
  extensionBundles:SafeReleaseTrainComponent&{coreVersion:string};
  artifacts:SafeReleaseTrainComponent;
}

/** The narrow transport a CLI needs to resolve one immutable release train. */
export interface SafeReleaseTrainTransport {
  release(tag:string):Promise<ReleaseAsset[]>;
  download(url:string):Promise<Uint8Array>;
  attest(path:string,release:string,commit?:string):Promise<void>;
}

/** The production transport accepts only the dedicated, tag-bound release workflow. */
export const githubSafeReleaseTrainTransport:SafeReleaseTrainTransport=createGithubTransport({repository:SAFE_RELEASE_TRAIN_REPOSITORY,workflow:SAFE_RELEASE_TRAIN_WORKFLOW,tagPattern:trainTag,exampleTag:'urlcode-train@v0.5.9',maxAssetSize:64*1024,itemLabel:'safe release train'});

function component(value:unknown,keys:readonly string[],what:string):SafeReleaseTrainComponent {
  assert(isRecord(value),`Invalid ${what}`);
  exactKeys(value,keys,what);
  const tag=text(value.tag,`${what} tag`),sourceCommit=text(value.commit,`${what} commit`);
  assert(commit.test(sourceCommit),`Invalid ${what}`);
  return {tag,commit:sourceCommit};
}

/**
 * Parse a train only after the caller has verified its GitHub attestation for
 * `requestedTag`. Its component pins are not trust roots themselves: consumers
 * still verify the referenced bundle and artifact catalogs before using them.
 */
export function parseSafeReleaseTrain(bytes:Uint8Array,requestedTag:string):SafeReleaseTrain {
  let raw:unknown;
  try { raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch { throw new ConfigError('Safe release train is not valid UTF-8 JSON'); }
  assert(isRecord(raw)&&raw.format===1,'Unsupported safe release train format');
  exactKeys(raw,['format','tag','commit','sequence','coreVersion','extensionBundles','artifacts'],'Safe release train');
  const tag=text(raw.tag,'train tag'),sourceCommit=text(raw.commit,'train commit'),coreVersion=text(raw.coreVersion,'core version');
  assert(trainTag.test(tag)&&tag===requestedTag,'Safe release train tag does not match the immutable requested release');
  assert(commit.test(sourceCommit)&&version.test(coreVersion),'Safe release train has an invalid pin');
  assert(tag===safeReleaseTrainTag(coreVersion),'Safe release train tag does not match its core version');
  assert(typeof raw.sequence==='number'&&Number.isSafeInteger(raw.sequence)&&raw.sequence>0,'Safe release train has an invalid sequence');
  const bundleValue=raw.extensionBundles;
  assert(isRecord(bundleValue),'Invalid safe release train extension bundles');
  const bundles=component(bundleValue,['tag','commit','coreVersion'],'safe release train extension bundles') as SafeReleaseTrain['extensionBundles'];
  bundles.coreVersion=text(bundleValue.coreVersion,'extension bundle core version');
  assert(bundleTag.test(bundles.tag)&&version.test(bundles.coreVersion)&&bundles.coreVersion===coreVersion,'Safe release train has incompatible extension bundles');
  const artifacts=component(raw.artifacts,['tag','commit'],'safe release train artifacts');
  assert(artifactTag.test(artifacts.tag),'Safe release train has an invalid artifact release');
  return {format:1,tag,commit:sourceCommit,sequence:raw.sequence,coreVersion,extensionBundles:bundles,artifacts};
}

/**
 * Verify and resolve one operator-selected safe release train. The attestation
 * is bound to both its immutable release tag and the train's source commit;
 * refusing a train for another core fails before a caller can use its pins.
 */
export async function resolveSafeReleaseTrain(release:string,coreVersion:string,transport:SafeReleaseTrainTransport=githubSafeReleaseTrainTransport):Promise<SafeReleaseTrain> {
  assert(trainTag.test(release),'Use an immutable safe release train tag such as urlcode-train@v0.5.9');
  assert(version.test(coreVersion),'Invalid running core version');
  assert(release===safeReleaseTrainTag(coreVersion),`Safe release train ${release} does not match running core ${coreVersion}`);
  const assets=await transport.release(release);
  const bytes=await verifiedReleaseAsset(assets,TRAIN_ASSET,release,transport,'safe release train','urlcode-release-train-attest',peekCatalogCommit);
  const train=parseSafeReleaseTrain(bytes,release);
  assert(train.coreVersion===coreVersion,`Safe release train ${release} requires core ${train.coreVersion}; this runtime is ${coreVersion}`);
  return train;
}

export { TRAIN_ASSET };
