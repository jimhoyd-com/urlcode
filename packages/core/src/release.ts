/**
 * This core release's version, and links to its own documentation.
 *
 * `CORE_VERSION` is the one version literal in core's source: the release pull request rewrites it, and the version
 * check fails unless it equals package.json. It has no Node import, so any runtime target can read it.
 */
export const CORE_VERSION = '0.6.5'; // x-release-please-version

const REPOSITORY_BLOB = 'https://github.com/jimhoyd-com/urlcode/blob/';

/**
 * This release's copy of a page under the repository's `docs/`, such as `docsUrl('HTTP.md#error-format')`.
 * Installed text (CLI output, capability reasons, exported OpenAPI documents) links here rather than naming a
 * `docs/` path, which the package mostly does not ship, or `main`, which may already describe a later release (#938).
 */
export function docsUrl(page: string): string {
  return `${REPOSITORY_BLOB}v${CORE_VERSION}/docs/${page}`;
}
