# Prompts used for baseline run 1

Both agents ran as Sonnet 5 (the Agent tool's `sonnet` model). The thinking level could not be set or confirmed.
Working directories were separate and outside the repository.

## Shared specification (identical in both prompts)

Users must be able to: view todos; create a todo; edit a todo; mark complete; mark incomplete; delete a todo; filter by All / Active / Completed.
Each todo has: unique ID, title, optional description, completed status, created timestamp, updated timestamp.
UI: clean responsive web interface (desktop and mobile) with application title, todo creation form, todo list, completion state, edit control, delete control, filters, remaining todo count, and an empty state.
Persistence: todos must survive application/server restarts; choose an appropriately simple mechanism.
HTTP interface: operations equivalent to list todos, retrieve one todo, create todo, update todo, toggle completion, delete todo, with appropriate HTTP methods, status codes, validation and error handling.
Quality: runs locally; includes automated tests; handles invalid input; handles nonexistent todos; persists data; avoids obvious security problems; clear project structure; README with install and run instructions.
Run your test suite before declaring completion. Continue until you believe the application is complete, then reply with a short summary. Do not ask questions; make your own decisions.

## Agent A (control) framing

Build a complete, working Todo web application. Work only inside the agent's own directory. Use whatever conventional technologies and architecture you naturally judge appropriate (Node v26 and npm 11 installed; network access). No mention of URLCode.

## Agent B (URLCode) framing

Build the application using URLCode (https://github.com/jimhoyd-com/urlcode). Work only inside the agent's own directory; it may clone the repository or install from npm. Begin by discovering how URLCode works from the repository itself: README/documentation, llms.txt, AI guidance, schemas, examples, recipes, packages, extensions and CLI capabilities. Principle: use URLCode's highest-level declarative features whenever possible; generate custom JavaScript only when the framework cannot express the requirement. Treat URLCode as the application framework rather than merely a host for a conventional Node app. Also run URLCode's validation tooling, and in the final summary honestly list every place a capability could not be found, was confusing, or needed custom JavaScript.

Note: B's prompt asked for that final gap list; A's prompt had no equivalent.
