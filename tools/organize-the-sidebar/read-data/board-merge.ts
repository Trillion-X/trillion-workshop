// packages/group/read-data/board-merge.ts
//
// The correctness half of multiplayer: when two peers edit the same board at the same time,
// their edits must CONVERGE to one agreed state on every screen, with no clobbering and no
// coordination server deciding a winner. This is a Last-Writer-Wins CRDT over board fields.
//
// Every edit is a `FieldOp` — "member M's field F became V, at logical time (lamport, actor)".
// Merging a bag of ops keeps, per (member, field), the op with the highest (lamport, actorId).
// That comparison is a TOTAL order, so the result is:
//  • deterministic — the same op set yields the same state on every peer;
//  • order-independent — ops can arrive in any order (offline edits, reconnects) and still
//    converge (proven by shuffling in the tests);
//  • conflict-free — concurrent writes to the SAME field pick a stable winner; writes to
//    DIFFERENT fields of the same member both survive.
//
// Delete is not a special case: it is a LWW op on the reserved `__deleted` field, so undelete,
// re-create, and delete-vs-edit races all resolve through the same comparison (L090 — no
// branch on op kind). The TRANSPORT that carries ops between peers is the owner boundary;
// this leaf is the merge + the lamport clock, pure and network-free.

export interface FieldOp {
  readonly memberId: string;
  readonly field: string;
  readonly value: unknown;
  readonly lamport: number; // logical clock — monotonic per actor
  readonly actorId: string; // deterministic tiebreak when lamports are equal
}

export type MemberState = Readonly<Record<string, unknown>>; // field → value
export type BoardState = Readonly<Record<string, MemberState>>; // memberId → fields

export const DELETED_FIELD = '__deleted';

/** Total order on ops: higher lamport wins; equal lamports break by higher actorId. */
function opWins(candidate: FieldOp, incumbent: FieldOp): boolean {
  if (candidate.lamport !== incumbent.lamport) return candidate.lamport > incumbent.lamport;
  return candidate.actorId > incumbent.actorId;
}

/** Fold a bag of ops into converged board state. Order-independent and deterministic. */
export function mergeOps(ops: readonly FieldOp[]): BoardState {
  // Winners are keyed by member THEN field — a NESTED map, never a concatenated string key. Any single-string
  // key (`${memberId}<sep>${field}`) collides whenever the separator can appear in an id/field: with a space
  // "a b"+"c" and "a"+"b c" both make "a b c"; even a NUL separator collides on "a\0b"+"c" vs "a"+"b\0c". A
  // collision would silently clobber two distinct fields — the exact conflict this CRDT exists to prevent. Two
  // levels of Map cannot collide regardless of what characters an id or field contains (machine-readable over
  // encoded-string keys).
  const winners = new Map<string, Map<string, FieldOp>>();
  for (const op of ops) {
    let byField = winners.get(op.memberId);
    if (!byField) {
      byField = new Map();
      winners.set(op.memberId, byField);
    }
    const cur = byField.get(op.field);
    if (!cur || opWins(op, cur)) byField.set(op.field, op);
  }
  // NULL-PROTOTYPE accumulators: `op.field` and `op.memberId` are untrusted (a FieldOp arrives from a
  // multiplayer peer over the transport). On a plain `{}`, `fields['__proto__'] = value` REASSIGNS the
  // member-state's [[Prototype]] (and `out['__proto__'] = fields` reassigns out's), so a crafted op like
  // `{field:'__proto__', value:{__deleted:true}}` makes liveMembers read an INHERITED `__deleted:true` and
  // falsely tombstone the member — corrupting the very CRDT convergence this leaf exists to guarantee. A
  // null-proto map has no `__proto__`/`constructor` accessor, so every untrusted key is a plain own field
  // (a field literally named '__proto__' is stored, not interpreted). (The transport is not wired yet —
  // latent — but this boundary MUST be proto-safe before the multiplayer merge substrate goes live.)
  const out: Record<string, Record<string, unknown>> = Object.create(null);
  for (const [memberId, byField] of winners) {
    const fields: Record<string, unknown> = Object.create(null);
    for (const op of byField.values()) fields[op.field] = op.value;
    out[memberId] = fields;
  }
  return out;
}

/** memberIds that are live (exist and not tombstoned), sorted for deterministic iteration. */
export function liveMembers(state: BoardState): string[] {
  return Object.keys(state)
    .filter((id) => state[id][DELETED_FIELD] !== true)
    .sort();
}

/** Highest lamport seen in a bag of ops (0 if none) — the basis for the next tick. */
export function maxLamport(ops: readonly FieldOp[]): number {
  let m = 0;
  for (const op of ops) if (op.lamport > m) m = op.lamport;
  return m;
}

/** The lamport an actor should stamp on its next local edit, having observed `observedMax`. */
export function nextLamport(observedMax: number): number {
  return observedMax + 1;
}
