// packages/group/do-work/apply-grouping-intent.ts
//
// PURPOSE
// Turn declarative grouping INTENT into membership changes over a containment
// projection. Intent says "these groups belong under that parent" in the owner's
// own words; this resolves those words to identities, materializes a parent that
// does not exist yet, and returns the changed projection plus a receipt.
//
// This sits in `group` because it is grouping semantics, not decoding. A decoder
// owns the SHAPE of a foreign tree; what SHOULD be grouped with what is this
// package's concern, and putting it beside the decoder would make every future
// tree source grow its own copy of the same rules.
//
// NON-NEGOTIABLE INVARIANTS
//   A1. INTENT NAMES THINGS THE WAY A HUMAN DOES. Titles, not identities. A
//       person writing intent has never seen a node id, and an intent row full
//       of identities cannot be reviewed, reused, or corrected by the person it
//       belongs to.
//   A2. AMBIGUITY IS REPORTED, NEVER GUESSED. Two groups sharing a title is
//       normal in a real tree. Picking one silently moves the wrong folder, so a
//       duplicate title is a refusal for that row and the rest still applies.
//   A3. NEVER MOVE WHAT WAS NOT ASKED FOR. Only nodes named by intent change
//       parent. Every other record passes through unchanged.
//   A4. A CREATED PARENT IS DECLARED, NOT IMPLIED. A missing parent becomes a
//       record carrying an explicit `materialize` spec, so the write-back owner
//       refuses accidental invention while still allowing this one.
//   A5. NO CYCLES, EVEN THOUGH SOMETHING ELSE ALSO CHECKS. Nesting a group under
//       its own descendant is refused here, because the receipt should name the
//       offending row rather than failing later as an anonymous graph error.
//   A6. PURE. Same inputs, same outputs. No clock, no filesystem, no randomness
//       beyond the caller-supplied identity minter.
//
// SECURITY
// Pure data transformation. Creates no addresses of its own: new parent
// identities come from a caller-supplied minter, so identity policy stays with
// whoever owns identity.

import type { ContainmentRecord } from './group-from-containment-projection.ts';

/** One nesting instruction, written in human words (A1). */
export interface NestIntent {
  readonly parent_title: string;
  readonly child_titles: readonly string[];
}

export interface GroupingIntent {
  readonly intent_ref?: string;
  /** Restrict the intent to one subtree and one depth. Absent means the whole tree. */
  readonly scope?: {
    readonly root_node_id?: string;
    readonly applies_to_role?: string;
    readonly depth?: number;
  };
  /** When present, a parent named by intent but absent from the tree is created. */
  readonly materialize_missing_parents?: { readonly kind: string };
  readonly nest: readonly NestIntent[];
}

export interface IntentRefusal {
  readonly row: string;
  readonly reason:
    | 'parent_title_is_ambiguous'
    | 'child_title_is_ambiguous'
    | 'child_title_not_found'
    | 'parent_absent_and_creation_not_declared'
    | 'would_create_a_cycle'
    | 'child_is_not_in_scope';
  readonly detail: string;
}

export interface ApplyGroupingIntentResult {
  readonly records: readonly ContainmentRecord[];
  readonly moved: readonly string[];
  readonly created: readonly string[];
  readonly refusals: readonly IntentRefusal[];
  readonly untouched: number;
}

const normalize = (title: string): string => title.trim().toLowerCase();

/**
 * Apply grouping intent to a containment projection.
 *
 * `mintIdentity` produces an identity for a parent that must be created. It is
 * an argument because identity policy belongs to whoever owns identity, and a
 * function here that invented ids would make this impure and untestable (A6).
 */
export function applyGroupingIntent(
  records: readonly ContainmentRecord[],
  intent: GroupingIntent,
  mintIdentity: (parentTitle: string) => string,
): ApplyGroupingIntentResult {
  const byId = new Map(records.map((record) => [record.node_id, record]));
  const refusals: IntentRefusal[] = [];

  // Index by normalized title, keeping EVERY match so ambiguity is visible (A2).
  const byTitle = new Map<string, ContainmentRecord[]>();
  for (const record of records) {
    const key = normalize(record.title ?? '');
    if (key.length === 0) continue;
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(record);
    else byTitle.set(key, [record]);
  }

  const inScope = (record: ContainmentRecord): boolean => {
    const scope = intent.scope;
    if (!scope) return true;
    if (scope.applies_to_role != null && record.role !== scope.applies_to_role) return false;
    if (scope.root_node_id != null && rootOf(record.node_id, byId) !== scope.root_node_id) {
      return false;
    }
    if (scope.depth != null && depthOf(record.node_id, byId) !== scope.depth) return false;
    return true;
  };

  // node_id -> the parent it should end up under. Built first, applied once, so
  // a later refusal cannot leave a half-applied intent behind.
  const desiredParent = new Map<string, string>();
  const created: ContainmentRecord[] = [];

  for (const row of intent.nest) {
    const label = row.parent_title;
    const parentMatches = (byTitle.get(normalize(label)) ?? []).filter(
      (record) => record.role === 'group',
    );

    let parentId: string | null = null;
    if (parentMatches.length > 1) {
      refusals.push({
        row: label,
        reason: 'parent_title_is_ambiguous',
        detail: `${parentMatches.length} groups are titled ${JSON.stringify(label)}: ` +
          parentMatches.map((record) => record.node_id).join(', '),
      });
      continue;
    }
    if (parentMatches.length === 1) {
      parentId = parentMatches[0].node_id;
    } else {
      // A4. Creation only when intent declared it.
      const spec = intent.materialize_missing_parents;
      if (!spec) {
        refusals.push({
          row: label,
          reason: 'parent_absent_and_creation_not_declared',
          detail: `no group is titled ${JSON.stringify(label)} and the intent ` +
            'does not declare materialize_missing_parents',
        });
        continue;
      }
      parentId = mintIdentity(label);
      created.push({
        node_id: parentId,
        parent_id: intent.scope?.root_node_id ?? null,
        ordinal: null,
        role: 'group',
        title: label,
        external_identity: null,
        attributes: {},
        // Read by the write-back owner. Undeclared invention stays refused.
        materialize: { kind: spec.kind },
      } as ContainmentRecord & { materialize: { kind: string } });
    }

    for (const childTitle of row.child_titles) {
      const matches = byTitle.get(normalize(childTitle)) ?? [];
      if (matches.length === 0) {
        refusals.push({
          row: `${label} <- ${childTitle}`,
          reason: 'child_title_not_found',
          detail: `nothing is titled ${JSON.stringify(childTitle)}`,
        });
        continue;
      }
      const scoped = matches.filter(inScope);
      if (scoped.length === 0) {
        refusals.push({
          row: `${label} <- ${childTitle}`,
          reason: 'child_is_not_in_scope',
          detail: `${matches.length} match(es) exist but none is in the declared scope`,
        });
        continue;
      }
      if (scoped.length > 1) {
        refusals.push({
          row: `${label} <- ${childTitle}`,
          reason: 'child_title_is_ambiguous',
          detail: `${scoped.length} in-scope nodes are titled ${JSON.stringify(childTitle)}: ` +
            scoped.map((record) => record.node_id).join(', '),
        });
        continue;
      }
      const child = scoped[0];
      if (child.node_id === parentId) continue;
      desiredParent.set(child.node_id, parentId);
    }
  }

  // A5. Refuse a row that would nest a group under its own descendant.
  for (const [childId, parentId] of [...desiredParent.entries()]) {
    if (createsCycle(childId, parentId, byId, desiredParent)) {
      refusals.push({
        row: childId,
        reason: 'would_create_a_cycle',
        detail: `${childId} cannot sit under ${parentId}, which is inside it`,
      });
      desiredParent.delete(childId);
    }
  }

  // Drop any created parent no longer used by a surviving row.
  const usedParents = new Set(desiredParent.values());
  const survivingCreated = created.filter((record) => usedParents.has(record.node_id));

  // A3. Apply once. Everything not named passes through unchanged.
  const moved: string[] = [];
  const next = records.map((record) => {
    const parentId = desiredParent.get(record.node_id);
    if (parentId === undefined || parentId === record.parent_id) return record;
    moved.push(record.node_id);
    return { ...record, parent_id: parentId };
  });

  return {
    records: [...next, ...survivingCreated],
    moved,
    created: survivingCreated.map((record) => record.node_id),
    refusals,
    untouched: records.length - moved.length,
  };
}

function depthOf(nodeId: string, byId: Map<string, ContainmentRecord>): number {
  let depth = 0;
  let cursor = byId.get(nodeId)?.parent_id ?? null;
  const seen = new Set<string>([nodeId]);
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    cursor = byId.get(cursor)?.parent_id ?? null;
  }
  return depth;
}

function rootOf(nodeId: string, byId: Map<string, ContainmentRecord>): string {
  let cursor = nodeId;
  const seen = new Set<string>([nodeId]);
  let parent = byId.get(cursor)?.parent_id ?? null;
  while (parent !== null && byId.has(parent) && !seen.has(parent)) {
    seen.add(parent);
    cursor = parent;
    parent = byId.get(cursor)?.parent_id ?? null;
  }
  return cursor;
}

/**
 * Would putting `childId` under `parentId` close a loop? Walks the PROPOSED
 * hierarchy, so two rows that are each fine alone but circular together are
 * still caught.
 */
function createsCycle(
  childId: string,
  parentId: string,
  byId: Map<string, ContainmentRecord>,
  desiredParent: Map<string, string>,
): boolean {
  let cursor: string | null = parentId;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === childId) return true;
    seen.add(cursor);
    cursor = desiredParent.get(cursor) ?? byId.get(cursor)?.parent_id ?? null;
  }
  return false;
}
