// Group-owned application contribution: turn opaque product DATA into one
// placeable surface over the existing generic group-board entry. No product
// identity or placement choice is compiled into this owner.

type Plain = Record<string, unknown>;

export interface GroupBoardSurfaceContributionResult {
  schema: 'group.application-board-surface-contribution/composition-scoped-write-set';
  write_set: {
    upserts: Plain[];
    retractions: Plain[];
  };
}

const OWNER_REF = 'package::group::application-contribution::board-surface';

function plain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function textList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => text(item, `${path}[${index}]`));
}

function config(value: unknown): Plain {
  if (!plain(value)) throw new Error('config must be an object');
  if (!plain(value.surface_input)) throw new Error('config.surface_input must be an object');
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${path} must be a non-negative integer`);
  return Number(value);
}

function address(compositionId: string, surfaceId: string): string {
  return `package::group::placeable-surface::${encodeURIComponent(compositionId)}::${encodeURIComponent(surfaceId)}`;
}

export function buildGroupBoardSurfaceContribution(input: unknown): GroupBoardSurfaceContributionResult {
  if (!plain(input)) throw new Error('contribution operation must be an object');
  if (input.owner_ref !== OWNER_REF) throw new Error(`owner_ref must be ${OWNER_REF}`);
  if (input.operation !== 'upsert' && input.operation !== 'retract') throw new Error('operation must be upsert or retract');
  const compositionId = text(input.composition_id, 'composition_id');
  const contributionId = text(input.contribution_id, 'contribution_id');
  const stateEpoch = integer(input.state_epoch, 'state_epoch');
  const source = config(input.config);
  const surfaceId = text(source.surface_id, 'config.surface_id');
  if (input.operation === 'retract') {
    return {
      schema: 'group.application-board-surface-contribution/composition-scoped-write-set',
      write_set: {
        upserts: [],
        retractions: [{
          type: 'record',
          address: address(compositionId, surfaceId),
          path: ['current-item', 'published-record'],
          remove: true,
        }],
      },
    };
  }
  const placementLabels = textList(source.placement_labels, 'config.placement_labels');
  const payload: Plain = {
    kind: 'placeable-surface',
    id: surfaceId,
    surface_id: surfaceId,
    label: text(source.label, 'config.label'),
    ...(typeof source.description === 'string' ? { description: source.description } : {}),
    ...(typeof source.icon === 'string' ? { icon: source.icon } : {}),
    material_target: 'component:group-board',
    package_entry: { package_name: 'group', entry_name: 'group-board' },
    placement_labels: placementLabels,
    placement_order_key: text(source.order_key, 'config.order_key'),
    ...(typeof source.order === 'number' && Number.isFinite(source.order) ? { order: source.order } : {}),
    surface_input: source.surface_input,
    application_composition_ref: {
      composition_id: compositionId,
      contribution_id: contributionId,
      state_epoch: stateEpoch,
    },
    ...(typeof source.auto_open === 'boolean' ? { auto_open: source.auto_open } : {}),
    ...(typeof source.wrap_material === 'boolean' ? { wrap_material: source.wrap_material } : {}),
  };
  return {
    schema: 'group.application-board-surface-contribution/composition-scoped-write-set',
    write_set: {
      upserts: [{
        type: 'record',
        address: address(compositionId, surfaceId),
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
