// One route serves both the page and the submission, so the page is a module
// string here instead of a `page` handler (one handler per route).
export const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Contact</title></head>
<body>
<h1>Contact</h1>
<form method="post" action="/contact">
<label>Name <input name="name" required maxlength="80"></label>
<label>Email <input name="email" type="email" required></label>
<label>Message <textarea name="message" required maxlength="2000"></textarea></label>
<input name="website" tabindex="-1" autocomplete="off" hidden>
<button>Send</button>
</form>
</body>
</html>
`;
