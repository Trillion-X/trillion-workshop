// Ported from old trillion test/link-page.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. Carried: 'the screen shows the owner's answer and its buttons become the owner's changes',
// against web/src/link-page-screen.mjs linkPageScreen and screenChange, with the owner's two read() answers written
// below as the state (the owner, src/link-page.mjs makeLinkPage, was not carried). Left out: the tests of that owner
// (codes, counting, turning off, link rules, the public page src/link-page-pages.mjs, a change lost before its commit)
// and of the account route that reached it (src/account-routes.mjs handleAccountApi): no running code in trillion-apps,
// trillion-workshop or trillion-rust keeps a link page, answers /l/<code> or routes /work/api/link-page/change (searched
// makeLinkPage, handleLinkPageRequest, answerLinkPage, link_page, link-page/change). Not here, as the Workshop owns them:
// 'any AI reads and changes the page through read_link_page and set_link_page' and 'the job is one Workshop tool'
// (trillion-workshop tools/share-links/src/link-page-tools.mjs linkPageTools and linkPageAnnotations).
import test from 'node:test';
import assert from 'node:assert/strict';
import settings from '../src/link-page.json' with { type: 'json' };
import { linkPageScreen, screenChange } from '../src/link-page-screen.mjs';

const ORIGIN = 'https://app.example';
const counts = (changes = {}) => ({ recent_days: 30, visits: 0, visits_recent: 0, opens: 0, opens_recent: 0, by_item: [], by_place: {}, ...changes });
// read() of a new page: off, nothing set.
const off = { on: false, address: null, name: null, title: null, about: null, addresses_by_place: {}, links: [], posts: [], counts: counts() };
// read() after the screen's add (Site) and title (Sam) changes and one visit from first-place, with the old test's posts
// (one posted with a link to first-place and second-place).
const on = {
  on: true, address: `${ORIGIN}/l/AQIDBAUG`, name: null, title: 'Sam', about: null,
  addresses_by_place: { 'first-place': `${ORIGIN}/l/AQIDBAUG?p=first-place`, 'second-place': `${ORIGIN}/l/AQIDBAUG?p=second-place` },
  links: [{ link_id: 'link:site', label: 'Site', url: 'https://sam.example' }],
  posts: [{ post_id: 'post:0001-a', words: 'Our spring workshop is open', places: ['first-place', 'second-place'], url: 'https://shop.example/spring?ref=1' }],
  counts: counts({ visits: 1, visits_recent: 1, by_place: { 'first-place': { visits: 1, opens: 0 } } }),
};

test('the screen shows the owner\'s answer and its buttons become the owner\'s changes', () => {
  const offScreen = linkPageScreen(off);
  assert.equal(offScreen.title, settings.words.screen_title);
  assert.equal(offScreen.sections[0].actions[0].switch.on, false);
  assert.deepEqual(offScreen.sections[0].actions[0].send.body, { change: 'on', on: true });
  assert.deepEqual(screenChange({ change: 'add', values: { label: 'Site', url: 'https://sam.example' } }), { add_link: { label: 'Site', url: 'https://sam.example' } });
  assert.deepEqual(screenChange({ change: 'title', values: { value: 'Sam' } }), { title: 'Sam' });
  const onScreen = linkPageScreen(on);
  assert.equal(onScreen.sections[0].actions[0].switch.on, true);
  assert.deepEqual(onScreen.sections[0].rows.map(row => row.title), ['Sam', 'first-place', 'second-place']);
  assert.ok(onScreen.sections[0].rows.every(row => row.actions[0].copy === row.detail));
  const [site] = on.links;
  assert.deepEqual(screenChange({ change: 'remove', link_id: site.link_id }), { remove_link: site.link_id });
  assert.equal(onScreen.sections[4].stats[0].value, '1');
  assert.throws(() => screenChange({ change: 'delete-everything' }), /not one the page makes/);
});
