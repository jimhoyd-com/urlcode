/* global document, location, history, addEventListener */
// Stands in for a prebuilt client router: it renders the path the browser holds and asks the API for its status.
const app = document.getElementById('app');
async function render() {
  const status = await fetch('/api/status').then(reply => reply.json()).catch(() => ({ok: false}));
  app.textContent = `Route ${location.pathname} (API ok: ${status.ok})`;
}
document.addEventListener('click', event => {
  const link = event.target.closest('a[href^="/"]');
  if (!link) return;
  event.preventDefault();
  history.pushState(null, '', link.getAttribute('href'));
  render();
});
addEventListener('popstate', render);
render();
