// tool:list-every-connection: services and the computer's places in one list, from made-up rows of both owners, and
// the row itself run the way the container runner runs it (test-helpers/run-a-row.mjs) over the real rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runRow} from '../../../test-helpers/run-a-row.mjs';
import {listEveryConnection} from '../do-work/list-every-connection.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [row] = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'tool-rows.json'), 'utf8')).records.map(record => record.payload);

const services = {things: [
  {payload: {kind: 'service-connection-descriptor', vendor: 'made-up-chat', name: 'Made-up Chat', category: 'Messaging', credentialFields: [{id: 'token', secret: true}]}},
  {payload: {kind: 'service-connection-descriptor', vendor: 'made-up-phone-chat', name: 'Made-up Phone Chat', category: 'Messaging', carriedBy: {steps: ['Keep the helper running.']}}},
  {payload: {kind: 'service-connection-descriptor', vendor: 'made-up-pictures', name: 'Made-up Pictures', category: 'Photos', acquire: {kind: 'oauth'}}},
  {payload: {kind: 'service-connection-descriptor', vendor: 'made-up-plain', name: 'Made-up Plain'}},
  {payload: {kind: 'owner-record-work-contract'}},
]};
const places = {
  gates: {'made-up-switch': {label: 'The made-up switch'}},
  sources: [
    {id: 'chat-store', label: 'Chat store', category: 'Messages', gate: 'made-up-switch', look: {paths: ['~/chat.db']}, read: {route: 'Chat'}},
    {id: 'picture-folder', label: 'Picture folder', category: 'Pictures', look: {entries: '~/Pictures'}},
    {id: 'phone-chat-store', label: 'Phone chat store', category: 'Messages', carries: 'made-up-phone-chat', look: {paths: ['~/phone.sqlite']}},
  ],
};
const categories = {same: {Messaging: 'Messages', Photos: 'Pictures'}, none: 'Other'};

test('services and places are one list, in one set of category words, each saying how it connects', () => {
  const {said, connections} = listEveryConnection({}, {services, places, categories});
  assert.equal(said, '4 services and 3 places on your computer.');
  assert.deepEqual(connections.map(item => [item.category, item.id, item.how]), [
    ['Messages', 'computer:chat-store', 'found-on-your-computer'],
    ['Messages', 'service:made-up-chat', 'key'],
    ['Messages', 'service:made-up-phone-chat', 'carried-by-your-computer'],
    ['Messages', 'computer:phone-chat-store', 'found-on-your-computer'],
    ['Other', 'service:made-up-plain', 'nothing-to-give'],
    ['Pictures', 'service:made-up-pictures', 'sign-in'],
    ['Pictures', 'computer:picture-folder', 'found-on-your-computer'],
  ]);
  const chat = connections.find(item => item.id === 'computer:chat-store');
  assert.deepEqual(chat, {id: 'computer:chat-store', kind: 'computer-place', label: 'Chat store', category: 'Messages', how: 'found-on-your-computer', arrives_as: 'Chat', gate: 'made-up-switch', gate_label: 'The made-up switch', state: 'not_looked'});
  assert.deepEqual(connections.find(item => item.id === 'service:made-up-phone-chat').steps, ['Keep the helper running.']);
  assert.equal(connections.find(item => item.id === 'computer:phone-chat-store').carries, 'service:made-up-phone-chat');
  assert.doesNotMatch(JSON.stringify(connections), /token/, 'no credential field is shown');
});

test('with a look\'s answer each place says whether it is on the computer; a category keeps one group', () => {
  const looked = {sources: [{id: 'chat-store', state: 'needs_switch'}, {id: 'picture-folder', state: 'found', detail: '3 pictures'}]};
  const {said, connections} = listEveryConnection({looked, category: 'Pictures'}, {services, places, categories});
  assert.equal(said, '1 services and 1 places on your computer in Pictures.');
  assert.deepEqual(connections.map(item => [item.id, item.state ?? null, item.detail ?? null]), [['service:made-up-pictures', null, null], ['computer:picture-folder', 'found', '3 pictures']]);
  const all = listEveryConnection({looked}, {services, places, categories}).connections;
  assert.equal(all.find(item => item.id === 'computer:chat-store').state, 'needs_switch');
  assert.equal(all.find(item => item.id === 'computer:phone-chat-store').state, 'not_here');
  assert.throws(() => listEveryConnection({looked: {}}, {services, places, categories}), /looked is the answer of tool:look-for-the-places-on-this-computer/);
});

test('the row runs over the two owners\' real rows: one list holding both kinds', async () => {
  const [sample] = row.verify;
  const ran = await runRow(row, sample.input, sample);
  assert.equal(ran.code, 0, ran.stderr);
  const kinds = new Set(ran.last.connections.map(item => item.kind));
  assert.deepEqual([...kinds].sort(), ['computer-place', 'service']);
  assert.ok(ran.last.connections.every(item => item.category === 'Messages'));
  assert.equal(ran.last.connections.find(item => item.id === 'computer:messages').state, 'found');
});
