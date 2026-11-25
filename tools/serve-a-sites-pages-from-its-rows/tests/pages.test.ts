// Page rows: each is checked before it is served, and a path is matched to exactly one page, a literal part beating a ":name".
import test from 'node:test';
import assert from 'node:assert/strict';
import { filledInput, matchPage, pageOf, pagesOf, pathWith, slugsSql } from '../do-work/pages.ts';

const row = (fields: Record<string, unknown>) => ({ title: 'A page', access: 'public', layout: null, tool: 'tool:read-a-thing', input: {}, collection: null, updated_at: '2026-11-25 08:00:00+00', ...fields });

test('a template page fills ":slug" from its path, and a literal part beats a ":name" part', () => {
  const { pages } = pagesOf([
    row({ path: '/courses/:slug', input: { course: ':slug', show: 'all' } }),
    row({ path: '/courses/new' }),
    row({ path: '/', tool: null, layout: { part: 'ui/show/text/Text.tsx', export: 'Text', children: [{ text: 'Home' }] } }),
  ]);
  const course = matchPage(pages, '/courses/forehand%20basics')!;
  assert.equal(course.page.path, '/courses/:slug');
  assert.deepEqual(course.params, { slug: 'forehand basics' });
  assert.deepEqual(filledInput(course.page.input, course.params), { course: 'forehand basics', show: 'all' });
  const query = new URLSearchParams({ token: 't-1' });
  assert.deepEqual(filledInput({ token: ':query.token', other: ':query.other', list: [':query.token', ':query.other'], slug: ':slug' }, { slug: 's' }, query),
    { token: 't-1', list: ['t-1', null], slug: 's' }, 'a ":query.key" string takes the query value; one the address lacks is left out');
  assert.equal(matchPage(pages, '/courses/new')!.page.path, '/courses/new');
  assert.equal(matchPage(pages, '/')!.page.path, '/');
  assert.equal(matchPage(pages, '/courses/')!, null, 'an empty value is no slug');
  assert.equal(matchPage(pages, '/courses/a/b'), null);
  assert.equal(matchPage(pages, '/nothing'), null);
  assert.equal(matchPage(pages, '/courses/%E0%A4%A'), null, 'a broken escape is no match');
});

test('a row that breaks a rule is refused with its path and why', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [row({ path: 'courses' }), /path is/],
    [row({ path: '/a', title: ' ' }), /title/],
    [row({ path: '/a', layout: [{ part: 'Screen' }] }), /layout\[0\]: part/],
    [row({ path: '/a', layout: [{ go_to: '/b' }] }), /go_to is a whole layout/],
    [row({ path: '/a', layout: [{ words: true }] }), /only in the \/404 row/],
    [row({ path: '/404', layout: [{ words: true, props: {} }] }), /stands alone/],
    [row({ path: '/a', layout: { go_to: 'javascript:alert(1)' } }), /go_to is an http/],
    [row({ path: '/a', access: 'everyone' }), /access/],
    [row({ path: '/a', tool: 'read-a-thing' }), /tool is/],
    [row({ path: '/a', tool: null, layout: null }), /a layout, a tool, or both/],
    [row({ path: '/a', collection: 'courses; drop table pages' }), /collection/],
    [row({ path: '/a', input: { course: ':slug' } }), /does not hold/],
    [row({ path: '/a', layout: { part: '../../etc/passwd.tsx' } }), /screen file/],
    [row({ path: '/a', layout: { part: 'take-payments/do-work/take-payments.ts' } }), /screen file/],
    [row({ path: '/a', layout: { part: 'ui/show/text/Text.tsx', export: 'Text; evil' } }), /export/],
    [row({ path: '/a', tool: null, layout: { main: true } }), /main/],
    [row({ path: '/a', layout: { part: 'ui/show/text/Text.tsx', children: [{ tool: 'nope' }] } }), /children\[0\]: tool/],
    [row({ path: '/a', layout: { tool: 'tool:read-c', part: 'c/do-work/c.ts' } }), /screen file/],
    [row({ path: '/a', layout: { tool: 'tool:read-c', export: 'Other' } }), /names no part/],
  ];
  for (const [bad, why] of cases) assert.throws(() => pageOf(bad), why, JSON.stringify(bad));
  const twice = pagesOf([row({ path: '/c/:a' }), row({ path: '/c/:b' }), row({ path: 'bad' })]);
  assert.deepEqual(twice.pages.map(p => p.path), ['/c/:a']);
  assert.deepEqual(twice.refused.map(r => r.path), ['/c/:b', 'bad'], 'a broken or doubled row is set aside, the rest served');
  assert.match(twice.refused[0].why, /same address pattern/);
  assert.equal(pagesOf([row({ path: '/c' }), row({ path: '/c', host: 'app.example.test' })]).pages.length, 2, 'one address may have a row per host');
  assert.equal(pageOf(row({ path: '/t/:slug', title: null, input: { s: ':slug' } })).title, null, 'a template page may take its title from its tool');
  assert.throws(() => pageOf(row({ path: '/t', title: null, tool: null, layout: { text: 'x' } })), /title/);
  assert.deepEqual(pageOf(row({ path: '/l', layout: [{ text: 'a' }, { main: true }] })).layout, { nodes: [{ text: 'a' }, { main: true }] }, 'a layout may be a list');
  assert.equal(pageOf(row({ path: '/e', layout: [] })).layout, null, 'an empty list is no layout');
  assert.throws(() => pageOf(row({ path: '/c', host: 'App Example' })), /host is/);
});

test('a layout keeps its parts, tool screens, main node and words as given', () => {
  const page = pageOf(row({
    path: '/', layout: {
      part: 'ui/show/site-nav/SiteNav.tsx', export: 'SiteNav', props: { nav: [] }, children: [
        { main: true }, { tool: 'tool:read-prices', input: { offer: 'year' } }, { text: 'Fine print' },
      ],
    },
  }));
  assert.deepEqual(page.layout, {
    part: 'ui/show/site-nav/SiteNav.tsx', export: 'SiteNav', props: { nav: [] }, children: [
      { main: true }, { tool: 'tool:read-prices', input: { offer: 'year' } }, { text: 'Fine print' },
    ],
  });
});

test('a collection lists its slugs by a quoted table name, and a path is rebuilt from its values', () => {
  assert.equal(slugsSql('courses'), 'SELECT slug FROM "courses" WHERE slug IS NOT NULL ORDER BY slug');
  assert.throws(() => slugsSql('x"; drop table pages; --'), /not a table name/);
  assert.equal(pathWith('/courses/:slug', { slug: 'a b/c' }), '/courses/a%20b%2Fc');
});

test('a literal path part may hold a colon after its first character, and matches whether the address sends it as is or encoded', () => {
  const pages = [pageOf(row({ path: '/before-booking/offer:one' })), pageOf(row({ path: '/before-booking/:offer' }))];
  assert.equal(matchPage(pages, '/before-booking/offer:one')?.page.path, '/before-booking/offer:one');
  assert.equal(matchPage(pages, '/before-booking/offer%3Aone')?.page.path, '/before-booking/offer:one');
  assert.deepEqual(matchPage(pages, '/before-booking/offer:two')?.params, { offer: 'offer:two' });
  assert.throws(() => pageOf(row({ path: '/:offer:one' })), /path is/);
});
