import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import { saveWhatSomeoneIsAllowedToDo } from './save-what-someone-is-allowed-to-do.ts';

const request = {
  lease_ref: 'audit-note', subject_ref: 'audit-subject', holder: 'audit-holder',
  requested_operation_refs: ['audit-operation'], decision_proof: 'audit-proof',
  actor_ref: 'audit-actor', session_ref: 'audit-session', revisions: { policy: 'audit-revision' },
  idempotency_key: 'audit-idempotency',
};
function fixture() {
  const rows: Record<string, unknown>[] = [];
  return { rows, seams: {
    confirmAllowed: async () => ({ verified: true, decision: {
      authorized_action_refs: ['audit-operation'], decision_proof: 'audit-proof',
    } }),
    writeAllowedNote: async (_address: string, payload: Record<string, unknown>) => { rows.push(payload); },
    readAllowedNotes: async () => rows,
  } };
}
describe('session audit: declared permission writer contract', () => {
  it('retains the caller idempotency key in the saved note', async () => {
    const f = fixture(); await saveWhatSomeoneIsAllowedToDo(request, f.seams);
    expect(f.rows[0].idempotency_key).toBe(request.idempotency_key);
  });
  it('accepts the lease_ref field declared by the record-lease workflow', async () => {
    const f = fixture(); const { lease_ref, ...rest } = request;
    await expect(saveWhatSomeoneIsAllowedToDo({ ...rest, lease_ref }, f.seams))
      .resolves.toMatchObject({ saved: true });
  });
  it('refuses a name that already holds somebody else\'s grant, before writing over it', async () => {
    // This used to assert a THROW, because the only thing standing between one
    // grant and another was the readback AFTER the write: the save landed on
    // top of the existing note and the readback then noticed the holder had
    // changed. Nothing was confirmed, and something had already been
    // overwritten. The name is checked before the write now, so this refuses
    // instead of throwing and the other grant is still there afterwards.
    const f = fixture();
    const other = { kind: 'permission_lease', lease_ref: request.lease_ref,
      holder: 'different-holder', revoked: false };
    f.seams.readAllowedNotes = async () => [other];
    await expect(saveWhatSomeoneIsAllowedToDo(request, f.seams))
      .resolves.toMatchObject({ accepted: false, saved: false });
    expect(f.rows).toHaveLength(0);
  });

  it('does the work once when the same request arrives twice', async () => {
    const f = fixture();
    await expect(saveWhatSomeoneIsAllowedToDo(request, f.seams))
      .resolves.toMatchObject({ saved: true });
    await expect(saveWhatSomeoneIsAllowedToDo(request, f.seams))
      .resolves.toMatchObject({ accepted: true, saved: true });
    expect(f.rows).toHaveLength(1);
  });

  it('refuses the same key carrying a different request', async () => {
    const f = fixture();
    await saveWhatSomeoneIsAllowedToDo(request, f.seams);
    await expect(saveWhatSomeoneIsAllowedToDo({ ...request, subject_ref: 'a-different-subject' }, f.seams))
      .resolves.toMatchObject({ accepted: false, saved: false, reason: 'same-key-different-request' });
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0].subject_ref).toBe(request.subject_ref);
  });

  it('a retry cannot switch a revoked note back on', async () => {
    const f = fixture();
    f.seams.readAllowedNotes = async () => [{ kind: 'permission_lease', lease_ref: request.lease_ref,
      holder: request.holder, idempotency_key: request.idempotency_key, revoked: true }];
    await expect(saveWhatSomeoneIsAllowedToDo(request, f.seams))
      .resolves.toMatchObject({ accepted: false, saved: false, reason: 'this-was-revoked-and-needs-a-new-yes' });
    expect(f.rows).toHaveLength(0);
  });

  it('refuses to record a credential the yes never mentioned', async () => {
    // The things list was cut down to the intersection with the yes, so what
    // was saved could never be more than what was allowed. Every other field
    // was copied straight through, so a note could name a saved key the yes
    // said nothing about and the receipt still reported it checked.
    const f = fixture();
    await expect(saveWhatSomeoneIsAllowedToDo(
      { ...request, credential_handle_ref: 'key:some-other-account' },
      f.seams,
    )).resolves.toMatchObject({ accepted: false, saved: false });
    expect(f.rows).toHaveLength(0);
  });

  it('records a credential the yes bounds, and refuses a different one', async () => {
    const bounded = () => {
      const f = fixture();
      f.seams.confirmAllowed = async () => ({ verified: true, decision: {
        authorized_action_refs: ['audit-operation'], decision_proof: 'audit-proof',
        constraints: { saved_field_bounds: {
          credential_handle_ref: { compare: 'same', value: 'key:the-one-you-said' },
        } },
      } });
      return f;
    };
    const yes = bounded();
    await expect(saveWhatSomeoneIsAllowedToDo(
      { ...request, credential_handle_ref: 'key:the-one-you-said' },
      yes.seams,
    )).resolves.toMatchObject({ saved: true });

    const no = bounded();
    await expect(saveWhatSomeoneIsAllowedToDo(
      { ...request, credential_handle_ref: 'key:a-different-one' },
      no.seams,
    )).resolves.toMatchObject({ accepted: false, saved: false });
    expect(no.rows).toHaveLength(0);
  });

  it('will not save a note that outlasts the yes', async () => {
    const withDeadline = (savedExpiry: string | null | undefined) => {
      const f = fixture();
      f.seams.confirmAllowed = async () => ({ verified: true, decision: {
        authorized_action_refs: ['audit-operation'], decision_proof: 'audit-proof',
        constraints: { saved_field_bounds: {
          expires_at: { compare: 'no-later-than', value: '2026-09-11T00:00:00Z' },
        } },
      } });
      return { f, run: () => saveWhatSomeoneIsAllowedToDo(
        { ...request, ...(savedExpiry === undefined ? {} : { expires_at: savedExpiry }) },
        f.seams,
      ) };
    };

    const inside = withDeadline('2026-09-10T12:00:00Z');
    await expect(inside.run()).resolves.toMatchObject({ saved: true });

    const past = withDeadline('2026-09-12T00:00:00Z');
    await expect(past.run()).resolves.toMatchObject({ accepted: false, saved: false });
    expect(past.f.rows).toHaveLength(0);

    // The one that reads as harmless and is the widest of the three: no
    // deadline at all against a yes that had one.
    const forever = withDeadline(null);
    await expect(forever.run()).resolves.toMatchObject({ accepted: false, saved: false });
    expect(forever.f.rows).toHaveLength(0);

    const silent = withDeadline(undefined);
    await expect(silent.run()).resolves.toMatchObject({ accepted: false, saved: false });
    expect(silent.f.rows).toHaveLength(0);
  });

  it('the confirm seam is called without action_ref, so caller ordering does not choose what saves', async () => {
    // A11: verify used to be asked with requested_operation_refs[0]. A verifier
    // that rejects an unauthorized queried action then rejected the same set
    // reordered. Now the decision is looked up by proof and the intersection
    // decides.
    let captured: Record<string, unknown> | null = null;
    const rows: Record<string, unknown>[] = [];
    const seams = {
      confirmAllowed: async (claim: Record<string, unknown>) => {
        captured = claim;
        return {
          verified: true,
          decision: { authorized_action_refs: ['read', 'write'], decision_proof: 'audit-proof' },
        };
      },
      writeAllowedNote: async (_a: string, payload: Record<string, unknown>) => { rows.push(payload); },
      readAllowedNotes: async () => rows,
    };
    await saveWhatSomeoneIsAllowedToDo(
      { ...request, requested_operation_refs: ['delete', 'read'] },
      seams,
    );
    expect(captured).not.toBeNull();
    expect(captured!).not.toHaveProperty('action_ref');
  });

  it('saves the intersection of requested and authorized regardless of caller order', async () => {
    const seams = {
      confirmAllowed: async () => ({
        verified: true,
        decision: { authorized_action_refs: ['read', 'write'], decision_proof: 'audit-proof' },
      }),
      writeAllowedNote: async () => undefined,
      readAllowedNotes: (() => {
        let saved: Record<string, unknown>[] = [];
        return async () => saved;
      })(),
    };
    const rowsA: Record<string, unknown>[] = [];
    const rowsB: Record<string, unknown>[] = [];
    const runOnce = async (order: string[], rows: Record<string, unknown>[]) => {
      const localSeams = {
        confirmAllowed: seams.confirmAllowed,
        writeAllowedNote: async (_a: string, payload: Record<string, unknown>) => {
          rows.push(payload);
        },
        readAllowedNotes: async () => rows,
      };
      return saveWhatSomeoneIsAllowedToDo(
        { ...request, requested_operation_refs: order },
        localSeams,
      );
    };
    const first = await runOnce(['read', 'delete'], rowsA);
    const second = await runOnce(['delete', 'read'], rowsB);
    expect(first).toMatchObject({ accepted: true, saved: true, allowed_things: ['read'], refused_things: ['delete'] });
    expect(second).toMatchObject({ accepted: true, saved: true, allowed_things: ['read'], refused_things: ['delete'] });
  });
});
