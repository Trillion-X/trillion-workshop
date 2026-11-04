// Links in messages are read once per normalized address after the message is kept, and every message page carries each
// link's state (src/link-previews.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { linkPreviews, linksIn, normalizeLink } from '../src/link-previews.mjs';

function sqlite() {
  const db = new DatabaseSync(':memory:');
  return { exec: (query, ...binds) => { const statement = db.prepare(query); const rows = /^\s*(select|pragma)/i.test(query) ? statement.all(...binds) : (statement.run(...binds), []); return { toArray: () => rows }; } };
}

test('the same page behind tracking tails and fragments is one normalized address; only http(s) words are links', () => {
  assert.equal(normalizeLink('HTTPS://Example.com/a?utm_source=x&b=2&a=1&fbclid=z#top'), 'https://example.com/a?a=1&b=2');
  assert.equal(normalizeLink('https://example.com/a?a=1&b=2'), 'https://example.com/a?a=1&b=2');
  assert.equal(normalizeLink('javascript:alert(1)'), null);
  assert.deepEqual(linksIn('see https://example.com/a?utm_x=1, and https://example.com/a?utm_x=1. also ftp://nope and https://other.org/p)'), ['https://example.com/a?utm_x=1', 'https://other.org/p']);
});

test('a link is read once after the message is kept, pages carry pending then ready then failed, and a failure is retried later', async () => {
  const sql = sqlite();
  let clock = Date.parse('2026-10-19T10:00:00Z');
  const reads = [];
  const cards = { 'https://example.com/a': { url: 'https://example.com/a', final_url: 'https://example.com/a', host: 'example.com', title: 'A page', description: 'x'.repeat(900), text: 'body words that are not kept', unread: null }, 'https://down.example/': { unread: 'The page did not answer.', title: null } };
  const previews = linkPreviews(sql, { readLink: async url => { reads.push(url); return cards[url]; }, now: () => new Date(clock) });
  const first = [{ text: 'read https://example.com/a?utm_source=mail and https://down.example/' }];
  const second = [{ text: 'again https://example.com/a?fbclid=1#x' }];
  assert.equal(previews.ensure(first), 2);
  assert.equal(previews.ensure(second), 0, 'the same page under another tail adds nothing');
  assert.deepEqual(previews.forMessages(first), { 'https://example.com/a?utm_source=mail': { state: 'pending' }, 'https://down.example/': { state: 'pending' } });
  assert.equal(await previews.settle(), 2);
  assert.deepEqual(reads.sort(), ['https://down.example/', 'https://example.com/a']);
  const page = previews.forMessages([...first, ...second]);
  assert.equal(page['https://example.com/a?utm_source=mail'].state, 'ready');
  assert.equal(page['https://example.com/a?fbclid=1#x'].card.title, 'A page', 'both spellings share one card');
  assert.equal(page['https://example.com/a?utm_source=mail'].card.description.length, 400);
  assert.equal('text' in page['https://example.com/a?utm_source=mail'].card, false, 'a card keeps only its declared fields');
  assert.equal(page['https://down.example/'].state, 'failed');
  assert.equal(previews.anyDue(), false);
  assert.equal(await previews.settle(), 0, 'nothing is read twice');
  clock += 3601 * 1000;
  assert.equal(previews.anyDue(), true);
  cards['https://down.example/'] = { url: 'https://down.example/', title: 'Back up', unread: null };
  assert.equal(await previews.settle(), 1);
  assert.equal(previews.forMessages(first)['https://down.example/'].card.title, 'Back up');
  assert.equal(reads.length, 3);
});

test('a claim left by a turn that died is taken again, and writes run inside the caller\'s scope', async () => {
  const sql = sqlite();
  let clock = Date.parse('2026-10-19T10:00:00Z');
  let scopes = 0;
  const previews = linkPreviews(sql, { readLink: async () => ({ title: 'T', unread: null }), now: () => new Date(clock) });
  previews.ensure([{ text: 'https://example.com/z' }]);
  sql.exec("UPDATE link_previews SET state = 'fetching'");
  assert.equal(await previews.settle(), 0, 'a fresh claim is left alone');
  clock += 301 * 1000;
  assert.equal(await previews.settle({ writes: run => { scopes += 1; return run(); } }), 1);
  assert.equal(scopes, 2, 'claim and result are each one scoped burst, the page read is between them');
  assert.equal(previews.forMessages([{ text: 'https://example.com/z' }])['https://example.com/z'].state, 'ready');
});

test('forgetting a message drops its preview only when no other message uses the address', async () => {
  const sql = sqlite();
  const previews = linkPreviews(sql, { readLink: async url => ({ url, title: `T ${url}`, unread: null }) });
  const messages = [
    { id: 'message:1', text: 'a https://example.com/shared' },
    { id: 'message:2', text: 'b https://example.com/shared?utm_source=x and https://example.com/only-two' },
    { id: 'message:3', text: 'c https://example.com/only-three' },
  ];
  previews.ensure(messages);
  await previews.settle({ writes: run => run() });
  const rows = () => sql.exec('SELECT url FROM link_previews ORDER BY url').toArray().map(row => row.url);
  assert.deepEqual(rows(), ['https://example.com/only-three', 'https://example.com/only-two', 'https://example.com/shared']);
  assert.equal(previews.release(['message:1']), 0, 'message:2 still uses the shared address');
  assert.equal(rows().length, 3);
  assert.equal(previews.release(['message:2']), 2, 'the shared address and only-two are used by nobody now');
  assert.deepEqual(rows(), ['https://example.com/only-three']);
  assert.equal(previews.release(['message:2', 'message:unknown']), 0, 'forgetting again, or something never kept, changes nothing');
  assert.equal(previews.release(['message:3']), 1);
  assert.deepEqual(rows(), []);
  assert.deepEqual(previews.forMessages([messages[2]]), { 'https://example.com/only-three': { state: 'pending' } });
});
