// tools/host-a-sites-own-backend-inside-the-install/read-data/workers-stand-ins.mjs: the Workers APIs a site's bundle reads, on a plain computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HTMLRewriter, cachesDefault, d1, emailSending, kv, numbered } from '../read-data/workers-stand-ins.mjs';

const fakePool = answer => { const asked = []; return { asked, query: async (sql, values) => { asked.push([sql, values]); return answer(sql, values); } }; };

test('a ? outside quotes becomes $1, $2, ... and a quoted ? stays', () => {
  assert.equal(numbered("SELECT * FROM t WHERE a = ? AND b = '?' AND c IN (?, ?)"), "SELECT * FROM t WHERE a = $1 AND b = '?' AND c IN ($2, $3)");
  assert.equal(numbered("SELECT 'it''s ?' , ?"), "SELECT 'it''s ?' , $1");
});

test('env.DB answers first, all and run the way D1 does', async () => {
  const pool = fakePool(() => ({ rows: [{ n: 3, id: 'a' }], rowCount: 1 }));
  const db = d1(pool);
  assert.deepEqual(await db.prepare('SELECT * FROM s WHERE id = ?').bind('a').first(), { n: 3, id: 'a' });
  assert.equal(await db.prepare('SELECT n FROM s').first('n'), 3);
  assert.deepEqual((await db.prepare('SELECT * FROM s').all()).results, [{ n: 3, id: 'a' }]);
  assert.deepEqual((await db.prepare('UPDATE s SET n = ? WHERE id = ?').bind(4, 'a').run()).meta, { changes: 1 });
  assert.deepEqual(pool.asked[0], ['SELECT * FROM s WHERE id = $1', ['a']]);
  assert.equal(await d1(fakePool(() => ({ rows: [] }))).prepare('SELECT 1').first(), null);
});

test('env.SHARED_LISTS keeps a value with its metadata and answers json when asked', async () => {
  const rows = new Map();
  const pool = { query: async (sql, values) => {
    if (sql.startsWith('INSERT')) { rows.set(values[0], { value: values[1], metadata: values[2] }); return { rows: [] }; }
    if (sql.startsWith('SELECT')) return { rows: rows.has(values[0]) ? [rows.get(values[0])] : [] };
    return { rows: [] };
  } };
  const store = kv(pool, 'site_shared_lists');
  await store.put('k', JSON.stringify({ a: 1 }), { metadata: { v: 2 } });
  assert.deepEqual(await store.get('k', 'json'), { a: 1 });
  assert.deepEqual(await store.getWithMetadata('k', { type: 'json' }), { value: { a: 1 }, metadata: { v: 2 } });
  assert.equal(await store.get('missing'), null);
  assert.throws(() => kv(pool, 'drop table x'), /lowercase/);
});

test('env.EMAIL sends through Email Sending, and says plainly when no token is held', async () => {
  const sent = [];
  const mail = emailSending({ account: 'acct', token: 't', fetchImpl: async (url, init) => { sent.push([url, JSON.parse(init.body), init.headers.authorization]); return new Response(JSON.stringify({ success: true, result: { id: 'm1' } })); } });
  assert.deepEqual(await mail.send({ from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' }), { id: 'm1' });
  assert.equal(sent[0][0], 'https://api.cloudflare.com/client/v4/accounts/acct/email/sending/send');
  assert.equal(sent[0][2], 'Bearer t');
  await assert.rejects(emailSending({ account: 'acct', token: null }).send({}), { code: 'email_sending_not_set_up' });
  const refused = emailSending({ account: 'acct', token: 't', fetchImpl: async () => new Response('{"success":false}', { status: 403 }) });
  await assert.rejects(refused.send({}), { code: 'email_sending_refused', status: 403 });
});

test('HTMLRewriter rewrites a streamed page the way the site head does', async () => {
  const out = new HTMLRewriter()
    .on('head', { element: element => element.prepend('<meta name="x">', { html: true }) })
    .on('body', { element: element => element.prepend('<p>bar</p>', { html: true }) })
    .transform(new Response('<html><head><title>t</title></head><body><main>m</main></body></html>', { headers: { 'content-type': 'text/html', 'content-length': '70' } }));
  assert.equal(out.headers.get('content-length'), null);
  assert.equal(await out.text(), '<html><head><meta name="x"><title>t</title></head><body><p>bar</p><main>m</main></body></html>');
});

test('caches.default keeps an answer only for its own max-age', async () => {
  let now = 0;
  const cache = cachesDefault(() => now);
  await cache.put('https://x/a', new Response('one', { headers: { 'cache-control': 'public, max-age=10, s-maxage=60' } }));
  await cache.put('https://x/b', new Response('two', { headers: { 'cache-control': 'no-store' } }));
  assert.equal(await (await cache.match('https://x/a')).text(), 'one');
  assert.equal(await cache.match('https://x/b'), undefined);
  now = 61000;
  assert.equal(await cache.match('https://x/a'), undefined);
});
