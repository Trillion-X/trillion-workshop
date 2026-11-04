// A model server another of the person's computers offers is tried after this computer's own, but only at a host the
// person allowed, and the answer says which road served it (computer/offered-endpoints.mjs, computer/local-models.mjs).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { askLocal } from '../local-models.mjs';
import { acceptOffered, readOffered, setsIn } from '../offered-endpoints.mjs';
import rules from '../offered-endpoints.json' with { type: 'json' };

const serve = answer => new Promise(resolve => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { const reply = answer(JSON.parse(body)); response.statusCode = reply.status ?? 200; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(reply)); });
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const folder = () => mkdtempSync(join(tmpdir(), 'offered-'));

test('only addresses at a host the person allowed are accepted, each refusal with its reason, and the default allows only this computer', () => {
  const text = ['# the mini', 'http://127.0.0.1:11434/v1/chat/completions', 'http://mini.local:11434/v1/chat/completions', 'ftp://127.0.0.1/x', 'not an address', 'https://evil.example/v1'].join('\n');
  const closed = acceptOffered(text, { id: 'a' });
  assert.deepEqual(closed.accepted, ['http://127.0.0.1:11434/v1/chat/completions']);
  assert.deepEqual(closed.refused.map(item => item.why), ['mini.local is not one of the hosts you allowed', 'ftp: is not an address scheme this computer uses for models', 'it is not an address', 'evil.example is not one of the hosts you allowed']);
  const own = acceptOffered(text, { id: 'a', allowed_hosts: ['*.local'] });
  assert.deepEqual(own.accepted, ['http://mini.local:11434/v1/chat/completions']);
  assert.equal(acceptOffered(Array.from({ length: 20 }, () => 'http://127.0.0.1:1/x').join('\n'), { id: 'a' }).accepted.length, rules.most_endpoints);
});

test('the person\'s sets are read from their own file, and a read turns each accepted address into a row to try', async () => {
  const file = join(folder(), 'sets.json');
  const given = { id: 'mini', label: 'Mac mini', offered_from: join(folder(), 'offer.txt'), model: 'qwen', allowed_hosts: ['127.0.0.1'] };
  assert.deepEqual(setsIn(file), [], 'no file keeps no sets');
  writeFileSync(file, JSON.stringify({ sets: [given, 'not a set'] }));
  writeFileSync(given.offered_from, 'http://127.0.0.1:9/v1/chat/completions\nhttp://elsewhere.test/v1\n');
  assert.deepEqual(setsIn(file).map(set => set.id), ['mini']);
  const read = await readOffered({ sets: setsIn(file) });
  assert.equal(read.rows[0].id, 'offered:mini:1');
  assert.match(read.report[0].refused[0].why, /elsewhere.test is not one of the hosts you allowed/);
});

test('an unreadable offered file offers nothing and never stops this computer\'s own servers', async () => {
  const seen = await readOffered({ sets: [{ id: 'gone', offered_from: join(folder(), 'missing.txt'), model: 'm' }, { id: 'web', offered_from: 'https://offers.test/list', model: 'm' }],
    fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.deepEqual(seen.rows, []);
  assert.match(seen.report[0].note, /could not be read/);
  assert.match(seen.report[1].note, /answered 503/);
});

test('a conversation goes to this computer\'s own server first, then to an offered one, and says which served it', async () => {
  const own = await serve(() => ({ status: 503, error: 'own server is busy' }));
  const offered = await serve(body => ({ choices: [{ message: { content: `offered answered ${body.model}` } }] }));
  const offer = join(folder(), 'offer.txt');
  writeFileSync(offer, `http://127.0.0.1:${offered.address().port}/v1/chat/completions\n`);
  const settings = { most_tokens: 100, retry_after_seconds: 0, words: { none: 'none', needs_input: 'needs' }, classify: [], jobs: {},
    chat: [{ id: 'mine', url: `http://127.0.0.1:${own.address().port}/v1/chat/completions`, model: 'own-model', timeout_seconds: 5 }],
    offered: () => readOffered({ sets: [{ id: 'mini', offered_from: offer, model: 'mini-model', allowed_hosts: ['127.0.0.1'] }] }) };
  try {
    const answer = await askLocal({ messages: [{ role: 'user', content: 'hi' }] }, settings);
    assert.equal(answer.served_by, 'offered:mini:1');
    assert.equal(answer.model, 'mini-model');
    assert.equal(answer.choices[0].message.content, 'offered answered mini-model');
    const without = await askLocal({ messages: [{ role: 'user', content: 'hi' }] }, { ...settings, offered: undefined });
    assert.equal(without.error, 'none', 'with nothing offered only this computer\'s servers are asked');
    assert.deepEqual(without.tried.map(item => item.id), ['mine']);
  } finally { own.close(); offered.close(); }
});
