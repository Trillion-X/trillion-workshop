import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  decodeOperationCandidateFact,
  decodeOperationClaim,
  decodeOperationDescriptor,
  decodeOperationEvidence,
  decodeOperationRecord,
  decodeOperationRecords,
  hasExecutableSideEffectContract,
  isCurrentOperationClaim,
  makeDescriptor,
  redactAtom,
} from './operation-records.ts';

describe('operation-records primitive', () => {
  it('decodes maximal open descriptor records without closed travel enums', () => {
    const record = decodeOperationRecord({
      id: 'operation:any',
      ownerPackage: 'any-owner',
      source: { package: 'any-owner', type: 'any_record', id: 'record:any' },
      kindDescriptor: 'future.kind.unseen',
      stateDescriptor: 'future.state.unseen',
      priority: 'board-review',
      priorityDescriptor: 'operation.priority.board-review',
      timeWindow: { startsAt: '2026-06-03 08:20' },
      linkRefs: ['reservation:1'],
      transitions: [{
        id: 'transition:any',
        ownerPackage: 'any-owner',
        actionDefinitionId: 'action:any',
        label: 'Do it',
        input: { id: 'record:any' },
        idempotencyKey: 'idem:any',
        sideEffectClass: 'external-write',
      }],
      display: { title: 'Future thing', status: 'Unseen', reason: 'Still renders', detail: ['Detail'] },
      privacyClass: 'private-to-owner',
      modeHints: ['now', 'risks', 'call-provider'],
      sortKey: '2026-06-03',
      operationClaimRefs: ['claim:any'],
      agentProfileRefs: ['ai-agent-profile:builder'],
      instructionBlockRefs: ['ai-instruction-block:system'],
      memoryContextRefs: ['ai-memory-context:project'],
      toolDescriptorRefs: ['ai-tool:process-session'],
      actionGuardCheckRefs: ['ai-action-guard-check:quota'],
      budgetReservationRefs: ['reservation:any'],
      executionHistoryRefs: ['ai-execution-run:1'],
      relationshipEdgeRefs: ['ai-relationship-edge:agent-tool'],
      trainingBatchRefs: ['ai-training-batch:eval'],
      credentialHandleRefs: ['credential:any'],
      providerHandleRefs: ['provider:any'],
      serviceConnectionHandleRefs: ['service:any'],
    });

    expect(record?.kindDescriptor).toBe('future.kind.unseen');
    expect(record?.priority).toBe('board-review');
    expect(record?.privacyClass).toBe('private-to-owner');
    expect(record?.transitions[0]?.actionDefinitionId).toBe('action:any');
    expect(record?.transitions[0]?.idempotencyKey).toBe('idem:any');
    expect(record?.modeHints).toEqual(['now', 'risks', 'call-provider']);
    expect(record?.agentProfileRefs).toEqual(['ai-agent-profile:builder']);
    expect(record?.instructionBlockRefs).toEqual(['ai-instruction-block:system']);
    expect(record?.memoryContextRefs).toEqual(['ai-memory-context:project']);
    expect(record?.toolDescriptorRefs).toEqual(['ai-tool:process-session']);
    expect(record?.actionGuardCheckRefs).toEqual(['ai-action-guard-check:quota']);
    expect(record?.executionHistoryRefs).toEqual(['ai-execution-run:1']);
    expect(record?.relationshipEdgeRefs).toEqual(['ai-relationship-edge:agent-tool']);
    expect(record?.trainingBatchRefs).toEqual(['ai-training-batch:eval']);
    expect(record?.credentialHandleRefs).toEqual(['credential:any']);
  });

  it('filters malformed records and preserves unknown descriptor fallback labels', () => {
    expect(decodeOperationRecords([{ id: 'missing-owner' }, { id: 'operation:ok', ownerPackage: 'owner', source: { id: 'source:1' } }])).toHaveLength(1);
    expect(makeDescriptor('operation.state.some-new-state', 'state').label).toBe('some new state');
  });

  it('preserves zero descriptor sort ranks as explicit data', () => {
    const descriptor = decodeOperationDescriptor({
      id: 'operation.priority.critical',
      sortRank: 0,
    });

    expect(descriptor?.sortRank).toBe(0);
  });

  it('redacts display atoms from descriptor strategy data instead of privacy labels', () => {
    const descriptor = decodeOperationDescriptor({
      id: 'operation.kind.ticket',
      redactionStrategy: {
        id: 'mask-uppercase-tokens',
        tokenPattern: '[A-Z0-9]{3,}',
        replacement: 'redacted',
      },
    });

    expect(redactAtom('PNR ABC123', descriptor?.redactionStrategy)).toBe('redacted redacted');
    expect(redactAtom('Gate A12', null)).toBe('Gate A12');
  });

  it('decodes side-effect metadata and rejects non-idempotent transitions without an execution contract', () => {
    const safe = decodeOperationRecord({
      id: 'operation:safe',
      ownerPackage: 'owner',
      source: { id: 'source:1' },
      transitions: [{ id: 'transition:safe', ownerPackage: 'owner', actionDefinitionId: 'action:safe', label: 'Safe', idempotencyKey: 'idem:1' }],
    });
    const unsafe = decodeOperationRecord({
      id: 'operation:unsafe',
      ownerPackage: 'owner',
      source: { id: 'source:1' },
      transitions: [{ id: 'transition:unsafe', ownerPackage: 'owner', actionDefinitionId: 'action:unsafe', label: 'Unsafe', sideEffectClass: 'external-write' }],
    });

    expect(hasExecutableSideEffectContract(safe?.transitions[0]!)).toBe(true);
    expect(hasExecutableSideEffectContract(unsafe?.transitions[0]!)).toBe(false);
  });

  it('decodes operation claims and identifies current claim tokens', () => {
    const claim = decodeOperationClaim({
      id: 'claim:1',
      operationRef: 'operation:1',
      actorRef: 'actor:agent',
      claimToken: 'token:1',
      expiresAt: '2026-05-29T11:00:00Z',
    });

    expect(claim?.claimToken).toBe('token:1');
    expect(isCurrentOperationClaim(claim!, 'operation:1', '2026-05-29T10:00:00Z')).toBe(true);
    expect(isCurrentOperationClaim(claim!, 'operation:1', '2026-05-29T12:00:00Z')).toBe(false);
    expect(isCurrentOperationClaim({ ...claim!, supersededBy: 'claim:2' }, 'operation:1', '2026-05-29T10:00:00Z')).toBe(false);
  });

  it('decodes evidence and candidate facts without losing raw source payload', () => {
    expect(decodeOperationEvidence({
      id: 'evidence:voice:1',
      source_kind: 'voice-transcript',
      source_ref: 'capture:1',
      payload: { text: 'Booked the hotel and need to print passport copy.' },
      candidate_fact_refs: ['candidate:hotel'],
    })).toMatchObject({
      id: 'evidence:voice:1',
      sourceKind: 'voice-transcript',
      sourceRef: 'capture:1',
      payload: { text: 'Booked the hotel and need to print passport copy.' },
      candidateFactRefs: ['candidate:hotel'],
    });

    expect(decodeOperationCandidateFact({
      id: 'candidate:hotel',
      target_owner_package: 'reservation-tracker',
      target_record_ref: 'reservation:hotel',
      operation_kind: 'reservation.update',
      proposed_patch: { status: 'confirmed' },
      source_evidence_refs: ['evidence:voice:1'],
      confidence: 0.82,
      review_state: 'needs_review',
    })).toMatchObject({
      id: 'candidate:hotel',
      targetOwnerPackage: 'reservation-tracker',
      proposedPatch: { status: 'confirmed' },
      sourceEvidenceRefs: ['evidence:voice:1'],
    });
  });
});
