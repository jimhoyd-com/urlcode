# Acceptance: small JSON API

`requests.json` is run unchanged against both arms. Bodies are compared
exactly, so the JSON must be compact (no whitespace) with the keys in the
order the task lists them.
