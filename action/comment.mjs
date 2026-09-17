// Posts or updates the one sticky route-diff comment on a pull request. Runs
// with the workflow's GITHUB_TOKEN only; when it cannot read or write comments
// (fork pull requests, missing pull-requests: write) it reports and exits 0.
import { readFile } from 'node:fs/promises';
const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL = 'https://api.github.com', DIFF_FILE, PROJECT = '.', PR_NUMBER, HEAD_SHA = '' } = process.env;
const notice = (message) => console.log(`::notice::${message}`);
if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !DIFF_FILE || !PR_NUMBER) { notice('Route diff comment skipped: not a pull request run'); process.exit(0); }
// One comment per project directory: the marker keys it across runs.
const marker = `<!-- urlcode-route-diff project=${JSON.stringify(PROJECT)} -->`;
const diff = await readFile(DIFF_FILE, 'utf8');
const body = `${marker}\n## URLCode route changes\n\nProject \`${PROJECT}\`, compared with the base branch at ${HEAD_SHA ? `\`${HEAD_SHA.slice(0, 7)}\`` : 'this revision'}.\n\n${diff.trim()}\n`;
const api = async (path, init = {}) => fetch(`${GITHUB_API_URL}${path}`, { ...init, headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', ...init.headers } });
try {
  let existing;
  for (let page = 1; page <= 10 && !existing; page++) {
    const response = await api(`/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments?per_page=100&page=${page}`);
    if (!response.ok) throw Object.assign(new Error(`listing comments failed with ${response.status}`), { status: response.status });
    const comments = await response.json();
    existing = comments.find(comment => typeof comment.body === 'string' && comment.body.startsWith(marker));
    if (comments.length < 100) break;
  }
  const response = existing
    ? await api(`/repos/${GITHUB_REPOSITORY}/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body }) })
    : await api(`/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  if (!response.ok) throw Object.assign(new Error(`${existing ? 'updating' : 'creating'} the comment failed with ${response.status}`), { status: response.status });
  console.log(`Route diff comment ${existing ? 'updated' : 'created'}: ${(await response.json()).html_url}`);
} catch (error) {
  const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
  if (status === 401 || status === 403 || status === 404) notice(`Route diff comment skipped: the token cannot write pull request comments (${status}); grant pull-requests: write or read the diff in the job log`);
  else console.log(`::warning::Route diff comment skipped: ${error instanceof Error ? error.message : String(error)}`);
}
