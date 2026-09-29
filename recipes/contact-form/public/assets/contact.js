/* global document */
// Post the form as JSON: /contact accepts application/json only, so a
// cross-site HTML form cannot submit to it.
const form = document.getElementById('contact');
const status = document.getElementById('status');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const response = await fetch('/contact', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(Object.fromEntries(new FormData(form))),
  });
  status.textContent = response.ok ? 'Thank you, your message was sent.' : 'Your message could not be sent. Check the fields and try again.';
  if (response.ok) form.reset();
});
