# Contributing

Read SECURITY.md and CONTRACT.md. Keep Apache-2.0 licensing and do not publish
packages without explicit authorization. Work on branches and pull requests; never
bypass reviews/checks. Keep production code dependency-free and free of Node-specific
APIs, authentication decisions, database access, project-code evaluation and secrets.

Run npm run verify. Changes to public exports require an actual packed consumer test
with core, auth and admin. Do not commit dist, node_modules, fixture credentials or
real data. Record accessibility/security limitations honestly.
