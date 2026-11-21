// tools/keep-secrets-out-of-answers/test/strip-secrets.test.mjs: secrets leave a service answer; everything else stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripSecrets, stripSecretsFromText, REMOVED } from '../read-data/strip-secrets.mjs';

const FAKE = 'stand-in-token-not-real-0123456789';

test('a Graph paging answer keeps its data and cursors and loses the token in next and previous', () => {
  const answer = {
    data: [{ id: '18114559856349641', message: 'Here is the link: https://ethosschooloftennis.com', created_time: '2026-11-21T09:26:20+0000' }],
    paging: {
      cursors: { after: 'QVFIUmFiYw', before: 'QVFIUmFiYz' },
      next: `https://graph.instagram.com/v21.0/aWdfZAG06Mz/messages?fields=message%2Cfrom&access_token=${FAKE}&limit=2&after=QVFIUmFiYw`,
      previous: `https://graph.instagram.com/v21.0/aWdfZAG06Mz/messages?access_token=${FAKE}&before=QVFIUmFiYz`,
    },
  };
  const out = stripSecrets(answer);
  assert.ok(!JSON.stringify(out).includes(FAKE));
  assert.equal(out.paging.next, `https://graph.instagram.com/v21.0/aWdfZAG06Mz/messages?fields=message%2Cfrom&access_token=${REMOVED}&limit=2&after=QVFIUmFiYw`);
  assert.deepEqual(out.data, answer.data);
  assert.deepEqual(out.paging.cursors, answer.paging.cursors);
});

test('secret fields, bearer headers and key parameters go; the original value is not changed', () => {
  const answer = { headers: { Authorization: `Bearer ${FAKE}`, 'X-API-Key': 'k-123456789', 'content-type': 'application/json' },
    nested: [{ refresh_token: 'r-abc', note: `call https://api.example.com/v1?key=stand-in-key-1&q=tennis` }],
    log: `sent Authorization: Bearer ${FAKE} to the service` };
  const before = JSON.stringify(answer);
  const out = stripSecrets(answer);
  assert.equal(JSON.stringify(answer), before);
  assert.equal(out.headers.Authorization, REMOVED);
  assert.equal(out.headers['X-API-Key'], REMOVED);
  assert.equal(out.headers['content-type'], 'application/json');
  assert.equal(out.nested[0].refresh_token, REMOVED);
  assert.equal(out.nested[0].note, `call https://api.example.com/v1?key=${REMOVED}&q=tennis`);
  assert.equal(out.log, `sent Authorization: Bearer ${REMOVED} to the service`);
});

test('ordinary values stay exactly as they were', () => {
  for (const value of [null, 0, 12, true, '', 'swing', 'https://www.instagram.com/p/Df8fJFiDZaP/', '/17841452139268435/messages',
    'https://example.com/a?id=5&monkey=banana', { token_count: 3, keywords: ['key'], id: 'key' }, [1, 'two', { three: 3 }]]) {
    assert.deepEqual(stripSecrets(value), value);
  }
  assert.equal(stripSecretsFromText('a?sig=&x=1'), 'a?sig=&x=1');
});
