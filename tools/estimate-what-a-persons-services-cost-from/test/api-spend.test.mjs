// Ported from test/spend-meter.test.mjs at commit b6ae0ebf81 of the pre-retirement repository (the old repo's
// src/api-spend.mjs tests only). The spend-meter tests in that file belong to the spend-meter owner and are not here.
// Left out, by name: "an account whose cap is reached hands the same reading to the next AI the person picked" (it drives
// src/awareness.mjs askChosenAwarenessModel over the retired own-AI routing, src/own-ais-routing.mjs; see the header of
// tools/keep-and-wake-ai-sessions-on-this-computer/test/own-ais-wake-person-upgrade.test.mjs). Also left out: the
// readsAloud assertions on the limit-status kind, which test the tell-the-person owner's kinds
// (tools/tell-one-person-something-through-every-way-they/read-data/tell-the-person.json).
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ApiCapReached, ApiCostUnknown, apiSpend, dollarsOf, usageOf } from '../src/api-spend.mjs';
import apiData from '../src/api-spend.json' with { type: 'json' };

const storage = () => {
  const db = new DatabaseSync(':memory:');
  return { exec: (query, ...values) => { const rows = db.prepare(query).all(...values); return { toArray: () => rows }; } };
};
// 2026-10-04 12:00 UTC.
const NOON = Date.parse('2026-10-04T12:00:00Z');

test('a call is priced from what the service said it used, and a reached cap refuses before anything is sent', async () => {
  const google = apiData.services.find(service => service.connection_id === 'service_connection:google');
  // Thinking a service reports only in its total is billed as output.
  const usage = usageOf({ requestBody: { model: 'gemini-3.1-pro-preview' }, answer: { usage: { prompt_tokens: 100_000, completion_tokens: 1_000, total_tokens: 21_000 + 100_000 } } });
  assert.deepEqual(usage, { model: 'gemini-3.1-pro-preview', input_tokens: 100_000, output_tokens: 21_000 });
  assert.ok(Math.abs(dollarsOf(google, usage) - (0.1 * 2 + 0.021 * 12)) < 1e-12);
  // Past 200k input tokens every token is at the higher price.
  assert.ok(Math.abs(dollarsOf(google, { model: 'gemini-3.1-pro-preview', input_tokens: 300_000, output_tokens: 0 }) - 1.2) < 1e-12);
  assert.equal(dollarsOf(google, { model: 'a-model-with-no-price', input_tokens: 1, output_tokens: 1 }), null);

  const told = [];
  const spend = apiSpend({ sql: storage(), now: () => NOON, tell: async notice => { if (!told.some(kept => kept.key === notice.key)) told.push(notice); }, caps: async key => key === 'google' ? [{ id: 'own-api-day:google', label: 'What each of your API accounts may cost in a day', most_dollars: 10, alert_at: 0.5, since: '2026-10-04', until: Date.parse('2026-10-05T00:00:00Z') }] : [] });
  const tool = { invoke: { connection_id: 'service_connection:google' } };
  assert.equal(spend.covers(tool), true);
  assert.equal(spend.covers({ invoke: { connection_id: 'service_connection:github' } }), false);
  const body = new TextEncoder().encode(JSON.stringify({ model: 'gemini-3.1-pro-preview' }));
  const answer = JSON.stringify({ usage: { prompt_tokens: 100_000, completion_tokens: 500_000, total_tokens: 600_000 } });
  let permit = await spend.before(tool);
  spend.after(tool, { body }, 200, answer, permit); // $0.20 + $6 = $6.20: under the cap
  permit = await spend.before(tool);
  spend.after(tool, { body }, 500, answer, permit); // a failed call bills nothing
  permit = await spend.before(tool);
  spend.after(tool, { body }, 200, answer, permit); // $12.40: over
  await assert.rejects(() => spend.before(tool), error => error instanceof ApiCapReached && error.not_sent === true && error.refused_until === Date.parse('2026-10-05T00:00:00Z'));
  assert.deepEqual(told.map(notice => notice.key), ['spend-budget:own-api-day:google:2026-10-04:near', 'spend-budget:own-api-day:google:2026-10-04:reached']);
  assert.deepEqual(told.map(notice => notice.kind), [apiData.kind, apiData.kind]);
  const rows = spend.read({ since: '2026-10-04', until: '2026-10-04' }).rows;
  assert.deepEqual(rows.map(row => [row.key, row.amount, row.calls, row.unpriced]), [['google', 12.4, 2, 0]]);
  // A model with no price is counted, never shown as free.
  spend.after({ invoke: { connection_id: 'service_connection:openai' } }, { body: new TextEncoder().encode('{"model":"gpt-unpriced"}') }, 200, answer);
  assert.equal(spend.read({ since: '2026-10-04', until: '2026-10-04' }).rows.find(row => row.key === 'openai').unpriced, 1);
});

test('parallel sends to one account wait for spend readback before the next cap admission', async () => {
  const spend = apiSpend({ sql: storage(), now: () => NOON, caps: async () => [{ id: 'day', label: 'Day cap', most_dollars: 10, since: '2026-10-04', until: Date.parse('2026-10-05T00:00:00Z') }] });
  const tool = { invoke: { connection_id: 'service_connection:google' } };
  const body = new TextEncoder().encode(JSON.stringify({ model: 'gemini-3.5-flash-lite' }));
  const reply = JSON.stringify({ usage: { prompt_tokens: 0, completion_tokens: 400_000 } }); // $1 by the configured Google price
  let admitted = 0;
  const calls = Array.from({ length: 12 }, async () => {
    let permit;
    try {
      permit = await spend.before(tool);
      admitted += 1;
      // Hold the first permit until the response has been counted, as sendThroughBox does.
      await new Promise(resolve => setTimeout(resolve, 0));
      spend.after(tool, { body }, 200, reply, permit);
    } catch (error) {
      if (!(error instanceof ApiCapReached)) throw error;
    } finally { spend.release(permit); }
  });
  await Promise.all(calls);
  assert.equal(admitted, 10, 'the final cap slot is admitted once, despite twelve simultaneous callers');
  assert.deepEqual(spend.read({ since: '2026-10-04', until: '2026-10-04' }).rows.map(row => [row.calls, row.amount]), [[10, 10]]);
});

test('missing or invalid successful usage stays unknown and refuses another capped request across a cold reopen', async () => {
  for (const answer of ['not JSON', '{}', JSON.stringify({ usage: { prompt_tokens: false, completion_tokens: false } }),
    JSON.stringify({ usage: { prompt_tokens: -1, completion_tokens: 10 } }), JSON.stringify({ usage: { prompt_tokens: 10 } }),
    JSON.stringify({ usage: { prompt_tokens: 10, total_tokens: 9 } }),
    JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 29 } }),
    JSON.stringify({ usage: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 } })]) {
    const sql = storage(); let now = NOON; const told = [];
    const options = { sql, now: () => now, tell: async notice => { if (!told.some(row => row.key === notice.key)) told.push(notice); },
      caps: async () => [{ id: 'day', label: 'Day budget', most_dollars: 10, since: new Date(now).toISOString().slice(0, 10) }] };
    let spend = apiSpend(options);
    const tool = { invoke: { connection_id: 'service_connection:openai' } };
    const request = { body: new TextEncoder().encode('{"model":"gpt-5-mini"}') };
    const permit = await spend.before(tool);
    spend.after(tool, request, 200, answer, permit);
    const rows = spend.read({ since: '2026-10-04', until: '2026-10-04' }).rows;
    assert.equal(rows[0].calls, 1); assert.equal(rows[0].unpriced, 1); assert.match(rows[0].shown, /cost unknown/);
    spend = apiSpend(options);
    for (let n = 0; n < 2; n++) await assert.rejects(spend.before(tool), error => error instanceof ApiCostUnknown && error.not_sent === true &&
      error.refused_until === Date.parse('2026-10-05T00:00:00Z'));
    assert.equal(told.length, 1);
    now = Date.parse('2026-10-05T12:00:00Z');
    const next = await spend.before(tool);
    spend.after(tool, request, 200, JSON.stringify({ usage: { prompt_tokens: 0, completion_tokens: 0 } }), next);
    assert.equal(spend.read({ since: '2026-10-05', until: '2026-10-05' }).rows[0].unpriced, 0, 'reported zero usage remains a known cost');
  }
});

test('one unknown-cost response settles concurrent waiters without serial free calls', async () => {
  const spend = apiSpend({ sql: storage(), now: () => NOON, caps: async () => [{ id: 'day', label: 'Day budget', most_dollars: 10, since: '2026-10-04' }] });
  const tool = { invoke: { connection_id: 'service_connection:openai' } };
  let sent = 0;
  const results = await Promise.allSettled(Array.from({ length: 4 }, async () => {
    const permit = await spend.before(tool); sent++;
    spend.after(tool, { body: new TextEncoder().encode('{"model":"gpt-5-mini"}') }, 200, '{}', permit);
  }));
  assert.equal(sent, 1); assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason instanceof ApiCostUnknown));
});

test('an unpriced model stops only that capped account, while another account can still send', async () => {
  const spend = apiSpend({ sql: storage(), now: () => NOON, caps: async () => [{ id: 'day', label: 'Day budget', most_dollars: 10, since: '2026-10-04' }] });
  const openai = { invoke: { connection_id: 'service_connection:openai' } }, google = { invoke: { connection_id: 'service_connection:google' } };
  const first = await spend.before(openai);
  spend.after(openai, { body: new TextEncoder().encode('{"model":"unpriced-model"}') }, 200,
    JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 20 } }), first);
  await assert.rejects(spend.before(openai), ApiCostUnknown);
  const other = await spend.before(google);
  spend.after(google, { body: new TextEncoder().encode('{"model":"gemini-3.5-flash-lite"}') }, 200,
    JSON.stringify({ usage: { prompt_tokens: 0, completion_tokens: 10 } }), other);
  const next = await spend.before(google); spend.release(next);
});

test('uncapped accounts keep concurrent sends and a failed capped send releases the waiting caller', async () => {
  const tool = { invoke: { connection_id: 'service_connection:google' } };
  const unlimited = apiSpend({ sql: storage(), now: () => NOON });
  assert.deepEqual(await Promise.all([unlimited.before(tool), unlimited.before(tool)]), [null, null]);
  const limited = apiSpend({ sql: storage(), now: () => NOON, caps: async () => [{ id: 'day', label: 'Day', most_dollars: 10, since: '2026-10-04' }] });
  const first = await limited.before(tool);
  const waiting = limited.before(tool);
  limited.release(first);
  const second = await waiting; limited.release(second);
  assert.equal(limited.usedSince('google', '2026-10-04'), 0);
});
