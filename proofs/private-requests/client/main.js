// Browser code for the frontend. Sign-in, sign-out and session state go through Better Auth's own client;
// application data goes through the store's declared JSON mounts. Built into app/public/assets/app.js.
import { createAuthClient } from 'better-auth/client';

const auth = createAuthClient({ basePath: '/api/auth' });
const $ = id => document.getElementById(id);
const say = text => { $('status').textContent = text; };

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
  const { data } = await auth.getSession();
  $('sign-in').hidden = Boolean(data);
  $('signed-in').hidden = !data;
  if (!data) return;
  $('who').textContent = data.user.email;
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
  const { error } = await auth.signIn.email({ email: form.get('email'), password: form.get('password') });
  say(error ? error.message ?? 'Sign-in failed' : '');
  await render();
};
$('sign-out').onclick = async () => { await auth.signOut(); say(''); await render(); };
$('sign-out-all').onclick = async () => { await auth.revokeSessions(); say('Every session was signed out.'); await render(); };
$('create').onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  try { await api('/api/requests', { method: 'POST', body: JSON.stringify({ title: form.get('title'), details: form.get('details') }) }); event.target.reset(); say(''); }
  catch (error) { say(error.message); }
  await render();
};
render().catch(error => say(error.message));
