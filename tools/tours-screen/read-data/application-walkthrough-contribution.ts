// guided-overlay owns materialization of application-authored walkthrough DATA.
// The application-composition handler only routes this opaque contribution.

type Plain = Record<string, unknown>;

const OWNER_REF = 'package::guided-overlay::application-contribution::walkthrough-definition';

function plain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${path} must be a non-negative integer`);
  return Number(value);
}

function address(compositionId: string, definitionId: string): string {
  return `package::guided-overlay::walkthrough-definition::${encodeURIComponent(compositionId)}::${encodeURIComponent(definitionId)}`;
}

export function buildApplicationWalkthroughContribution(input: unknown) {
  if (!plain(input)) throw new Error('contribution operation must be an object');
  if (input.owner_ref !== OWNER_REF) throw new Error(`owner_ref must be ${OWNER_REF}`);
  if (input.operation !== 'upsert' && input.operation !== 'retract') throw new Error('operation must be upsert or retract');
  const compositionId = text(input.composition_id, 'composition_id');
  const contributionId = text(input.contribution_id, 'contribution_id');
  const stateEpoch = integer(input.state_epoch, 'state_epoch');
  if (!plain(input.config) || !plain(input.config.definition)) throw new Error('config.definition must be an object');
  const definition = input.config.definition;
  const id = text(definition.id, 'config.definition.id');
  if (input.operation === 'retract') {
    return {
      schema: 'guided-overlay.application-walkthrough-contribution/composition-scoped-write-set',
      write_set: {
        upserts: [],
        retractions: [{
          type: 'record',
          address: address(compositionId, id),
          path: ['current-item', 'published-record'],
          remove: true,
        }],
      },
    };
  }
  if (definition.kind !== 'walkthrough-definition') throw new Error('config.definition.kind must be walkthrough-definition');
  const payload = {
    ...definition,
    application_composition_ref: {
      composition_id: compositionId,
      contribution_id: contributionId,
      state_epoch: stateEpoch,
    },
  };
  return {
    schema: 'guided-overlay.application-walkthrough-contribution/composition-scoped-write-set',
    write_set: {
      upserts: [{
        type: 'record',
        address: address(compositionId, id),
        address_mode: 'identity_text',
        path: ['current-item', 'published-record'],
        payload,
        payload_text: null,
        payload_base64: null,
        remove: false,
      }],
      retractions: [],
    },
  };
}
