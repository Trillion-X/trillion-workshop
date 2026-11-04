// packages/group/read-data/collection-store.ts
//
// The pure persistence store for the collection primitive (R1/R5 of the vision
// board plan). A collection is a saved, reusable, portable stack of board items
// (a user template). It is stored as a `BoardTemplate` — the SSOT portable-stack
// model that applyTemplate + TemplatesGallery already consume — so a saved
// collection is a first-class template that can be applied to a fresh board.
// Collections are stored the same way boards are: as members of an index group,
// keyed by an index id. Each collection is a member whose opaque presentation
// carries its BoardTemplate plus its name, id, and archived flag. The group leaf
// and EEAF stay blind (I1). No I/O, no React, no Date/random (I3).
//
// A distinct index family keeps collections separate from boards: boards live
// under group.board-index; collections live under group.collection-index. So
// saving a collection never touches the board switcher for the same surface id.
//
// This mirrors group-board-model.ts (the board index store) precisely:
//   boardIndexRef          -> collectionIndexRef
//   addBoard/addBoardEntry -> saveCollection (add-or-update)
//   readActiveBoards       -> readActiveCollections
//   readArchivedBoards     -> readArchivedCollections
//   renameBoard            -> renameCollection
//   archiveBoard           -> archiveCollection
//   restoreBoard           -> restoreCollection
// so it composes with the same immutable commit/undo machinery.

import { type AddressRef, type GroupGraph } from '../../ui/show/group/group-graph';
import { type BoardTemplate, type TemplateItem } from './board-template-apply';
import {
  recordIndexRef,
  readRecords,
  readActiveRecords,
  readArchivedRecords,
  getRecord,
  saveRecord,
  renameRecord,
  archiveRecord,
  restoreRecord,
  type RecordStoreSpec,
  type StoredRecord,
} from './named-record-index';

// One saved collection decoded from an index member. record is the portable payload.
export interface StoredCollection {
  readonly memberId: string;
  readonly collectionId: string;
  readonly name: string;
  // True iff archived: hidden from the active list, restorable (soft-delete).
  readonly archived: boolean;
  // The portable stack payload, a BoardTemplate (applyTemplate consumes this directly).
  readonly record: BoardTemplate;
  // A caller-supplied save timestamp (ms), when present. The model never calls Date.now().
  readonly savedAt?: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// Maximum section-nesting depth this validator will accept. `value.children` recurses, and the
// stored record is UNTRUSTED (a member's `presentation.record`, an imported share/template). A
// pathologically deep `children` chain (a crafted 50k-deep nesting) would blow the call stack in
// this recursive validator — a RangeError DoS that defeats the whole point of a fail-closed parser
// (its job is to REJECT malformed records, not crash on them). Bounding the depth makes an
// over-deep record fail closed to `null` (skipped by readCollections) exactly like any other shape
// violation. 256 is orders of magnitude beyond any real hand-built section tree, so no legitimate
// collection is ever rejected. `idsUnique` below and the downstream applier walk the SAME tree, so
// capping the validator caps every recursive consumer of a stored record at one bedrock boundary.
const MAX_TEMPLATE_DEPTH = 256;

// Strictly validate an unknown value as a BoardTemplate; null on any shape violation
// (never throws), so the store never surfaces a malformed stored record. Each item
// carries a string id/kind and finite x/y/w/h; optional text/from/to are strings and
// extra is a plain object; nested-section children recurse (bounded by MAX_TEMPLATE_DEPTH).
function parseTemplateItem(value: unknown, depth = 0): TemplateItem | null {
  if (depth > MAX_TEMPLATE_DEPTH) return null; // over-deep nesting → fail closed (no stack-overflow DoS)
  if (!isPlainObject(value)) return null;
  if (typeof value.id !== 'string') return null;
  if (typeof value.kind !== 'string') return null;
  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return null;
  if (!isFiniteNumber(value.w) || !isFiniteNumber(value.h)) return null;
  if (value.text !== undefined && typeof value.text !== 'string') return null;
  if (value.from !== undefined && typeof value.from !== 'string') return null;
  if (value.to !== undefined && typeof value.to !== 'string') return null;
  if (value.extra !== undefined && !isPlainObject(value.extra)) return null;

  let children: TemplateItem[] | undefined;
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) return null;
    children = [];
    for (const raw of value.children) {
      const child = parseTemplateItem(raw, depth + 1);
      if (child === null) return null;
      children.push(child);
    }
  }

  const item: {
    id: string;
    kind: string;
    x: number;
    y: number;
    w: number;
    h: number;
    text?: string;
    extra?: Readonly<Record<string, unknown>>;
    children?: readonly TemplateItem[];
    from?: string;
    to?: string;
  } = { id: value.id, kind: value.kind, x: value.x, y: value.y, w: value.w, h: value.h };
  if (value.text !== undefined) item.text = value.text;
  if (value.extra !== undefined) item.extra = value.extra as Readonly<Record<string, unknown>>;
  if (children !== undefined) item.children = children;
  if (value.from !== undefined) item.from = value.from;
  if (value.to !== undefined) item.to = value.to;
  return item;
}

export function parseBoardTemplate(value: unknown): BoardTemplate | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.id !== 'string') return null;
  if (typeof value.name !== 'string') return null;
  if (value.category !== undefined && typeof value.category !== 'string') return null;
  // The library card + tag/keyword search read these; dropping them on the round-trip loses the
  // description, tag-search metadata, and the pre-configured board LOOK (background/appearance).
  if (value.description !== undefined && typeof value.description !== 'string') return null;
  if (value.background !== undefined && typeof value.background !== 'string') return null;
  if (value.appearance !== undefined && !isPlainObject(value.appearance)) return null;
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some((t) => typeof t !== 'string'))) return null;
  if (!Array.isArray(value.items)) return null;

  const items: TemplateItem[] = [];
  for (const raw of value.items) {
    const item = parseTemplateItem(raw);
    if (item === null) return null;
    items.push(item);
  }
  // FAIL-CLOSED: template-local ids MUST be unique across the whole tree — applyTemplate mints one
  // member per id and remaps connectors by id, so a duplicate id would collide (addMember throws).
  const seen = new Set<string>();
  const idsUnique = (list: readonly TemplateItem[]): boolean => {
    for (const it of list) {
      if (seen.has(it.id)) return false;
      seen.add(it.id);
      if (it.children && !idsUnique(it.children)) return false;
    }
    return true;
  };
  if (!idsUnique(items)) return null;

  const template: {
    id: string;
    name: string;
    category?: string;
    description?: string;
    tags?: readonly string[];
    background?: string;
    appearance?: Readonly<Record<string, unknown>>;
    items: readonly TemplateItem[];
  } = { id: value.id, name: value.name, items };
  if (value.category !== undefined) template.category = value.category;
  if (value.description !== undefined) template.description = value.description;
  if (value.tags !== undefined) template.tags = value.tags as readonly string[];
  if (value.background !== undefined) template.background = value.background;
  if (value.appearance !== undefined) template.appearance = value.appearance as Readonly<Record<string, unknown>>;
  return template;
}

// The collection record TYPE as a named-record-index config: a BoardTemplate payload validated by
// parseBoardTemplate, kept in its own index/node family so it never collides with boards or other record types.
// All the CRUD (save/list/get/rename/archive/restore, the archived-preserving update, the malformed-skip, the
// index isolation) lives ONCE in named-record-index; this store is now this spec + thin name-mapping wrappers.
const COLLECTION_SPEC: RecordStoreSpec<BoardTemplate> = {
  indexFamily: 'group.collection-index',
  nodeFamily: 'group.collection',
  partKey: 'collection',
  kind: 'collection',
  parseRecord: parseBoardTemplate,
  idOf: (t) => t.id,
  nameOf: (t) => t.name,
};

// The collection-index ref for a surface (default vision-board). Distinct family from the board index so the
// two never collide for the same surface id.
export function collectionIndexRef(indexId = 'vision-board'): AddressRef {
  return recordIndexRef(COLLECTION_SPEC, indexId);
}

// Map the generic StoredRecord onto the collection-shaped view (recordId → collectionId), the public shape
// every consumer already depends on.
function toCollection(r: StoredRecord<BoardTemplate>): StoredCollection {
  return { memberId: r.memberId, collectionId: r.recordId, name: r.name, archived: r.archived, record: r.record, ...(r.savedAt !== undefined ? { savedAt: r.savedAt } : {}) };
}

// Read every collection registered in an index (active + archived). A member whose record fails strict
// validation (parseBoardTemplate → null) is skipped, so the store never surfaces a malformed collection.
export function readCollections(graph: GroupGraph, indexRef: AddressRef): StoredCollection[] {
  return readRecords(graph, indexRef, COLLECTION_SPEC).map(toCollection);
}

// The active (non-archived) collections: what the collection picker lists.
export function readActiveCollections(graph: GroupGraph, indexRef: AddressRef): StoredCollection[] {
  return readActiveRecords(graph, indexRef, COLLECTION_SPEC).map(toCollection);
}

// The archived collections: what the archive view lists (restorable).
export function readArchivedCollections(graph: GroupGraph, indexRef: AddressRef): StoredCollection[] {
  return readArchivedRecords(graph, indexRef, COLLECTION_SPEC).map(toCollection);
}

// Get one stored collection by its member id (undefined if absent or malformed).
export function getCollection(graph: GroupGraph, indexRef: AddressRef, memberId: string): StoredCollection | undefined {
  const r = getRecord(graph, indexRef, memberId, COLLECTION_SPEC);
  return r ? toCollection(r) : undefined;
}

// Save a collection into the index (add-or-update, keyed by memberId). A re-save of an existing memberId
// updates it in place and preserves its archived flag.
export function saveCollection(
  graph: GroupGraph,
  indexRef: AddressRef,
  args: { memberId: string; collectionId: string; name: string; record: BoardTemplate; savedAt?: number },
): GroupGraph {
  return saveRecord(graph, indexRef, { memberId: args.memberId, recordId: args.collectionId, name: args.name, record: args.record, savedAt: args.savedAt }, COLLECTION_SPEC);
}

// Rename a saved collection (the label shown in the picker); leaves record untouched.
export function renameCollection(graph: GroupGraph, indexRef: AddressRef, memberId: string, name: string): GroupGraph {
  return renameRecord(graph, indexRef, memberId, name);
}

// Archive a collection (recoverable soft-delete). Already-archived returns the same graph ref (immutability).
export function archiveCollection(graph: GroupGraph, indexRef: AddressRef, memberId: string): GroupGraph {
  return archiveRecord(graph, indexRef, memberId);
}

// Restore an archived collection back into the active picker. Already-active returns the same graph ref.
export function restoreCollection(graph: GroupGraph, indexRef: AddressRef, memberId: string): GroupGraph {
  return restoreRecord(graph, indexRef, memberId);
}
