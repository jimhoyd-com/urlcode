import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTemplate, safeHref } from '../src/template.ts';
import type { CompiledTemplate } from '../src/template.ts';
import { markup } from '../src/escape.ts';
import { createPresentation } from '../src/presentation.ts';
const context = createPresentation({ defaults: { 'x.greet': 'Hello {name}', 'x.items': { one: '{count} item', other: '{count} items' } } }).resolve();
const none = () => undefined;
test('values are escaped, trusted markup passes through, and objects or undefined values are errors', () => {
    const t = compileTemplate('demo', '<p title="{{title}}">{{body}}</p>');
    assert.equal(t.render({ title: '"><script>', body: markup('<b>ok</b>') }, context, none).html, '<p title="&quot;&gt;&lt;script&gt;"><b>ok</b></p>');
    assert.equal(t.render({ title: 'x', body: '<i>' }, context, none).html, '<p title="x">&lt;i&gt;</p>');
    assert.throws(() => t.render({ title: 'x' }, context, none), /missing view value: body/);
    assert.throws(() => t.render({ title: 'x', body: { nested: 1 } }, context, none), /object placed as text/);
    assert.equal(t.render({ title: 'x', body: null }, context, none).html, '<p title="x"></p>');
});
test('if, else and each with index flags resolve against the item and then enclosing scopes', () => {
    const t = compileTemplate('list', '{{#if items}}<ul>{{#each items}}<li{{#if @first}} class="first"{{/if}}>{{@index}}:{{name}} of {{owner}}</li>{{/each}}</ul>{{else}}<p>{{t "x.items" count=count}}</p>{{/if}}');
    assert.equal(t.render({ owner: 'Ada', count: 0, items: [{ name: 'a' }, { name: 'b' }] }, context, none).html, '<ul><li class="first">0:a of Ada</li><li>1:b of Ada</li></ul>');
    assert.equal(t.render({ owner: 'Ada', count: 0, items: [] }, context, none).html, '<p>0 items</p>');
    assert.throws(() => t.render({ owner: 'Ada', count: 0, items: 'no' }, context, none), /each needs a list/);
    assert.equal(compileTemplate('strings', '{{#each names}}[{{this}}]{{/each}}').render({ names: ['<a>', 'b'] }, context, none).html, '[&lt;a&gt;][b]');
});
test('copy lookups go through the catalogue and are escaped; helpers format dates, numbers and links safely', () => {
    const t = compileTemplate('copy', '{{t "x.greet" name=who}} <a href="{{href link}}">{{number amount}}</a> {{date when}}');
    const html = t.render({ who: '<b>', link: 'javascript:alert(1)', amount: 1234.5, when: '2026-01-02T03:04:00Z' }, context, none).html;
    assert.ok(html.startsWith('Hello &lt;b&gt; <a href="#">1,234.5</a> '));
    assert.throws(() => compileTemplate('bad', '{{t x.greet}}'), /quoted catalogue key/);
    assert.throws(() => t.render({ who: 'a', link: '/', amount: 'x', when: 1 }, context, none), /number needs a number/);
    for (const [input, expected] of [['/account', '/account'], ['#top', '#top'], ['?page=2', '?page=2'], ['https://example.test/x', 'https://example.test/x'], ['//evil.test', '#'], ['javascript:alert(1)', '#'], ['/a"b', '#'], ['data:text/html,x', '#'], [42, '#']] as const)
        assert.equal(safeHref(input), expected);
});
test('partials render with the current scope, are resolved by name, and cannot recurse without bound', () => {
    const inner = compileTemplate('inner', '<em>{{label}}</em>');
    const outer = compileTemplate('outer', '<div>{{> inner}}</div>');
    const resolve = (name: string): CompiledTemplate | undefined => name === 'inner' ? inner : name === 'outer' ? outer : name === 'self' ? self : undefined;
    const self: CompiledTemplate = compileTemplate('self', '{{> self}}');
    assert.equal(outer.render({ label: '<x>' }, context, resolve).html, '<div><em>&lt;x&gt;</em></div>');
    assert.throws(() => compileTemplate('missing', '{{> nope}}').render({}, context, resolve), /unknown partial/);
    assert.throws(() => self.render({}, context, resolve), /nested too deep/);
    assert.deepEqual([...outer.partials], ['inner']);
});
test('the parser rejects expressions, unbalanced blocks, control characters and oversized sources; view model declarations are read', () => {
    for (const source of ['{{a + b}}', '{{#if a}}', '{{/if}}', '{{else}}', '{{#each a}}{{/if}}', '{{fn()}}', '{{#if a}}{{else}}{{else}}{{/if}}', '{{> ../x}}'])
        assert.throws(() => compileTemplate('bad', source), `accepted ${source}`);
    assert.throws(() => compileTemplate('bad', 'a'), /control characters/);
    assert.throws(() => compileTemplate('bad', 'x'.repeat(262145)), /too large/);
    assert.throws(() => compileTemplate('Bad Name', 'x'), /invalid template name/);
    const t = compileTemplate('auth/sign-in', '{{!-- viewModel: auth/sign-in@2 --}}<form>{{! note }}</form>');
    assert.equal(t.viewModel, 'auth/sign-in@2');
    assert.equal(t.render({}, context, none).html, '<form></form>');
});
test('output and iteration limits stop runaway rendering', () => {
    const t = compileTemplate('big', '{{#each items}}{{this}}{{/each}}');
    assert.throws(() => t.render({ items: Array.from({ length: 10001 }, () => 'x') }, context, none), /too many iterations/);
    assert.throws(() => t.render({ items: Array.from({ length: 9000 }, () => 'x'.repeat(200)) }, context, none), /output exceeds limit/);
});
