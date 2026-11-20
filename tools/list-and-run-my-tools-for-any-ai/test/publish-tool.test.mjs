// tools/list-and-run-my-tools-for-any-ai/test/publish-tool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishTool, unpublishTool, PublishToolError } from '../do-work/publish-tool.mjs';

const descriptor = {
  kind: 'ai-tool-descriptor', id: 'tool:echo-test', job: 'Echo the input text back',
  input_schema: { type: 'object', properties: { text: { type: 'string' } } },
  invoke: { kind: 'container', argv: ['python3', 'main.py'], workdir: '/work' },
  can_do: ['Echo the text back'], cannot_do: ['Send messages'],
  verify: [{ kind: 'sample-run', input: { text: 'hi' } }],
};

// A stand-in for the database: the saved row and the listing row, with the statements the port runs.
const fakeDatabase = ({ saved = [{ id: 'tool:echo-test', descriptor, fingerprint: '1f:aa' }], listings = [] } = {}) => {
  const state = { saved, listings, log: [] };
  state.client = {
    query: async (text, values = []) => {
      state.log.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      if (/^(CREATE|BEGIN|COMMIT|ROLLBACK)/.test(text.trim())) return { rows: [], rowCount: 0 };
      if (/FROM saved_tools/.test(text)) return { rows: state.saved.filter(row => row.id === values[0]), rowCount: 0 };
      if (/FROM marketplace_listings WHERE tool_id = \$1 FOR UPDATE/.test(text)) return { rows: state.listings.filter(row => row.tool_id === values[0]), rowCount: 0 };
      if (/^INSERT INTO marketplace_listings/.test(text.trim())) {
        const row = { tool_id: values[0], maker: values[1], status: 'published', fingerprint: values[2], price_ref: values[3], usage_price: values[4] ? JSON.parse(values[4]) : null, show_on_public_site: values[5] };
        state.listings = state.listings.filter(item => item.tool_id !== row.tool_id).concat(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/^UPDATE marketplace_listings/.test(text.trim())) {
        const row = state.listings.find(item => item.tool_id === values[0]);
        if (row) Object.assign(row, { status: 'withdrawn', body: null });
        const { tool_id, maker, status, fingerprint } = row ?? {};
        return { rows: row ? [{ tool_id, maker, status, fingerprint }] : [], rowCount: row ? 1 : 0 };
      }
      throw new Error(`unexpected statement: ${text}`);
    },
  };
  return state;
};

test('publish lists a saved tool as its maker, hidden from the public site by default', async () => {
  const db = fakeDatabase();
  const { listing } = await publishTool({ tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client);
  assert.equal(listing.maker, 'person:gate-test');
  assert.equal(listing.show_on_public_site, false);
  assert.ok(db.log.includes('COMMIT'));
});

test('publish refuses a tool that is not saved in this database', async () => {
  await assert.rejects(publishTool({ tool_id: 'tool:missing', maker: 'person:gate-test' }, fakeDatabase().client), PublishToolError);
});

test('publish refuses a saved version that changed since it was checked', async () => {
  await assert.rejects(publishTool({ tool_id: 'tool:echo-test', maker: 'person:gate-test', expected_fingerprint: '1f:bb' }, fakeDatabase().client), /changed since/);
});

test('publish refuses a tool with no sample-run check', async () => {
  const db = fakeDatabase({ saved: [{ id: 'tool:echo-test', descriptor: { ...descriptor, verify: [] }, fingerprint: '1f:aa' }] });
  await assert.rejects(publishTool({ tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client), /sample-run/);
});

test('publish refuses both a price_ref and a usage_price', async () => {
  await assert.rejects(publishTool({ tool_id: 'tool:echo-test', maker: 'm', price_ref: 'p', usage_price: { amount_micros: 100, currency: 'usd' } }, fakeDatabase().client), /either/);
});

test('publish refuses a usage_price that is not whole hundreds of micros in usd', async () => {
  await assert.rejects(publishTool({ tool_id: 'tool:echo-test', maker: 'm', usage_price: { amount_micros: 150, currency: 'usd' } }, fakeDatabase().client), /usage_price/);
});

test('another maker cannot take a listing, even after it is withdrawn', async () => {
  const db = fakeDatabase();
  await publishTool({ tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client);
  await unpublishTool({ tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client);
  await assert.rejects(publishTool({ tool_id: 'tool:echo-test', maker: 'person:someone-else' }, db.client), /another maker/);
});

test('withdraw by the maker removes the body and keeps the content-free evidence', async () => {
  const db = fakeDatabase();
  await publishTool({ tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client);
  const { evidence } = await unpublishTool({ tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client);
  assert.equal(evidence.status, 'withdrawn');
  assert.equal(evidence.maker, 'person:gate-test');
  assert.equal(evidence.fingerprint, '1f:aa');
  assert.equal(evidence.body, undefined);
});

test('withdraw by another maker is refused', async () => {
  const db = fakeDatabase();
  await publishTool({ tool_id: 'tool:echo-test', maker: 'person:gate-test' }, db.client);
  await assert.rejects(unpublishTool({ tool_id: 'tool:echo-test', maker: 'person:someone-else' }, db.client), /not a tool this maker published/);
});
