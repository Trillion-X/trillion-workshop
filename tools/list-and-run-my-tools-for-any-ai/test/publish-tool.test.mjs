// tools/list-and-run-my-tools-for-any-ai/test/publish-tool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishTool, unpublishTool, publishOutcome, PublishToolError } from '../do-work/publish-tool.mjs';

const descriptor = {
  kind: 'ai-tool-descriptor', id: 'tool:echo-test', job: 'Echo the input text back',
  input_schema: { type: 'object', properties: { text: { type: 'string' } } },
  invoke: { kind: 'container', run: ['python3', 'main.py'], workdir: '/work' },
  can_do: ['Echo the text back'], cannot_do: ['Send messages'],
  verify: [{ kind: 'sample-run', input: { text: 'hi' } }],
  licence_class: 'licence:maker-own', placements: ['placement:this-account'],
};
const files = Buffer.from('print(1)');
// The host version the host-version guard reads (the release check runs only for a tool that names a minimum).
const place = { host_version: '2026.11.20' };

// A stand-in for the database: the saved row and the listing row, answering the statements the port runs.
const fakeDatabase = ({ saved = [{ id: 'tool:echo-test', descriptor, fingerprint: '1f:aa', files }], listings = [] } = {}) => {
  const state = { saved, listings, log: [] };
  state.client = {
    query: async (text, values = []) => {
      const head = text.trim();
      state.log.push(head.split(/\s+/).slice(0, 3).join(' '));
      if (/^(CREATE|ALTER|BEGIN|COMMIT|ROLLBACK)/.test(head)) return { rows: [], rowCount: 0 };
      if (/FROM saved_tools/.test(text)) return { rows: state.saved.filter(row => row.id === values[0]), rowCount: 0 };
      if (/^SELECT \* FROM marketplace_listings/.test(head)) return { rows: state.listings.filter(row => row.tool_id === values[0]), rowCount: 0 };
      if (/FROM marketplace_listings WHERE tool_id = \$1 FOR UPDATE/.test(text)) return { rows: state.listings.filter(row => row.tool_id === values[0]), rowCount: 0 };
      if (/^INSERT INTO marketplace_listings/.test(head)) {
        const row = {
          tool_id: values[0], maker: values[1], status: 'published', fingerprint: values[2], price_ref: values[3],
          usage_price: values[4] ? JSON.parse(values[4]) : null, show_on_public_site: values[5],
          public_run: values[6] ? JSON.parse(values[6]) : null, body: values[7], files: values[8],
        };
        state.listings = state.listings.filter(item => item.tool_id !== row.tool_id).concat(row);
        return { rows: [{ tool_id: row.tool_id, maker: row.maker, status: row.status, fingerprint: row.fingerprint, price_ref: row.price_ref,
          usage_price: row.usage_price, show_on_public_site: row.show_on_public_site, public_run: row.public_run }], rowCount: 1 };
      }
      if (/^UPDATE marketplace_listings/.test(head)) {
        const row = state.listings.find(item => item.tool_id === values[0]);
        if (row) Object.assign(row, { status: 'withdrawn', body: null, files: null, public_run: null });
        return { rows: row ? [{ tool_id: row.tool_id, maker: row.maker, status: row.status, fingerprint: row.fingerprint }] : [], rowCount: row ? 1 : 0 };
      }
      throw new Error(`unexpected statement: ${text}`);
    },
  };
  return state;
};

test('publish lists a saved tool as its maker, hidden from the public site by default', async () => {
  const db = fakeDatabase();
  const { listing } = await publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client);
  assert.equal(listing.maker, 'person:gate-test');
  assert.equal(listing.show_on_public_site, false);
  assert.ok(db.log.includes('COMMIT'));
});

test('publish copies the saved files into the listing, so the listed tool can run for others', async () => {
  const db = fakeDatabase();
  await publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client);
  assert.deepEqual(db.listings[0].files, files);
});

test('publish refuses a tool that is not saved in this database', async () => {
  await assert.rejects(publishTool({ ...place, tool_id: 'tool:missing', maker: 'person:gate-test' }, fakeDatabase().client), PublishToolError);
});

test('publish refuses a saved version that changed since it was checked', async () => {
  await assert.rejects(publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'person:gate-test', expected_fingerprint: '1f:bb' }, fakeDatabase().client), /changed since/);
});

test('publish refuses a tool with no sample-run check', async () => {
  const db = fakeDatabase({ saved: [{ id: 'tool:echo-test', descriptor: { ...descriptor, verify: [] }, fingerprint: '1f:aa', files }] });
  await assert.rejects(publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client), /sample-run/);
});

test('publish refuses both a price_ref and a usage_price', async () => {
  await assert.rejects(publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'm', price_ref: 'p', usage_price: { amount_micros: 100, currency: 'usd' } }, fakeDatabase().client), /either/);
});

test('publish refuses a usage_price that is not whole hundreds of micros in usd', async () => {
  await assert.rejects(publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'm', usage_price: { amount_micros: 150, currency: 'usd' } }, fakeDatabase().client), /usage_price/);
});

test('a public run is refused unless the tool is shown on the public site with no price', async () => {
  const run = { runs_per_day: 10 };
  await assert.rejects(publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'm', public_run: run }, fakeDatabase().client), /public_run is available only/);
  await assert.rejects(publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'm', public_run: run, show_on_public_site: true, price_ref: 'p' }, fakeDatabase().client), /public_run is available only/);
});

test('a public run with its daily ceiling is kept on the listing when the tool is eligible', async () => {
  const db = fakeDatabase();
  const { listing } = await publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'person:gate-test', public_run: { runs_per_day: 10 }, show_on_public_site: true }, db.client);
  assert.equal(listing.show_on_public_site, true);
  assert.deepEqual(listing.public_run, { runs_per_day: 10, max_input_bytes: 16384 });
});

test('another maker cannot take a listing, even after it is withdrawn', async () => {
  const db = fakeDatabase();
  await publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client);
  await unpublishTool({ ...place, tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client);
  await assert.rejects(publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'person:someone-else' }, db.client), /another maker/);
});

test('withdraw by the maker removes the body and files and keeps the content-free evidence', async () => {
  const db = fakeDatabase();
  await publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client);
  const { evidence } = await unpublishTool({ ...place, tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client);
  assert.equal(evidence.status, 'withdrawn');
  assert.equal(evidence.maker, 'person:gate-test');
  assert.equal(evidence.fingerprint, '1f:aa');
  assert.equal(db.listings[0].files, null);
  assert.equal(db.listings[0].body, null);
});

test('withdraw by another maker is refused', async () => {
  const db = fakeDatabase();
  await publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client);
  await assert.rejects(unpublishTool({ ...place, tool_id: 'tool:echo-test', maker: 'person:someone-else' }, db.client), /not a tool this maker published/);
});

test('outcome: a lost publish with the same terms reads as committed, and never publishes again', async () => {
  const db = fakeDatabase();
  await publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client);
  const writes = db.log.filter(line => line.startsWith('INSERT')).length;
  const { outcome } = await publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'person:gate-test', recover: true }, db.client);
  assert.equal(outcome.state, 'committed');
  assert.equal(db.log.filter(line => line.startsWith('INSERT')).length, writes);
});

test('outcome: no listing of this maker reads as aborted', async () => {
  const db = fakeDatabase();
  assert.equal((await publishOutcome({ tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client)).state, 'aborted');
});

test('outcome: a listing on other terms, or a version saved since, reads as unknown', async () => {
  const db = fakeDatabase();
  await publishTool({ ...place, tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client);
  assert.equal((await publishOutcome({ tool_id: 'tool:echo-test', maker: 'person:gate-test', show_on_public_site: true }, db.client)).state, 'unknown');
  db.saved[0].fingerprint = '1f:cc';
  assert.equal((await publishOutcome({ tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client)).state, 'unknown');
});
