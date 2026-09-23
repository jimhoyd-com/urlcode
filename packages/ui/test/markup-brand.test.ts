import test from 'node:test';
import assert from 'node:assert/strict';

// #524: composing extension bundles (ui + auth + admin) makes each bundle extract its own copy of
// @jimhoyd/urlcode-ui into a separate content-hash-keyed cache directory, so a composed host ends up with more
// than one loaded module instance of this same source. A Markup value built by one instance's `markup()` used to
// fail a plain `instanceof Markup` check performed against another instance's class, even though both classes come
// from identical source -- the renderer then treated the wrapped safe-HTML value as a plain object and threw
// "object placed as text: content" instead of unwrapping it.
//
// isMarkup() now also checks a Symbol.for('urlcode.ui.Markup')-keyed structural brand. Symbol.for returns the
// same symbol across separately loaded module instances in one process (unlike a locally scoped Symbol()), so the
// brand check survives the module-instance boundary that `instanceof` cannot cross. This test loads the compiled
// escape module twice under distinct specifiers -- via a cache-busting query string, the same trick a Node ESM
// loader uses to force two separate module instances -- to simulate the standalone `ui` bundle's copy and an
// auth/admin bundle's embedded copy of the identical source, without needing a full bundle pack/extract cycle.
test('isMarkup recognizes Markup instances built by a separately loaded copy of this same module (#524)', async () => {
    const specifier = new URL('../src/escape.ts', import.meta.url).href;
    const moduleA = await import(specifier) as typeof import('../src/escape.ts');
    const moduleB = await import(`${specifier}?instance=b`) as typeof import('../src/escape.ts');

    // Sanity check the premise: these really are two distinct module instances with two distinct classes.
    assert.notEqual(moduleA.Markup, moduleB.Markup, 'the two imports must resolve to distinct Markup classes');

    const fromA = moduleA.markup('<p>from module A</p>');
    const fromB = moduleB.markup('<p>from module B</p>');

    // Same-instance checks keep working via the instanceof fast path.
    assert.equal(moduleA.isMarkup(fromA), true);
    assert.equal(moduleB.isMarkup(fromB), true);

    // instanceof alone would fail cross-instance -- this is the reported bug.
    assert.equal(fromB instanceof moduleA.Markup, false, 'instanceof cannot see across module instances');
    assert.equal(fromA instanceof moduleB.Markup, false, 'instanceof cannot see across module instances');

    // isMarkup(), via the structural brand, recognizes a Markup value regardless of which loaded copy built it.
    assert.equal(moduleA.isMarkup(fromB), true, 'module A must recognize Markup built by module B');
    assert.equal(moduleB.isMarkup(fromA), true, 'module B must recognize Markup built by module A');

    // Plain objects, including ones that merely look like Markup, are still rejected by both.
    assert.equal(moduleA.isMarkup({ html: '<p>not markup</p>' }), false);
    assert.equal(moduleB.isMarkup({ html: '<p>not markup</p>' }), false);
    assert.equal(moduleA.isMarkup(null), false);
    assert.equal(moduleA.isMarkup(undefined), false);
});
