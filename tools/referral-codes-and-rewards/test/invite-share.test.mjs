// tools/referral-codes-and-rewards/test/invite-share.test.mjs
// The Refer a friend section: the host's words and the person's link pass through unchanged, and the places are the DATA rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inviteSection } from '../read-data/invite-share.mjs';
import places from '../read-data/share-places.json' with { type: 'json' };

const words = {
  heading: 'Refer a friend', body: 'A friend who joins gets a discount.', link: 'Your link', share: 'Share', share_title: 'Sample Club',
  share_text: 'Come and learn with me.', copy: 'Copy link', copied: 'Copied', failed: 'Could not copy', unavailable: 'Try again.',
  empty: 'Nobody has joined with your link yet.', person: 'Someone who joined', joined_on: 'Joined {day}', paid_on: 'Paid {day}', credit_added: '{amount} credit added',
  stats: { joined: 'Joined with your link', paying: 'Paying', earned: 'Credit added' },
  status: { joined: 'Joined', paying: 'Paying', credited: 'Credit added' },
};
const link = 'https://example.test/?ref=TESTCODE';
const none = { joined: 0, paying: 0, credit_given_cents: 0, people: [] };
const one = {
  joined: 2, paying: 1, credit_given_cents: 2500,
  people: [
    { joined_at: '2026-10-02T09:00:00.000Z', paid_at: '2026-10-03T12:00:00.000Z', reward: 'given', amount_cents: 2500, currency: 'usd' },
    { joined_at: '2026-10-20T09:00:00.000Z', paid_at: null, reward: 'none', amount_cents: null, currency: null },
  ],
};

test('the section carries the host heading and body as they are', () => {
  const section = inviteSection({ link, stats: none, words });
  assert.equal(section.heading, words.heading);
  assert.equal(section.body, words.body);
});

test('the link sheet holds the link as given, with the host words and share text', () => {
  const sheet = inviteSection({ link, stats: none, words }).link_share;
  assert.equal(sheet.url, link);
  assert.equal(sheet.title, words.share_title);
  assert.equal(sheet.text, words.share_text);
  assert.deepEqual(sheet.words, { link: 'Your link', share: 'Share', copy: 'Copy link', copied: 'Copied', failed: 'Could not copy' });
});

test('the places are the DATA rows, each with a web or device address that takes the link and text', () => {
  const sheet = inviteSection({ link, stats: none, words }).link_share;
  assert.deepEqual(sheet.places, places);
  assert.equal(sheet.places.length, 6);
  for (const place of sheet.places) {
    assert.ok(place.href.includes('{url}') || place.href.includes('{text}'), `${place.id} takes the link or its text`);
    assert.ok(place.logo || place.icon, `${place.id} has a logo or an icon`);
  }
});

test('no member yet: honest zero tiles, no rows, and the host empty note', () => {
  const section = inviteSection({ link, stats: none, words });
  assert.deepEqual(section.stats.map(tile => tile.value), ['0', '0', '$0']);
  assert.deepEqual(section.rows, []);
  assert.equal(section.note, words.empty);
});

test('a joined person is an unnamed row with the day of the first payment and the credit given', () => {
  const section = inviteSection({ link, stats: one, words });
  assert.deepEqual(section.stats.map(tile => tile.value), ['2', '1', '$25']);
  assert.equal(section.note, undefined);
  assert.deepEqual(section.rows[0], {
    id: 'joined-0', title: 'Someone who joined', detail: 'Joined Oct 2, 2026 · Paid Oct 3, 2026 · $25 credit added', status: { label: 'Credit added', tone: 'good' },
  });
  assert.deepEqual(section.rows[1], { id: 'joined-1', title: 'Someone who joined', detail: 'Joined Oct 20, 2026', status: { label: 'Joined', tone: 'quiet' } });
});

test('a friend who paid with no credit yet is a Paying row, not a Joined one', () => {
  const stats = { joined: 1, paying: 1, credit_given_cents: 0, people: [{ joined_at: '2026-10-02T09:00:00.000Z', paid_at: '2026-10-03T12:00:00.000Z', reward: 'none', amount_cents: null, currency: null }] };
  assert.deepEqual(inviteSection({ link, stats, words }).rows[0].status, { label: 'Paying', tone: 'quiet' });
});
