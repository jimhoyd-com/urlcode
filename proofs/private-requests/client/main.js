// Browser code for the frontend. Sign-in, sign-out and session state go through Better Auth's own client;
// application data goes through the site's ordinary JSON routes. Built into app/public/assets/app.js.
import { createAuthClient } from 'better-auth/client';

const auth = createAuthClient({ basePath: '/api/auth' });
const $ = id => document.getElementById(id);
const say = text => { $('status').textContent = text; };

async function api(path, init = {}) {
  const response = await fetch(path, { ...init, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
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
  const me = await api('/api/me');
  const { requests } = await api('/api/requests');
  $('mine').replaceChildren(...requests.map(request => item(request)));
  $('review').hidden = !me.reviewer;
  if (!me.reviewer) return;
  const pending = await api('/api/review/pending');
  $('pending').replaceChildren(...pending.requests.filter(request => request.ownerId !== me.userId).map(request => {
    const button = document.createElement('button');
    button.textContent = 'Approve';
    button.onclick = () => api(`/api/requests/${request.id}/approve`, { method: 'POST' }).then(render, error => say(error.message));
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
