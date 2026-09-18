# Acceptance: static site plus API

`requests.json` is run unchanged against both arms. Page bodies are not
compared (the agent writes them); their status and content type are. The
stylesheet body is fixed by the task so it is compared exactly.
