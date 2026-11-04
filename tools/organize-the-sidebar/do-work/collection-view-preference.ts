// packages/sidebar/do-work/collection-view-preference.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The show-all / per-list toggle state for sidebar collection sections (plan
// T4). ONE published-record DATA row is the truth (component state is a
// mirror): `{ mode: 'show-all' } | { mode: 'collection', collectionId }` — the
// value is DATA, never an enum in code (the renderer only compares strings the
// record itself carries). Read/write address the SAME label_hash cell (the
// save-layout-state SSOT lesson), via direct engine operations so no re-admit
// is needed on live apps (admit-time read-scope caveat).
//
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records'

const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed'
const ENGINE_WRITE_BATCH_OPERATION = 'engine.operation.write-batch'
const ENGINE_READ_CURRENT_OPERATION = 'engine.operation.read-current'
const PUBLISHED_RECORD_PATH = ['current-item', 'published-record'] as const

export const COLLECTION_VIEW_ADDRESS = 'sidebar-collection-view'

export function collectionViewAddress(instanceId = 'sidebar'): string {
  return instanceId === 'sidebar' ? COLLECTION_VIEW_ADDRESS : `${COLLECTION_VIEW_ADDRESS}:${encodeURIComponent(instanceId)}`
}

export interface CollectionViewState {
  /** 'show-all' or a collection id — an open value set carried by DATA. */
  mode: string
  /** Per-collection collapsed flags (sectionId → true = collapsed). */
  collapsed: Record<string, boolean>
}

export const DEFAULT_COLLECTION_VIEW: CollectionViewState = { mode: 'show-all', collapsed: {} }

export function decodeCollectionView(value: unknown): CollectionViewState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_COLLECTION_VIEW
  const record = value as Record<string, unknown>
  const collapsed: Record<string, boolean> = {}
  if (record.collapsed && typeof record.collapsed === 'object' && !Array.isArray(record.collapsed)) {
    for (const [key, flag] of Object.entries(record.collapsed as Record<string, unknown>)) {
      if (flag === true) collapsed[key] = true
    }
  }
  return {
    mode: typeof record.mode === 'string' && record.mode.length > 0 ? record.mode : 'show-all',
    collapsed,
  }
}

// No `partition_label`, deliberately, and no parameter for one. On the JSON
// `engine.operation.label-addressed` path the field is OPTIONAL and the engine
// falls back to the serving envelope's own partition, which is by definition the
// app the user is in. `writeCollectionView` below has always omitted it and works,
// so the read was the odd one out.
//
// It used to default the argument to the literal 'bitfield-studio'. Studio is
// RETIRED, so every caller that omitted the argument (AppSidebar does) read a dead
// store while the write landed in the live one. A read and a write on the same cell
// were pointed at two different apps. That is the failure `readTrustedRuntimePartition`
// exists to prevent: substitute a literal and you address whichever app that name
// happens to belong to, silently. Naming no app is what makes this sidebar work
// unchanged in any app that installs it.
export async function readCollectionView(instanceId = 'sidebar'): Promise<CollectionViewState> {
  try {
    const reply = await sendRequestToBitfieldTarget({
      target: ENGINE_OPERATION_LABEL_TARGET,
      payload: {
        operation_label: ENGINE_READ_CURRENT_OPERATION,
        address_label: collectionViewAddress(instanceId),
        address_mode: 'label_hash',
      },
    }) as { payload?: unknown }
    const bytes = reply?.payload
    if (bytes instanceof Uint8Array) {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { found?: boolean; payload?: unknown }
      if (parsed?.found === true) return decodeCollectionView(parsed.payload)
    }
  } catch {
    /* unreachable engine → default */
  }
  return DEFAULT_COLLECTION_VIEW
}

export async function writeCollectionView(
  state: CollectionViewState,
  instanceId = 'sidebar',
): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: ENGINE_WRITE_BATCH_OPERATION,
      writes: [
        {
          address_label: collectionViewAddress(instanceId),
          address_mode: 'label_hash',
          path_labels: [...PUBLISHED_RECORD_PATH],
          payload: state,
        },
      ],
    },
  })
}
