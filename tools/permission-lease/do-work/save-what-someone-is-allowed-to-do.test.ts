import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  saveWhatSomeoneIsAllowedToDo,
  type AllowedConfirmation,
  type WhatYouAllowed,
} from './save-what-someone-is-allowed-to-do.ts';

// A tiny store that captures saves and reads them back by lease_ref, so the read-back
// the saver does runs against real saved bytes.
function makeSeams(confirmation: AllowedConfirmation) {
  const store: Record<string, unknown>[] = [];
  const writes: Array<{ address: string; payload: Record<string, unknown> }> = [];
  return {
    writes,
    seams: {
      confirmAllowed: async () => confirmation,
      writeAllowedNote: async (address: string, payload: Record<string, unknown>) => {
        writes.push({ address, payload });
        store.push(payload);
      },
      readAllowedNotes: async (noteRef: string) => store.filter((record) => record.lease_ref === noteRef),
    },
  };
}

function allowed(things: string[], constraints?: Record<string, unknown>): AllowedConfirmation {
  const decision: WhatYouAllowed = { authorized_action_refs: things, decision_proof: 'proof-xyz',
    ...(constraints ? { constraints } : {}) };
  return { verified: true, decision };
}

const baseRequest = {
  lease_ref: 'note:1',
  subject_ref: 'subject:agent-a',
  holder: 'subject:agent-a',
  requested_operation_refs: ['interactive-browser'],
  decision_proof: 'proof-xyz',
  actor_ref: 'actor:agent-a',
  session_ref: 'session:1',
  revisions: { membership_revision: 'm1', policy_revision: 'p1', resource_revision: 'r1', session_revision: 's1' },
  idempotency_key: 'idem-1',
};

describe('saveWhatSomeoneIsAllowedToDo', () => {
  it('saves an "allowed to" note isAllowed can serve when you allowed the thing', async () => {
    const { seams, writes } = makeSeams(allowed(['interactive-browser']));
    const receipt = await saveWhatSomeoneIsAllowedToDo(baseRequest, seams);

    expect(receipt.accepted).toBe(true);
    expect(receipt.saved).toBe(true);
    expect(receipt.allowed_things).toEqual(['interactive-browser']);
    // The saved record is exactly the shape isAllowed reads: kind, not cancelled, thing in allowed_operation_refs.
    const written = writes[0].payload;
    expect(written.kind).toBe('permission_lease');
    expect(written.revoked).toBe(false);
    expect(written.allowed_operation_refs).toEqual(['interactive-browser']);
    expect(written.allowed_by_decision_proof).toBe('proof-xyz');
  });

  it('REFUSES BY DEFAULT: no confirmed yes saves nothing (a bot cannot allow itself)', async () => {
    const { seams, writes } = makeSeams({ verified: false, reason: 'decision-not-found' });
    const receipt = await saveWhatSomeoneIsAllowedToDo(baseRequest, seams);

    expect(receipt.accepted).toBe(false);
    expect(receipt.saved).toBe(false);
    expect(receipt.reason).toBe('decision-not-found');
    expect(writes.length).toBe(0);
  });

  it('CUTS DOWN: saves only things you allowed, refusing the rest', async () => {
    const { seams, writes } = makeSeams(allowed(['interactive-browser']));
    const receipt = await saveWhatSomeoneIsAllowedToDo(
      { ...baseRequest, requested_operation_refs: ['interactive-browser', 'shell-exec', 'network-egress'] },
      seams,
    );

    expect(receipt.accepted).toBe(true);
    expect(receipt.allowed_things).toEqual(['interactive-browser']);
    expect(receipt.refused_things).toEqual(['shell-exec', 'network-egress']);
    // What is saved is a strict subset of what you allowed: nothing extra is allowed.
    expect(writes[0].payload.allowed_operation_refs).toEqual(['interactive-browser']);
  });

  it('saves exact owner-bounded context without learning its vocabulary', async () => {
    const bound_context = { work_ref: 'work:one', observer_id: 'observer:one', nested: { ref: 'result:one' } };
    const confirmation = allowed(['learn-local-saved-result'], { saved_field_bounds: {
      bound_context: { compare: 'same', value: bound_context },
    } });
    const { seams, writes } = makeSeams(confirmation);
    const receipt = await saveWhatSomeoneIsAllowedToDo({ ...baseRequest,
      requested_operation_refs: ['learn-local-saved-result'], bound_context }, seams);
    expect(receipt.accepted).toBe(true);
    expect(writes[0].payload).toMatchObject({ kind: 'permission_lease', bound_context });
    expect(await saveWhatSomeoneIsAllowedToDo({ ...baseRequest,
      requested_operation_refs: ['learn-local-saved-result'], bound_context }, seams))
      .toMatchObject({ accepted: true, saved: true });
    expect(writes).toHaveLength(1);
    expect(await saveWhatSomeoneIsAllowedToDo({ ...baseRequest,
      requested_operation_refs: ['learn-local-saved-result'],
      bound_context: { ...bound_context, work_ref: 'work:other' } }, seams))
      .toMatchObject({ accepted: false, reason: 'wider-than-the-yes: bound_context' });
    expect(writes).toHaveLength(1);
  });

  it('does not confirm a save when readback dropped the bounded context', async () => {
    const bound_context = { work_ref: 'work:one' };
    const saved: Record<string, unknown>[] = [];
    await expect(saveWhatSomeoneIsAllowedToDo({ ...baseRequest,
      requested_operation_refs: ['learn-local-saved-result'], bound_context }, {
      confirmAllowed: async () => allowed(['learn-local-saved-result'], { saved_field_bounds: {
        bound_context: { compare: 'same', value: bound_context },
      } }),
      writeAllowedNote: async (_address, payload) => {
        const { bound_context: _dropped, ...incomplete } = payload;
        saved.push(incomplete);
      },
      readAllowedNotes: async () => saved,
    })).rejects.toThrow('could not be confirmed');
  });

  it('refuses unbounded or changed context before writing permission', async () => {
    const bound_context = { work_ref: 'work:one' };
    for (const confirmation of [
      allowed(['learn-local-saved-result']),
      allowed(['learn-local-saved-result'], { saved_field_bounds: {
        bound_context: { compare: 'same', value: { work_ref: 'work:other' } },
      } }),
    ]) {
      const { seams, writes } = makeSeams(confirmation);
      const receipt = await saveWhatSomeoneIsAllowedToDo({ ...baseRequest,
        requested_operation_refs: ['learn-local-saved-result'], bound_context }, seams);
      expect(receipt.accepted).toBe(false);
      expect(receipt.reason).toContain(confirmation.decision?.constraints ? 'wider-than-the-yes' : 'the-yes-does-not-say');
      expect(writes).toHaveLength(0);
    }
  });

  it('refuses entirely when you allowed NONE of the requested things', async () => {
    const { seams, writes } = makeSeams(allowed(['some-other-thing']));
    const receipt = await saveWhatSomeoneIsAllowedToDo(baseRequest, seams);

    expect(receipt.accepted).toBe(false);
    expect(receipt.saved).toBe(false);
    expect(receipt.reason).toBe('none-of-it-was-allowed');
    expect(receipt.refused_things).toEqual(['interactive-browser']);
    expect(writes.length).toBe(0);
  });

  it('refuses a raw secret in the request (saved handle only)', async () => {
    const { seams, writes } = makeSeams(allowed(['interactive-browser']));
    const receipt = await saveWhatSomeoneIsAllowedToDo(
      { ...baseRequest, token: 'sk-live-abc' },
      seams,
    );

    expect(receipt.accepted).toBe(false);
    expect(receipt.reason).toBe('saved-key-handle-required');
    expect(writes.length).toBe(0);
  });

  it('confirms your yes names the HOLDER as subject, so a yes for someone else cannot be borrowed', async () => {
    let seenSubject = '';
    // The readback hands back what was actually written. A hand-built row with
    // only the name on it used to be enough to confirm a save, which is the
    // defect the readback comparison now catches, so a fixture that keeps
    // working by being vague would be testing the old behaviour.
    const saved: Record<string, unknown>[] = [];
    const receipt = await saveWhatSomeoneIsAllowedToDo(baseRequest, {
      confirmAllowed: async (claim) => {
        seenSubject = claim.subject_ref;
        return allowed(['interactive-browser']);
      },
      writeAllowedNote: async (_address, payload) => { saved.push(payload); },
      readAllowedNotes: async () => saved,
    });

    expect(seenSubject).toBe('subject:agent-a');
    expect(receipt.accepted).toBe(true);
  });
});
