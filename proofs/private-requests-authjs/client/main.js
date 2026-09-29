// Browser code for the frontend. Sign-in, sign-out and session state go to Auth.js's own endpoints: @auth/core has no
// framework-neutral browser client, so this calls them with fetch the way Auth.js's framework clients do (a CSRF
// token, a form post, X-Auth-Return-Redirect for a JSON answer instead of a redirect). Application data goes through
// the store's declared JSON mounts exactly as in the Better Auth proof. Copied to app/public/assets/app.js.
const $ = id => document.getElementById(id);
const say = text => { $('status').textContent = text; };

const auth = {
  async session() { return (await fetch('/api/auth/session')).json(); },
  async post(action, fields = {}) {
    const { csrfToken } = await (await fetch('/api/auth/csrf')).json();
    const response = await fetch(`/api/auth/${action}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-auth-return-redirect': '1' }, body: new URLSearchParams({ ...fields, csrfToken }) });
    const { url } = await response.json().catch(() => ({}));
    // Auth.js reports a failed sign-in as a redirect URL carrying ?error=.
    return response.ok && url && !new URL(url, location.href).searchParams.has('error') ? null : 'Sign-in failed';
  },
};

async function api(path, init = {}) {
  const response = await fetch(path, { ...init, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error?.message ?? `HTTP ${response.status}`), { status: response.status });
  return body;
}

function item(request, action) {
  const li = document.createElement('li');
  const title = document.createElement('strong');
  title.textContent = request.title;
  const state = document.createElement('span');
  state.className = 'state';
  state.textContent = request.status;
  li.append(title, state);
  if (request.details) li.append(document.createElement('br'), request.details);
  if (action) li.append(' ', action);
  return li;
}

async function render() {
  const session = await auth.session();
  $('sign-in').hidden = Boolean(session);
  $('signed-in').hidden = !session;
  // Auth.js JWT sessions cannot be revoked server-side, so there is no "sign out everywhere".
  $('sign-out-all').hidden = true;
  if (!session) return;
  $('who').textContent = session.user.email;
  const mine = (await api('/api/requests')).items;
  $('mine').replaceChildren(...mine.map(request => item(request)));
  // Only members of the reviewers collection may read the queue: anyone else gets 403.
  const pending = await api('/api/review?status=pending').catch(error => { if (error.status === 403) return null; throw error; });
  $('review').hidden = !pending;
  if (!pending) return;
  const own = new Set(mine.map(request => request.id));
  $('pending').replaceChildren(...pending.items.filter(request => !own.has(request.id)).map(request => {
    const button = document.createElement('button');
    button.textContent = 'Approve';
    button.onclick = () => api(`/api/approvals/${request.id}`, { method: 'POST' }).then(render, error => say(error.message));
    return item(request, button);
  }));
}

$('sign-in').onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  say(await auth.post('callback/credentials', { email: form.get('email'), password: form.get('password') }) ?? '');
  await render();
};
$('sign-out').onclick = async () => { await auth.post('signout'); say(''); await render(); };
$('create').onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  try { await api('/api/requests', { method: 'POST', body: JSON.stringify({ title: form.get('title'), details: form.get('details') }) }); event.target.reset(); say(''); }
  catch (error) { say(error.message); }
  await render();
};
render().catch(error => say(error.message));
