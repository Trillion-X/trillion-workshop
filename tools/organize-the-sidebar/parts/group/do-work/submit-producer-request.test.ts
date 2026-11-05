// packages/group/do-work/submit-producer-request.test.ts
import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { submitProducerRequest, type ProducerSubmitDescriptor } from '../../../do-work/submit-producer-request.ts';

const DESCRIPTOR: ProducerSubmitDescriptor = {
  definitionId: 'action:some-producer',
  resultAddressTemplate: 'package::some-producer::result::{id}',
  errorAddressTemplate: 'package::some-producer::error::{id}',
  baseInput: { options: {}, requested_at: '' },
};

describe('submitProducerRequest', () => {
  it('keeps dispatched routing aligned with the initiating request despite competing input fields', async () => {
    let dispatched: Record<string, unknown> | undefined;
    const result = await submitProducerRequest(
      { ...DESCRIPTOR, baseInput: { request_id: 'base-id', target_group_ref: 'base-board', options: { keep: true } } },
      { requestId: 'actual-id', targetGroupRef: 'actual-board', input: {
        request_id: 'input-id', target_group_ref: 'input-board', text: 'Useful task',
      } },
      async request => { dispatched = request.payload as Record<string, unknown>; },
    );
    expect(dispatched?.input).toEqual({ request_id: 'actual-id', target_group_ref: 'actual-board',
      options: { keep: true }, text: 'Useful task' });
    expect(result.requestId).toBe('actual-id');
    expect(result.statusAddresses.resultAddress).toBe('package::some-producer::result::actual-id');
    expect(result.statusAddresses.errorAddress).toBe('package::some-producer::error::actual-id');
  });
  it('fires slot::workflow execute_definition with the DATA definitionId + merged opaque input', async () => {
    const sent: Array<{ target: string; payload: unknown }> = [];
    const out = await submitProducerRequest(
      DESCRIPTOR,
      { requestId: 'gen-abc', input: { instruction_text: 'a calm beach' }, targetGroupRef: 'group:vision-board' },
      async (r) => { sent.push(r); return null; },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].target).toBe('slot::workflow');
    expect(sent[0].payload).toEqual({
      operation: 'execute_definition',
      // NO-REPLY marker — matches the generic no-reply binding so a slow producer
      // (a 30-60s AI compute.process) does NOT block the engine inline.
      include_output: false,
      definition_id: 'action:some-producer',
      input: {
        options: {},
        requested_at: '',
        request_id: 'gen-abc',
        instruction_text: 'a calm beach',   // opaque owner input spread in
        target_group_ref: 'group:vision-board',
      },
    });
    expect(out.requestId).toBe('gen-abc');
    expect(out.statusAddresses).toEqual({
      resultAddress: 'package::some-producer::result::gen-abc',
      errorAddress: 'package::some-producer::error::gen-abc',
    });
  });

  it('is NO-REPLY (include_output:false) so a slow producer does not block the engine inline', async () => {
    const sent: Array<{ target: string; payload: unknown }> = [];
    await submitProducerRequest(
      DESCRIPTOR,
      { requestId: 'gen-1', input: { instruction_text: 'p' }, targetGroupRef: 'g' },
      async (r) => { sent.push(r); return null; },
    );
    // The DATA bit the generic no-reply binding (package-entry-scope-binding.json) matches.
    expect((sent[0].payload as { include_output?: boolean }).include_output).toBe(false);
  });

  it('carries addressMode through when the descriptor declares it', async () => {
    const out = await submitProducerRequest(
      { ...DESCRIPTOR, addressMode: 'identity-text' },
      { requestId: 'x1', input: {}, targetGroupRef: 'g' },
      async () => null,
    );
    expect(out.statusAddresses.addressMode).toBe('identity-text');
  });

  it('is producer-BLIND — a totally different producer works with zero code change', async () => {
    const sent: Array<{ target: string; payload: unknown }> = [];
    const out = await submitProducerRequest(
      {
        definitionId: 'action:agent-research',
        resultAddressTemplate: 'package::agent::out::{id}',
        errorAddressTemplate: 'package::agent::err::{id}',
      },
      { requestId: 'r9', input: { topic: 'beaches' }, targetGroupRef: 'g' },
      async (r) => { sent.push(r); return null; },
    );
    expect((sent[0].payload as { definition_id: string }).definition_id).toBe('action:agent-research');
    expect(out.statusAddresses.resultAddress).toBe('package::agent::out::r9');
    // No baseInput → input carries only the producer-agnostic fields + opaque owner input.
    expect((sent[0].payload as { input: Record<string, unknown> }).input).toEqual({
      request_id: 'r9',
      topic: 'beaches',
      target_group_ref: 'g',
    });
  });

  it('fires opaque input with no prompt key — the board never names what the producer needs', async () => {
    const sent: Array<{ target: string; payload: unknown }> = [];
    await submitProducerRequest(
      DESCRIPTOR,
      { requestId: 'ai-1', input: { output_kind: 'note', wrap_instruction_ref: 'instr:breakdown' }, targetGroupRef: 'grp' },
      async (r) => { sent.push(r); return null; },
    );
    const payload = sent[0].payload as { input: Record<string, unknown> };
    // AI-vocabulary word 'prompt' must be absent — the board is blind to what the producer needs.
    expect('prompt' in payload.input).toBe(false);
    expect(payload.input.output_kind).toBe('note');
    expect(payload.input.wrap_instruction_ref).toBe('instr:breakdown');
  });
});
