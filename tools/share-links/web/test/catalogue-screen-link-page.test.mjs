// Ported from old trillion test/catalogue-screen-link-page.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The facts are web/src/link-page-screen.mjs linkPageFacts. The page's owner
// (src/link-page.mjs makeLinkPage read/change/visit/open) was not carried and no running code in the three repos keeps a
// link page's visits and opens, so the two reads the old test made of it are written below as the state it answered, and
// every assertion on the facts is the old one. Left out: the description checks (drawCatalogueScreen over
// records/marketplace-screens.json and test/fixtures/link-page-descriptions.json, not carried; the rows are only a
// trillion-rust test fixture), 'the account action answers the page's facts' (src/account-action-domain.mjs) and 'the
// Link in bio buttons still send the owner's change' (catalogue layout and src/account-routes.mjs): no running owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkPageFacts } from '../src/link-page-screen.mjs';
import settings from '../src/link-page.json' with { type: 'json' };

const counts = (changes = {}) => ({ recent_days: 30, visits: 0, visits_recent: 0, opens: 0, opens_recent: 0, by_item: [], by_place: {}, ...changes });
// read() of a new page, nothing changed or counted.
const fresh = { on: false, address: null, name: null, title: null, about: null, addresses_by_place: {}, links: [], posts: [], counts: counts() };
// read() after: change({ title: 'Sam', links: [Book] }), visit('first-place'), open(Book, 'second-place') twice and
// open(Book, 'first-place') once, with one posted post (caption 'Spring workshop', first-place).
const BOOK = 'link:0001';
const counted = {
  on: true, address: 'https://app.example/l/abc', name: 'sam', title: 'Sam', about: null,
  addresses_by_place: { 'first-place': 'https://app.example/l/abc?p=first-place', 'second-place': 'https://app.example/l/abc?p=second-place' },
  links: [{ link_id: BOOK, label: 'Book', url: 'https://book.example/sam' }],
  posts: [{ post_id: 'post:0001-a', words: 'Spring workshop', places: ['first-place'], url: 'https://shop.example/spring' }],
  counts: counts({ visits: 1, visits_recent: 1, opens: 3, opens_recent: 3,
    by_item: [{ item: BOOK, label: 'Book', opens: 3, recent: 3, by_place: { 'first-place': 1, 'second-place': 2 } }],
    by_place: { 'first-place': { visits: 1, opens: 1 }, 'second-place': { visits: 0, opens: 2 } } }),
};

test('the facts: ids for each row, places most-opened first, nothing counted until someone came', () => {
  assert.equal(linkPageFacts(fresh).counts.counted, false);
  const facts = linkPageFacts(counted);
  assert.deepEqual(facts.addresses.map(row => [row.id, row.place]), [['address-any', null], ['address-first-place', 'first-place'], ['address-second-place', 'second-place']]);
  assert.deepEqual(facts.counts.by_item[0].places, [{ place: 'second-place', count: 2 }, { place: 'first-place', count: 1 }]);
  assert.deepEqual([facts.counts.counted, facts.counts.visits, facts.counts.opens, facts.no_links, facts.no_posts], [true, 1, 3, false, false]);
  assert.equal(facts.words, settings.words);
  assert.equal(facts.title, 'Sam');
});
