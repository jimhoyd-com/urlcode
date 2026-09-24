// Versions published by hand before the tag-driven pipeline could publish them
// (historically, an extension package's first publish, before npm trusted
// publishing was configured for it -- first-party extensions now ship as
// signed GitHub Release bundles instead of npm packages, so this no longer
// recurs). A listed version is accepted without a release tag ONLY when the
// registry's dist.integrity still equals the recorded value. Nothing here
// creates a tag, a release or an attestation, and new versions never qualify:
// add an entry only for a version that was already published manually.
export const handPublished: readonly HandPublishedEntry[] = [
  {
    name: '@jimhoyd/urlcode-store',
    version: '0.4.2',
    integrity: 'sha512-OKWE1ycUf6qCf1oxmu3lQKsTVUDy3LtdWbAwPMetYNqFbT0tMaFt09Jh4CZY77NT8KUxcePyRVgVBb/0IQQMiw==',
    shasum: '8ef301478b61e298a4b929fe6eeba9b9d595673e',
    commit: '7972185412d912c501fdca7ea5cfb6ffc18624cb',
    reason: 'manual first publish, before trusted publishing was configured for this package'
  }
];
interface HandPublishedEntry { name: string; version: string; integrity: string; shasum: string; commit: string; reason: string }
/** True only when name, version and the registry integrity all match one recorded entry. */
export function isRecordedHandPublish(name: string, version: string, integrity: string | undefined, entries: readonly HandPublishedEntry[] = handPublished): boolean {
  return !!integrity && entries.some(entry => entry.name === name && entry.version === version && entry.integrity === integrity);
}
