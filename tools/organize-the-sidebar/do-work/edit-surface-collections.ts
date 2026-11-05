// packages/sidebar/do-work/edit-surface-collections.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Sidebar-owned dispatchers for editing surface collections (plan T4). Every
// verb is a self-describing op list sent to the group package's ONE mutation
// door (`group.apply-mutation`) by address — the sidebar holds zero membership
// logic and never writes group records itself. Listing uses `group.load-graph`.
//
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records'
import {
  DEFAULT_SIDEBAR_SCOPE,
  SURFACE_COLLECTION_FAMILY,
  decodeGraphReply,
  surfaceCollectionIndexRef,
  type SurfaceCollection,
} from '../read-data/read-surface-collections.ts'
import {
  addRowOps,
  collectionRef,
  createListOps,
  deleteListOps,
  patchListOps,
  removeRowOps,
  reorderRowOps,
  type RowPlacement,
} from './surface-collection-ops.ts'

export const GROUP_APPLY_MUTATION_TARGET = 'group.apply-mutation'
export const GROUP_LOAD_GRAPH_TARGET = 'group.load-graph'

type Op = Record<string, unknown>

/** Send one op batch to the group door; a refused batch throws, so a caller that moved a row can put it back. */
async function dispatch(ops: Op[]): Promise<unknown> {
  const reply = await sendRequestToBitfieldTarget({
    target: GROUP_APPLY_MUTATION_TARGET,
    payload: { ops },
  })
  const receipt = decodeGraphReply(reply)
  if (receipt && typeof receipt === 'object' && (receipt as { ok?: unknown }).ok === false) {
    throw new Error(String((receipt as { error?: unknown }).error ?? 'the list could not be saved'))
  }
  return reply
}

/** Load the full collections graph for a scope (default `sidebar`). The caller
 * decodes with readSurfaceCollections. A scope makes the SAME sidebar render the
 * main nav, a settings nav, or any nested nav (L069). */
export async function loadSurfaceCollectionsGraph(
  scope: string = DEFAULT_SIDEBAR_SCOPE,
  partitionLabel?: string,
  /** Lists read beside the index: the app's lists, so the person's saved copy of each is found at any depth. */
  listIds: readonly string[] = [],
): Promise<unknown> {
  try {
    const reply = await sendRequestToBitfieldTarget({
      target: GROUP_LOAD_GRAPH_TARGET,
      payload: { roots: [surfaceCollectionIndexRef(scope), ...listIds.map(collectionRef)] },
    })
    if (replyHasCompatibilityReadReason(reply)) {
      return loadSurfaceCollectionsGraphFromCurrentRecords(scope, partitionLabel)
    }
    return reply
  } catch (error) {
    if (!isCompatibilityReadReason(error)) throw error
    return loadSurfaceCollectionsGraphFromCurrentRecords(scope, partitionLabel)
  }
}

function replyHasCompatibilityReadReason(reply: unknown): boolean {
  const payload = reply && typeof reply === 'object' ? (reply as { payload?: unknown }).payload : reply
  if (!isByteArray(payload)) return false
  return isCompatibilityReadReason(new TextDecoder().decode(payload))
}

function isByteArray(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && value.constructor.name === 'Uint8Array'
}

function isCompatibilityReadReason(value: unknown): boolean {
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : ''
  return message.includes('FE_ADDRESS_NOT_FOUND')
    || message.includes(`unknown target: ${GROUP_LOAD_GRAPH_TARGET}`)
}

function groupAddress(ref: { family: string; parts: Record<string, string> }): string {
  const parts = Object.fromEntries(Object.entries(ref.parts).sort(([left], [right]) => left.localeCompare(right)))
  return `package::group::group::${JSON.stringify({ family: ref.family, parts })}`
}

function decodeCurrentRecord(reply: unknown): unknown {
  if (!reply || typeof reply !== 'object') return null
  const payload = (reply as { payload?: unknown }).payload
  if (!isByteArray(payload)) return null
  try {
    const decoded = JSON.parse(new TextDecoder().decode(payload)) as unknown
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return decoded
    const current = decoded as { found?: unknown; payload?: unknown }
    if (typeof current.found !== 'boolean') return decoded
    return current.found ? current.payload ?? null : null
  } catch {
    return null
  }
}

async function readCurrentGroup(
  ref: { family: string; parts: Record<string, string> },
  partitionLabel?: string,
): Promise<unknown> {
  return decodeCurrentRecord(await sendRequestToBitfieldTarget({
    target: 'engine.operation.label-addressed',
    payload: {
      operation_label: 'engine.operation.read-current',
      ...(partitionLabel ? { partition_label: partitionLabel } : {}),
      address_label: groupAddress(ref),
      address_mode: 'identity_text',
    },
  }))
}

/**
 * Compatibility path for shells whose group target is absent or predates the
 * leaf-tolerant graph reader. It reads the same group.index and
 * group.collection SSOT records directly, so navigation DATA remains the sole
 * ordering authority while a durable target update catches up.
 */
async function loadSurfaceCollectionsGraphFromCurrentRecords(
  scope: string,
  partitionLabel?: string,
): Promise<unknown> {
  const indexRef = surfaceCollectionIndexRef(scope)
  const index = await readCurrentGroup(indexRef, partitionLabel)
  if (!index || typeof index !== 'object') return { graph: { groups: {} } }
  const rawMembers = (index as { members?: unknown }).members
  const members = rawMembers && typeof rawMembers === 'object' && !Array.isArray(rawMembers)
    ? rawMembers as Record<string, { nodeRef?: { family?: string; parts?: Record<string, string> } }>
    : {}
  const refs = Object.values(members)
    .map((member) => member?.nodeRef)
    .filter((ref): ref is { family: string; parts: Record<string, string> } => (
      ref?.family === SURFACE_COLLECTION_FAMILY && !!ref.parts
    ))
  const collections = await Promise.all(refs.map((ref) => readCurrentGroup(ref, partitionLabel)))
  const groups: Record<string, unknown> = { [groupAddress(indexRef)]: index }
  refs.forEach((ref, indexPosition) => {
    const collection = collections[indexPosition]
    if (collection) groups[groupAddress(ref)] = collection
  })
  return { graph: { groups } }
}

/** Create a collection: group + meta member + index registration, one batch. */
export async function createSurfaceCollection(collectionId: string, name: string, scope = DEFAULT_SIDEBAR_SCOPE): Promise<unknown> {
  // When it was made is a fact its own rules may name ("for 7 days", read-data/apply-list-rules.ts).
  return dispatch(createListOps(collectionId, name, scope, { made_at: new Date().toISOString() }))
}

/** Put rules on a list (when it shows, `shown_when`); null takes one off. */
export async function setSurfaceCollectionRules(
  collection: SurfaceCollection,
  rules: Record<string, unknown>,
): Promise<unknown> {
  return dispatch(patchListOps(collection, rules))
}

/** Rename only the name field against the current meta member. */
export async function renameSurfaceCollection(
  collection: SurfaceCollection,
  name: string,
): Promise<unknown> {
  return dispatch(patchListOps(collection, { name }))
}

/** Update only placement fields against the current collection meta. */
export async function updateSurfaceCollectionPlacement(
  collection: SurfaceCollection,
  placement: SurfaceCollection['placement'],
  attached: boolean,
): Promise<unknown> {
  return dispatch(patchListOps(collection, { placement, attached }))
}

/** Delete = tombstone the group + deregister from the index (append-only). */
export async function deleteSurfaceCollection(collectionId: string, scope = DEFAULT_SIDEBAR_SCOPE): Promise<unknown> {
  return dispatch(deleteListOps(collectionId, scope))
}

/**
 * Add a surface to a collection (multi-membership free — other lists untouched).
 * `list` is the list as shown, needed when the app provides it (see saveAsShownFirst).
 */
export async function addSurfaceToCollection(
  collectionId: string,
  surfaceId: string,
  list?: SurfaceCollection,
): Promise<unknown> {
  return dispatch(addRowOps(collectionId, surfaceId, list))
}

/**
 * Take a row out of a list. From a list the app provides, the row stays in the
 * person's copy marked removed, so the app's own row does not come back.
 */
export async function removeSurfaceFromCollection(
  collectionId: string,
  memberId: string,
  list?: SurfaceCollection,
): Promise<unknown> {
  return dispatch(removeRowOps(collectionId, memberId, list))
}

export async function reorderSurfaceInCollection(
  collectionId: string,
  memberId: string,
  placement: RowPlacement,
  list?: SurfaceCollection,
): Promise<unknown> {
  return dispatch(reorderRowOps(collectionId, memberId, placement, list))
}
