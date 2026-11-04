import test from 'node:test';
import assert from 'node:assert/strict';
import { wants, handle } from '../harness/wake-handlers/confirm-source-return.mjs';
import { deliveryHolds } from '../src/agent-delivery.mjs';

const hosted = { agent_id: 'session-claude-code-exact', source_id: 'claude-code:exact', harness: 'claude-code', session_id: 'exact' };
const event = { type: 'source.return.check', to_agent: hosted.agent_id, subject_id: 'h_exact',
  refs: { handoff_id: 'h_exact', transcript_message_id: 'answer-row' } };
const handoff = { handoff_id: 'h_exact', to_agent: hosted.agent_id,
  input: { arrived: { source_id: hosted.source_id } } };

test('a Claude return check signs only the original chat transcript result', async () => {
  assert.equal(wants({ event, hosted }), true);
  const oldFetch = globalThis.fetch;
  let signed = false;
  globalThis.fetch = async (_url, init) => {
    signed = deliveryHolds('ab'.repeat(32), init.headers['trillion-source-signature'], init.body);
    assert.deepEqual(JSON.parse(init.body), { handoff_id: 'h_exact', agent_id: hosted.agent_id,
      source_id: hosted.source_id, message_id: 'kept-message', transcript_message_id: 'answer-row' });
    return { ok: true, json: async () => ({ handoff: { source_return: { verified: true } } }) };
  };
  try {
    const result = await handle({ event, hosted, sourceSecret: 'ab'.repeat(32), key: 'personal-key', origin: 'https://example.test',
      call: async () => ({ handoff }), run: async (_argv, options) => {
        assert.equal(JSON.parse(options.stdin).transcript_message_id, 'answer-row');
        return { code: 0, stdout: '{"message_id":"kept-message","transcript_message_id":"answer-row"}\n' };
      } });
    assert.equal(signed, true);
    assert.equal(result.verified, true);
    await assert.rejects(handle({ event, hosted, sourceSecret: 'ab'.repeat(32), key: 'personal-key', origin: 'https://example.test',
      call: async () => ({ handoff: { ...handoff, input: { arrived: { source_id: 'another-chat' } } } }),
      run: async () => { throw new Error('must not inspect another chat'); } }), /originating chat/);
  } finally { globalThis.fetch = oldFetch; }
});

test('a Codex return check invokes the exact Codex transcript verifier', async () => {
  const codex = { agent_id: 'session-codex-exact', source_id: 'codex:exact', harness: 'codex', session_id: 'exact' };
  const addressed = { ...event, to_agent: codex.agent_id };
  const original = { ...handoff, to_agent: codex.agent_id, input: { arrived: { source_id: codex.source_id } } };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ handoff: { source_return: { verified: true } } }) });
  try {
    const result = await handle({ event: addressed, hosted: codex, sourceSecret: 'ab'.repeat(32),
      key: 'personal-key', origin: 'https://example.test', call: async () => ({ handoff: original }),
      run: async (argv, options) => {
        assert.match(argv[1], /verify-source-return\.mjs$/);
        assert.deepEqual(argv.slice(2), ['--harness', 'codex', '--session', codex.session_id]);
        assert.equal(JSON.parse(options.stdin).transcript_message_id, 'answer-row');
        return { code: 0, stdout: '{"message_id":"kept-message","transcript_message_id":"answer-row"}\n' };
      } });
    assert.equal(result.verified, true);
  } finally { globalThis.fetch = oldFetch; }
});
