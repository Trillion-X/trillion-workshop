// A send from the browser is ONE record written through the one door (extension/src/share-record.mjs): a `shared`
// record Trillion files by default, or a row of one of the person's lists when a list is picked; the lists offered are
// the person's own `list` records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listArguments, listsFrom, readLists, shareRecord, shareTitle, writeArguments } from '../src/share-record.mjs';

const page = { kind: 'page', url: 'https://a.example/story', title: 'A story', text: 'What the page says about itself' };
const selection = { kind: 'selection', url: 'https://a.example/story', text: '  a passage worth keeping  ' };
const picture = { kind: 'picture', url: 'https://a.example/story', name: 'A story.jpg', file: '1f:abc' };
const reading = { id: 'list:reading', label: 'Reading list', row_type: 'reading', title_field: 'name' };
const share = (over = {}) => ({ requestKey: 'key-1', items: [page], ownWords: '', from: 'Chrome', at: '2026-10-30T19:00:00.000Z', ...over });

test('the title is the first link, else the start of the first passage, else the first file name', () => {
  assert.equal(shareTitle([selection, page]), 'https://a.example/story');
  assert.equal(shareTitle([selection, picture]), 'a passage worth keeping');
  assert.equal(shareTitle([{ kind: 'selection', text: 'x'.repeat(300) }]).length, 120);
  assert.equal(shareTitle([picture]), 'A story.jpg');
  assert.equal(shareTitle([]), '');
});

test('with no list picked the send is one shared record keyed by the request key, and the note is trimmed', () => {
  const record = shareRecord(share({ ownWords: '  look at this ' }));
  assert.deepEqual(record, {
    id: 'shared:key-1', type: 'shared',
    value: { title: 'https://a.example/story', items: [page], own_words: 'look at this', from: 'Chrome', at: '2026-10-30T19:00:00.000Z' },
  });
  assert.equal('own_words' in shareRecord(share()).value, false);
});

test('a picked list makes the send a row of that list, its title in the list title field', () => {
  const record = shareRecord(share({ list: reading }));
  assert.equal(record.id, 'record:reading:key-1');
  assert.equal(record.type, 'record:reading');
  assert.equal(record.value.name, 'https://a.example/story');
  assert.equal(record.value.title, 'https://a.example/story');
  const untitled = shareRecord(share({ list: { ...reading, title_field: null } }));
  assert.deepEqual(Object.keys(untitled.value).sort(), ['at', 'from', 'items', 'title']);
});

test('the door arguments write the one record at @own-records with the send request key', () => {
  const args = writeArguments(share({ list: reading }));
  assert.equal(args.address, '@own-records');
  assert.equal(args.method, 'records:write');
  assert.equal(args.request_key, 'key-1');
  assert.deepEqual(args.input.records.map(record => record.id), ['record:reading:key-1']);
  const listing = listArguments();
  assert.equal(listing.method, 'records:list');
  assert.deepEqual(listing.input, { type: 'list', limit: 500 });
  assert.notEqual(listing.request_key, listArguments().request_key);
});

test('only lists that name a row type are offered, labelled by their label or their id', async () => {
  const answer = { records: [
    { id: 'list:reading', type: 'list', value: { label: 'Reading list', row_type: 'reading', title_field: 'name' } },
    { id: 'list:people', type: 'list', value: { row_type: 'people' } },
    { id: 'list:broken', type: 'list', value: { label: 'No row type' } },
  ], next: null };
  assert.deepEqual(listsFrom(answer), [reading, { id: 'list:people', label: 'people', row_type: 'people', title_field: null }]);
  assert.throws(() => listsFrom({}), /did not return the lists/,
    'an unavailable or malformed list read is not presented as an empty account');
  const asked = [];
  const read = await readLists(async (name, args) => { asked.push([name, args.method]); return answer; });
  assert.deepEqual(asked, [['do_one_thing_in_my_account', 'records:list']]);
  assert.equal(read.length, 2);
  await assert.rejects(readLists(async () => { throw new Error('Trillion is busy'); }), /busy/);
});
