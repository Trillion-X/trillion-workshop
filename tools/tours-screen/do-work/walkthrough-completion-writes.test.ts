import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import type { WalkthroughDefinition } from '../read-data/walkthrough-eeaf.ts';
import {
  completionWriteAfterExit,
  outcomeRefsAfterExit,
} from './walkthrough-completion-writes.ts';

const definition = {
  kind: 'walkthrough-definition',
  id: 'tour',
  entry_step: 'one',
  steps: [{ id: 'one' }],
  triggers: [],
  completion: {
    event_kind: 'trillion.onboarding.completed/v1',
    successor_event_kind: 'scoped-run.completed',
    orientation_revision: 2,
    idempotency_key_fields: ['account_ref', 'orientation_revision'],
    destination_operation_ref: 'owner.act',
    destination_readback_ref: 'owner.readback',
    successor_trigger_ref: 'trigger.engine.record-delta',
  },
} satisfies WalkthroughDefinition;

const run = {
  scope_ref: 'local',
  definition_id: 'tour',
  definition_revision: 4,
  run_id: 'run-9',
};

describe('walkthrough completion writes', () => {
  it('builds one deterministic occurrence after an account-scoped exit', () => {
    const event = {
      event_kind: 'account-session-readback',
      account_ref: 'account:one',
      occurrence_id: 'source:one',
    };
    const first = completionWriteAfterExit(definition, event, 'completed', run);
    const second = completionWriteAfterExit(definition, {
      ...event,
      occurrence_id: 'source:two',
    }, 'completed', run);
    expect(first?.address).toBe(second?.address);
    expect(first?.value_json).toMatchObject({
      kind: 'trillion.onboarding.completed/v1',
      scope_ref: 'local',
      definition_id: 'tour',
      definition_revision: 4,
      run_id: 'run-9',
      disposition: 'completed',
      successor_dispatch: {
        event: { event_kind: 'scoped-run.completed' },
        refs: {
          destination_operation_ref: 'owner.act',
          destination_readback_ref: 'owner.readback',
          successor_trigger_ref: 'trigger.engine.record-delta',
        },
      },
      source_occurrence: 'source:one',
    });
  });

  it('derives the successor event from the source event when DATA omits an explicit event kind', () => {
    expect(outcomeRefsAfterExit({
      ...definition,
      completion: {
        destination_operation_ref: 'owner.act',
        destination_readback_ref: 'owner.readback',
        successor_trigger_ref: 'trigger.engine.successor',
      },
    }, { event_kind: 'run.source-event' })?.successor_dispatch).toEqual({
      event: { event_kind: 'run.source-event' },
      refs: {
        destination_operation_ref: 'owner.act',
        destination_readback_ref: 'owner.readback',
        successor_trigger_ref: 'trigger.engine.successor',
      },
    });
  });

  it('fails closed without complete scoped-run identity or successor refs', () => {
    expect(completionWriteAfterExit(definition, {
      event_kind: 'walkthrough-requested',
    }, 'skipped')).toBeNull();
    expect(completionWriteAfterExit(definition, {
      event_kind: 'walkthrough-requested',
    }, 'skipped', { ...run, run_id: '' })).toBeNull();
    expect(outcomeRefsAfterExit(definition)?.successor_dispatch).not.toBeNull();
  });
});
