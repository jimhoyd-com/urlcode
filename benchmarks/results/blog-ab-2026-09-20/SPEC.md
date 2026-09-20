# Blog application spec (identical for both agents)

Build a simple blog application.

## Public blog
- Home page: list of published posts, newest first. Each entry: title, publication date, short excerpt, link to full post.
- Post page: each post has its own URL. Show title, publication date, content. Return an appropriate 404 when a post does not exist.

## Blog management
Simple interface to: view posts, create, edit, delete, publish/unpublish. No authentication; do not add any.

## Post model (minimum)
Unique ID, title, slug, content, published status, created timestamp, updated timestamp, published timestamp.
Validate required fields. Slugs must be URL-suitable.

## Persistence
Posts must survive application/server restarts. Choose the simplest reasonable mechanism; no unnecessary infrastructure.

## HTTP interface
Sensible routes; appropriate methods, status codes, validation, error handling, not-found handling. Route structure is your decision.

## UI
Clean, simple, responsive (desktop + mobile). Not a visual-design benchmark; don't spend much on styling. Avoid large frontend frameworks unless clearly justified.

## Testing
Automated tests covering at minimum: application starts; blog index loads; empty blog works; create; edit; delete; publish; unpublish; published post appears publicly; unpublished post does not appear publicly; individual post page loads; missing post returns 404; invalid input rejected; data survives restart.

## Working rules
- Work ONLY inside your own assigned directory. Do not read, list or touch any sibling directory under /Users/jimhoyd/Projects/urlcode-benchmarks/ or any other agent's work.
- No human is available; do not ask questions, decide yourself.
- Do not stop until the app runs, the tests pass, and you have covered all requirements.
- When finished, write REPORT.md in your directory listing: how to run the app and tests, files created, key design decisions, and anything you could not do. Keep it brief.
