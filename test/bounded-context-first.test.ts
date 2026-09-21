import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderAgentsGuide } from '../src/agents-guide.ts';

// #344: the first authoring step is one bounded query (get_context / `urlcode context`); the
// broad catalogs are deliberate fallback. Every agent surface must agree on that order.
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const order = (text: string, first: RegExp, later: RegExp) => {
  const a = text.search(first), b = text.search(later);
  assert.ok(a >= 0, `missing ${first}`);
  assert.ok(b >= 0, `missing ${later}`);
  assert.ok(a < b, `${first} must precede ${later}`);
};

test('generated AGENTS.md leads with context, then task-scoped retrieval, catalogs as fallback', () => {
  const guide = renderAgentsGuide({ routes: 2 });
  order(guide, /`get_context`/, /`capabilities NAME`/);
  order(guide, /`urlcode context --project DIR`/, /`get_schema`/);
  order(guide, /`get_context`/, /`recipes list`/);
  for (const need of ['--budget', 'search_recipes', 'explain', 'get_extensions', 'fallback', 'capability gap']) assert.ok(guide.includes(need), need);
  assert.ok(!/^\d+\. Run `urlcode capabilities` to see/m.test(guide), 'bare capabilities must not be a first step');
  assert.ok(guide.includes('## Functions and middleware are trusted by default; sandbox is opt-in'));
});

test('skills and AI-AUTHORING agree on the bounded-first order', async () => {
  for (const path of ['skills/urlcode/SKILL.md', '.claude/skills/urlcode-authoring/SKILL.md', 'packaging/claude-plugin/skills/urlcode-authoring/SKILL.md']) {
    const text = await read(path);
    order(text, /get_context/, /get_capability|capabilities NAME/);
    assert.match(text, /deliberate\s+fallback/i, path);
    assert.match(text, /get_extensions/, path);
  }
  const doc = await read('docs/AI-AUTHORING.md');
  const first = doc.indexOf('## First step: one bounded query');
  assert.ok(first > 0 && first < doc.indexOf('## Sources of truth and reading order'), 'bounded query must open AI-AUTHORING');
  const section = doc.slice(first, doc.indexOf('## Declarative-first default'));
  for (const need of ['get_context', 'urlcode context --project DIR', '--budget', 'capabilities NAME', 'get_schema', 'search_recipes', 'explain', 'get_extensions', 'llms-full.txt', 'fallback', 'never hides a']) assert.ok(section.includes(need), need);
});
