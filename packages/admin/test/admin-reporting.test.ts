import test from 'node:test';
import assert from 'node:assert/strict';
import { auditFilters, csvCell, nextPage, selectedAccounts, selectedField, usersCsv } from '../src/admin-reporting.ts';
test('CSV cells quote delimiters and neutralize spreadsheet formulas including leading whitespace', () => {
    for (const value of ['=SUM(1,2)', ' +1', '-1', '@name', '\tcommand', '\rcommand', '\ncommand', '\uFEFF=1'])
        assert.ok(csvCell(value).startsWith('"\''));
    assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
    assert.throws(() => usersCsv(Array.from({ length: 51 }, () => ({ id: 'id', email: 'x@example.test', status: 'active' as const, roles: [], created: 0, emailVerified: false, totpEnabled: false }))));
});
test('audit filters reject ambiguous or invalid dates and pagination preserves active filters', () => {
    assert.deepEqual(auditFilters(new URLSearchParams('action=session.login&from=2026-09-01T00%3A00Z&to=2026-09-02T00%3A00Z')), { limit: 50, order: 'desc', action: 'session.login', from: Date.parse('2026-09-01T00:00Z'), to: Date.parse('2026-09-02T00:00Z') });
    assert.deepEqual(auditFilters(new URLSearchParams('source=store&order=asc')), { limit: 50, order: 'asc', source: 'store' });
    for (const query of ['from=2026-02-30T00%3A00Z', 'from=bad', 'action=a&action=b', 'from=2026-09-02T00%3A00Z&to=2026-09-01T00%3A00Z', 'order=newest', 'unknown=x'])
        assert.throws(() => auditFilters(new URLSearchParams(query)));
    assert.equal(nextPage('/admin/users', new URLSearchParams('query=a%40b&role=member&ignored=bad'), 'cursor', ['query', 'role']), '/admin/users?query=a%40b&role=member&after=cursor');
});
test('native checkbox selection is bounded, unambiguous and rejects duplicate bulk IDs', () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    assert.ok(selectedField.test('selected.' + id));
    assert.ok(!selectedField.test('selected.' + id + 'x'));
    assert.deepEqual(selectedAccounts({ ['selected.' + id]: 'yes' }), [id]);
    assert.throws(() => selectedAccounts({ accountIds: id + ',' + id }));
    assert.throws(() => selectedAccounts({ accountIds: id, ['selected.' + id]: 'yes' }));
    assert.throws(() => selectedAccounts({}));
    assert.throws(() => selectedAccounts({ accountIds: Array.from({ length: 51 }, (_, i) => String(i)).join(',') }));
});
test('expanded user filters validate booleans and UTC ranges while preserving every filter through pagination', async () => {
    const { userFilters, userFilterKeys, userFilterFields } = await import('../src/admin-reporting.ts');
    const values = new URLSearchParams({ query: 'A***@example.test', role: 'member', status: 'active', method: 'passkey', verified: 'false', locale: 'fr', createdFrom: '2026-01-01T00:00Z', createdTo: '2026-09-01T00:00Z', lastSeenFrom: '2026-08-01T00:00Z', lastSeenTo: '2026-09-01T00:00Z', sort: 'lastSeen', direction: 'desc', lang: 'fr' });
    const result = userFilters(values);
    assert.equal(result.method, 'passkey');
    assert.equal(result.verified, false);
    assert.equal(result.limit, 50);
    assert.equal(result.lastSeenFrom, Date.parse('2026-08-01T00:00Z'));
    const next = new URL(nextPage('/admin/users', values, 'opaque_cursor', userFilterKeys), 'https://example.test');
    for (const [key, value] of values)
        assert.equal(next.searchParams.get(key), value);
    // A normal browser GET submits default sort controls even when advanced fields stay closed.
    assert.doesNotMatch(userFilterFields(new URLSearchParams({query:'reader',status:'active',sort:'id',direction:'asc'}),x=>x), /<details class="ui-filter" open>/);
    for (const advanced of [{sort:'email'}, {direction:'desc'}, {role:'member'}, {verified:'false'}])
        assert.match(userFilterFields(new URLSearchParams(advanced),x=>x), /<details class="ui-filter" open>/);
    const fields = userFilterFields(values, x => x);
    assert.match(fields, /name="method"/);
    assert.match(fields, /value="passkey" selected/);
    assert.match(fields, /value="false" selected/);
    assert.match(fields, /value="desc" selected/);
    assert.match(fields, /name="locale" value="fr"/);
    // Syntax is admin's; the values themselves (sort, method, locale, range order) are validated by auth (admin-user-filters.test.ts).
    for (const invalid of ['verified=yes', 'verified=true&verified=false', 'createdFrom=2026-02-30T00%3A00Z', 'lastSeenFrom=-1', 'unexpected=field'])
        assert.throws(() => userFilters(new URLSearchParams(invalid)));
    assert.match(userFilterFields(new URLSearchParams({ query: '"><script>alert(1)</script>' }), x => x), /&lt;script&gt;/);
});
