// tools/write-public-share-files/test/share-files.test.mjs
//
// The public files of shares (do-work/share-files.mjs), moved from the cases of Trillion's test/record-share-pages.test.mjs
// and test/record-sharing.test.mjs that read a share's public output: a listed list link is a set of indexed pages named
// in sitemap.xml and llms.txt; a shared list reads as data with its rows and the files they name; comparison evidence
// stays off listings; a public list link gets a readable address and leaves search results when revoked; one row is
// shared on its own; links for named people, ended links, links with their own condition, match-only fields and rules
// a static file cannot check have no public files. Every name and address here is made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { filterRecords } from '../../formulas/do-work/requests.mjs';
import { linkOpen, listRows, shareFiles } from '../do-work/share-files.mjs';

const ORIGIN = 'https://share.example';
const NOW = Date.parse('2026-10-05T12:00:00Z');
const filterRows = ({ tree, fields, rows }) => { const { matches, incomplete } = filterRecords({ tree, fields, records: rows }); return { matches, incomplete }; };
const CODE = 'c'.repeat(48);
const grantOf = (extra = {}) => ({ share_id: 's1', code: CODE, scope: { kind: 'public' }, can: ['view'], created_at: '2026-10-01T00:00:00Z', expires_at: null, revoked_at: null, ...extra });
const compared = {
  label: 'Bakery compared', about: 'How each bakery compares, from its own pages.',
  fields: [{ id: 'title', label: 'Name', kind: 'text' }, { id: 'summary', label: 'In short', kind: 'long-text' }, { id: 'source', label: 'Their page', kind: 'link-address' }, { id: 'checked', label: 'Checked', kind: 'date', action: { secret: 'NOT SHARED' } }],
};
const comparedRows = [
  { id: 'r1', title: 'North vs South', values: { title: 'North vs South', summary: 'North bakes at dawn.', source: 'https://north.example/about', checked: '2026-10-04', supplier_cost: 'PRIVATE COST' } },
  { id: 'r2', title: 'Pay', values: { title: 'Pay', summary: 'A row whose name is one of a link\'s own parts.' } },
];
const run = (shares, now = NOW) => shareFiles({ origin: ORIGIN, now, shares, filterRows });
const share = (extra = {}) => ({ sharing: { record: 'list:compared', leave_out: [], match_only: [] }, grant: grantOf(), list: compared, rows: comparedRows, files: [], ...extra });
const at = (out, path) => out.files.find(file => file.path === path);

test('a listed list link is a set of indexed pages, one per row, named in the sitemap and llms.txt', async () => {
  const out = await run([share({ grant: grantOf({ address: 'bakery-compared', listed: true }) })]);
  assert.deepEqual(out.published, [{ code: CODE, name: 'bakery-compared', listed: true }]);
  const list = at(out, 'bakery-compared/index.html').text;
  assert.doesNotMatch(list, /noindex/);
  assert.match(list, /"@type":"CollectionPage"/);
  assert.match(list, /href="\/share\/bakery-compared\/north-vs-south"/);
  assert.match(list, /href="\/share\/bakery-compared\/pay-row"/);
  assert.doesNotMatch(list, /NOT SHARED|PRIVATE COST/);
  const row = at(out, 'bakery-compared/north-vs-south/index.html').text;
  assert.match(row, /<h1>North vs South<\/h1>/);
  assert.match(row, /"@type":"Article"/);
  assert.match(row, /href="https:\/\/north\.example\/about"/);
  assert.match(row, /rel="canonical" href="https:\/\/share\.example\/share\/bakery-compared\/north-vs-south"/);
  assert.equal(at(out, 'bakery-compared/no-such-row/index.html'), undefined);
  const sitemap = at(out, 'sitemap.xml').text;
  assert.match(sitemap, /<loc>https:\/\/share\.example\/share\/bakery-compared<\/loc><lastmod>2026-10-04<\/lastmod>/);
  assert.match(sitemap, /<loc>https:\/\/share\.example\/share\/bakery-compared\/north-vs-south<\/loc><lastmod>2026-10-04<\/lastmod>/);
  assert.match(at(out, 'llms.txt').text, /- \[North vs South\]\(https:\/\/share\.example\/share\/bakery-compared\/north-vs-south\): North bakes at dawn/);

  // An unlisted link stays out of search results and out of both documents.
  const unlisted = await run([share({ grant: grantOf({ address: 'bakery-compared' }) })]);
  assert.match(at(unlisted, 'bakery-compared/index.html').text, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(at(unlisted, 'bakery-compared/index.html').text, /rel="canonical"/);
  assert.doesNotMatch(at(unlisted, 'sitemap.xml').text + at(unlisted, 'llms.txt').text, /bakery-compared/);
});

test('a shared list reads as data with its rows and the files they name, whole and never paged', async () => {
  const identity = `1f:${'d'.repeat(64)}`;
  const hidden = `1f:${'e'.repeat(64)}`;
  const asked = [];
  const out = await run([share({ grant: grantOf({ address: 'changelog' }), list: { label: 'Changelog', about: 'What changed.', share_when: null,
    fields: [{ id: 'title', label: 'Name', kind: 'text' }, { id: 'picture', label: 'Picture', kind: 'file' }, { id: 'shown', label: 'Shown when', kind: 'shown-when' }] },
  rows: [{ id: 'r1', title: 'Lists share as pages', values: { title: 'Lists share as pages', picture: '/Changelog/lists.png' } },
    { id: 'r2', title: 'Draft', values: { title: 'Draft', picture: '/Changelog/draft.png', shown: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'title', operator: 'is_any_of', params: { values: ['Never'] } }] } } }],
  fileOf: async name => { asked.push(name); return name === '/Changelog/lists.png' ? { identity, media_type: 'image/png', names: [name], origin: 'private-bucket' } : { identity: hidden, media_type: 'image/png' }; } })]);
  assert.deepEqual(asked, ['/Changelog/lists.png'], 'a hidden row\'s file is never looked up');
  const data = JSON.parse(at(out, `${CODE}.json`).text);
  assert.deepEqual(data, JSON.parse(at(out, 'changelog.json').text), 'the readable address reads the same data');
  assert.deepEqual(Object.keys(data).sort(), ['about', 'changed', 'fields', 'files', 'kind', 'rows', 'title']);
  assert.equal(data.kind, 'list');
  assert.equal(data.title, 'Changelog');
  assert.deepEqual(data.fields.map(field => field.id), ['title', 'picture'], 'the rule field never leaves');
  assert.deepEqual(data.rows, [{ id: 'r1', title: 'Lists share as pages', address: 'lists-share-as-pages', url: 'https://share.example/share/changelog/lists-share-as-pages', values: { title: 'Lists share as pages', picture: identity } }]);
  assert.deepEqual(data.files, [{ identity, name: '/Changelog/lists.png', url: `https://share.example/share/files/${identity}`, media_type: 'image/png' }]);
  assert.equal('has_more' in data || 'next' in data, false);
  assert.deepEqual(at(out, `files/${identity}`), { path: `files/${identity}`, media_type: 'image/png', identity });
  assert.equal(at(out, `files/${hidden}`), undefined, 'only files a shown row names');
  assert.doesNotMatch(JSON.stringify(out), /private-bucket|Draft/);
  assert.match(at(out, 'changelog/lists-share-as-pages/index.html').text, new RegExp(`<img src="/share/files/${identity}"`));
});

test('comparison evidence rows stay out of sitemap and llms listings', async () => {
  const out = await run([share({ grant: grantOf({ address: 'compared', listed: true }), list: { label: 'Compared', about: 'Choices',
    fields: [{ id: 'title', label: 'Name', kind: 'text' }, { id: 'record_kind', label: 'Kind', kind: 'choice' }],
    public_page: { layout: 'comparison', evidence_rows: { kind_field: 'record_kind', comparison_kind: 'comparison' } } },
  rows: [{ id: 'comparison', title: 'North vs Paper', values: { title: 'North vs Paper', record_kind: 'comparison' } },
    { id: 'source', title: 'Paper source', values: { title: 'Paper source', record_kind: 'source' } }] })]);
  const listings = at(out, 'sitemap.xml').text + at(out, 'llms.txt').text;
  assert.match(listings, /north-vs-paper/);
  assert.doesNotMatch(listings, /paper-source/);
  assert.doesNotMatch(at(out, 'compared/index.html').text, /paper-source/);
});

test('links for named people, an email, an audience or an access code have no public files', async () => {
  for (const scope of [{ kind: 'email', value: 'bo@people.example' }, { kind: 'people', value: ['relay:a'] }, { kind: 'audience', value: 'audience:members' }, { kind: 'code', value: 'secret' }]) {
    const out = await run([share({ grant: grantOf({ scope, address: 'bakery-compared', listed: true }) })]);
    assert.deepEqual(out.published, []);
    assert.equal(out.left_out.length, 1);
    assert.deepEqual(out.files.map(file => file.path).sort(), ['llms.txt', 'sitemap.xml']);
    assert.doesNotMatch(JSON.stringify(out), /North vs South|bo@example/);
  }
});

test('a revoked, expired, unpublished or invalidly dated link is ended and has no files; an open one is woken at its expiry', async () => {
  for (const ended of [{ revoked_at: '2026-10-05T00:00:00Z' }, { expires_at: '2026-10-05T11:59:59Z' }, { published: false }, { expires_at: 'not a date' }]) {
    const out = await run([share({ grant: grantOf({ ...ended, address: 'bakery-compared', listed: true }) })]);
    assert.deepEqual(out.ended, [CODE]);
    assert.deepEqual(out.published, []);
    assert.doesNotMatch(JSON.stringify(out.files), /bakery-compared|North/);
  }
  const open = await run([share({ grant: grantOf({ expires_at: '2026-10-06T00:00:00Z' }) })]);
  assert.equal(open.next_change_at, '2026-10-06T00:00:00.000Z');
  assert.equal(linkOpen(grantOf({ expires_at: '2026-10-06T00:00:00Z' }), Date.parse('2026-10-06T00:00:00Z')), false, 'a link ends at its expiry');
});

test('a public list link gets a readable address, or keeps its code when its address is not a valid one or names the folder', async () => {
  for (const [address, name] of [['bakery-flavours', 'bakery-flavours'], ['Not Allowed', CODE], ['files', CODE], ['manifest', CODE], [undefined, CODE]]) {
    const out = await run([share({ grant: grantOf({ address }) })]);
    assert.equal(out.published[0].name, name);
    assert.ok(at(out, `${name}/index.html`));
  }
  await assert.rejects(run([share(), share({ sharing: { record: 'list:other' }, grant: grantOf({ share_id: 's2', code: 'd'.repeat(48), address: CODE }) })]), /each readable address belongs to one link/);
});

test('one row of a list is shared on its own: only that row and the files it names leave', async () => {
  const a = `1f:${'a'.repeat(64)}`, b = `1f:${'b'.repeat(64)}`;
  const out = await run([share({ sharing: { record: 'list:compared:rows:r1' }, list: { ...compared, fields: [...compared.fields, { id: 'picture', label: 'Picture', kind: 'file' }] },
    rows: [{ ...comparedRows[0], values: { ...comparedRows[0].values, picture: a } }, { ...comparedRows[1], values: { ...comparedRows[1].values, picture: b } }],
    files: [{ identity: a, media_type: 'image/png' }, { identity: b, media_type: 'image/png' }] })]);
  const data = JSON.parse(at(out, `${CODE}.json`).text);
  assert.deepEqual(data.rows.map(row => row.id), ['r1']);
  assert.deepEqual(data.files.map(file => file.identity), [a]);
  assert.equal(data.title, 'North vs South');
  assert.equal(at(out, `files/${b}`), undefined);
});

test('a link with its own condition, a match-only field, or a row rule a static file cannot check is left out, never shown unchecked', async () => {
  const when = await run([share({ grant: grantOf({ when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'opened', operator: 'less_than', params: { value: 1 } }] } }) })]);
  const matchOnly = await run([share({ sharing: { record: 'list:compared', match_only: ['about'] } })]);
  const rule = field => ({ kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field, operator: 'greater_than', params: { value: 2 } }] });
  const withRule = field => share({ list: { ...compared, fields: [...compared.fields, { id: 'shown', label: 'Shown when', kind: 'shown-when' }] },
    rows: [{ ...comparedRows[0], values: { ...comparedRows[0].values, shown: rule(field) } }] });
  const opens = await run([withRule('opened')]);
  const clock = await run([withRule('now')]);
  for (const out of [when, matchOnly, opens, clock]) {
    assert.deepEqual(out.published, []);
    assert.equal(out.left_out.length, 1);
    assert.doesNotMatch(JSON.stringify(out.files), /North|bakery/i);
  }
  assert.notEqual(opens.left_out[0].because, clock.left_out[0].because);
});

test('a left-out field never leaves the data, the pages or the listings', async () => {
  const out = await run([share({ sharing: { record: 'list:compared', leave_out: ['about'] }, grant: grantOf({ address: 'bakery-compared', listed: true }) })]);
  assert.doesNotMatch(JSON.stringify(out.files), /How each bakery compares/);
  assert.equal(JSON.parse(at(out, `${CODE}.json`).text).about, null);
});

test('row addresses are made from titles, numbered when two read alike, and dated by the newest date field', () => {
  const rows = listRows({ body: { fields: [{ id: 'd', kind: 'date' }], rows: [{ id: '1', title: 'Same', values: { d: '2026-01-02' } }, { id: '2', title: 'Same', values: {} }, { id: '3', title: '', values: {} }] } });
  assert.deepEqual(rows.map(row => [row.address, row.changed]), [['same', '2026-01-02'], ['same-2', null], ['row', null]]);
});

test('a refusal says what the origin must be', async () => {
  await assert.rejects(shareFiles({ origin: 'http://share.example', now: NOW, shares: [], filterRows }), /https address/);
});
