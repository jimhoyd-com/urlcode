# Benchmark evidence: raw transcript policy

Status: **proposed**, awaiting the maintainer's decision on
[issue 349](https://github.com/jimhoyd-com/urlcode/issues/349). Nothing here is
implemented behavior, and no transcript is deleted or moved by this page.

## Current situation

Issue 349 was filed when this repository held two conflicting transcript
policies: a Todo README said transcripts are not committed, while the Hello
World and Blog runs committed four raw transcripts (1,346,830 bytes) so an
in-repo summarizer could reproduce metrics.

That is now overtaken. Commit 98dae3a moved all benchmark assets out of this
repository into the separate
[URLCode benchmark repository](https://github.com/jimhoyd-com/urlcode-benchmark):

- This repository no longer contains `benchmarks/ab`, `benchmarks/results`,
  `docs/benchmarks`, any transcript, or the summarizer. Ordinary source search
  here is no longer affected.
- The four transcripts (218,202, 261,495, 302,751 and 564,582 bytes) now sit
  verbatim, unredacted and unreviewed, under `legacy/` in the benchmark
  repository, which is **public**. The scope of the risk did not shrink; it
  moved to a public repository.
- The benchmark repository's `docs/RESULT-BUNDLES.md` says to keep `raw/`
  transcripts in Git "after removing credentials and private data", and its
  `docs/REPOSITORY-SECURITY.md` says raw bundles "must be reviewed and
  redacted before commit". There is no checklist, scan, size budget or
  retention period behind either sentence, and the legacy snapshot was not
  held to it.
- The stale reference to issue 310 lived in the deleted A/B tooling guide. No
  file in this repository references it now, and 310 does not resolve here
  (`gh issue view 310` finds no issue or pull request), so there is nothing to
  relink. Its successors are benchmark repository issues 12 and 13.

## Recommendation

One policy per class of evidence:

| Class | Where it lives | Retained in Git |
|---|---|---|
| Raw agent transcripts (Hello World, Todo, Blog, later runs) | Never in this repository. In the benchmark repository, only as a redacted transcript that passed the checklist below, or else as a private release asset or Actions artifact | Redacted transcript, or a SHA-256 digest plus size for anything kept private |
| Derived metrics, reports, prompts, acceptance output | Benchmark repository (`runs/`) | Yes, in full |
| Summarizer, fixtures, task definitions | Benchmark repository | Yes. Fixtures are synthetic, never real transcripts |
| Runtime-performance JSON | Benchmark repository | Yes |
| This repository | Prose that links to the above | No evidence files |

Rules that apply to every retained transcript:

1. **Review before publication.** The maintainer, or a reviewer the maintainer
   names, signs off in the pull request that adds the run. An agent that
   produced the run cannot be its only reviewer.
2. **Redaction checklist.** Remove or replace: API keys, tokens and cookies;
   `Authorization` and similar headers; environment variable values; home
   directory paths (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`);
   email addresses; hostnames and URLs of private services; customer data;
   and any tool output that echoes a file outside the task workspace. Record
   what was replaced in a `REDACTION.md` next to the bundle. Redaction changes
   only strings, never message order or token counts.
3. **Scan script.** The benchmark repository's `verify` job runs a script that
   fails on: high-entropy strings and known token prefixes (`sk-`, `ghp_`,
   `github_pat_`, `AKIA`, `xox`, JWT shape), `Bearer `/`Cookie:` values, home
   paths, email addresses, and non-synthetic hostnames. Findings need an
   explicit allowlist entry with a reason. The scan is a floor, not a review.
4. **Size budget.** Committed transcripts stay under 1 MB per run and 5 MB in
   total. Anything larger becomes a private release asset with a committed
   digest.
5. **Retention.** Public raw transcripts are kept 12 months after the run's
   report is published, then replaced by the derived metrics and digest. A
   leaked secret is rotated first and the file removed from history second.
6. **Findability.** Transcripts stay under one directory that
   `.gitattributes` marks `linguist-generated` and that `.ignore` excludes
   from ripgrep-style searches.

## Alternatives rejected

- **Keep raw transcripts in this repository, redacted.** Rejected: it recreates
  the noisy-search and review-burden problem that commit 98dae3a removed, and
  it ties core releases to evidence that does not affect the runtime.
- **Commit them unredacted, as today's legacy snapshot does.** Rejected: the
  repository is public and no one has reviewed the content.
- **Never retain raw transcripts; publish only metrics.** Rejected for
  transcript-derived claims (token counts, tool-call counts, friction
  findings): readers cannot check them. Acceptable for classes that make no
  such claim, so it remains the fallback when a transcript cannot be redacted.
- **Private store only, with no public digest.** Rejected: an unverifiable
  claim is nearly as weak as no evidence. Digests are cheap.
- **Delete the legacy snapshot now.** Not decided here. It is a maintainer
  decision (see the questions below), and history keeps the files regardless.

## Follow-up work

Each item is small and belongs in the benchmark repository unless marked.

1. Scan the four legacy transcripts with the checklist, publish the findings
   privately, and rotate anything real. Size: S.
2. Add `scripts/scan-transcripts.mjs` and a `verify` step that runs it over
   `runs/**/raw` and any un-allowlisted transcript. Size: S.
3. Add the checklist, budget and retention text to `docs/RESULT-BUNDLES.md` and
   `docs/REPOSITORY-SECURITY.md`; replace their unqualified sentences. Size: S.
4. Add a `REDACTION.md` template to `templates/`. Size: XS.
5. Add `.ignore` and `.gitattributes` entries for transcript directories.
   Size: XS.
6. Act on the legacy snapshot per the maintainer's answer: redact in place,
   move to a release asset with digests, or leave with a warning in
   `legacy/README.md`. Size: S to M.
7. In this repository, close issue 349 once items 2, 3 and 6 land. Size: XS.

## Questions for the maintainer

1. Is the legacy snapshot's public exposure acceptable while item 1 runs, or
   should the transcripts be made unavailable immediately?
2. Should `legacy/` be rewritten (which alters history) or only changed going
   forward?
3. Is a 12-month retention period right, and who is the named reviewer?
4. Are the 1 MB and 5 MB budgets acceptable?
5. Do you want private release assets, or is redact-and-commit sufficient?
