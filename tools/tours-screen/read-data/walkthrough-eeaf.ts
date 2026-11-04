// parts/guided-overlay/read-data/walkthrough-eeaf.ts
//
// PURPOSE
// The translation boundary (L098) for guided-overlay. Tours are `walkthrough-definition`
// records (DATA the app ships) and a person's progress is ONE `walkthrough-progress`
// record kept in their own Trillion store. CALLERS (the engine cursor, the trigger
// intake, the React surfaces) get finished, typed shapes. This module is the ONLY place
// that knows the record shapes; writes belong to `do-work/walkthrough-progress.ts`.
//
// NON-NEGOTIABLE INVARIANTS
//   - BLIND (L090): the decoder validates ONLY the structural fields the engine
//     reads (id, entry_step, step ids, branch_map, triggers). Every presentation
//     field (`content`, `target_ref`, `cutout`, `placement`, `advance_condition`,
//     `nav`, `narrator`, `look`, `progress_style`) is carried through OPAQUE.
//   - TOMBSTONE-AWARE: a record with `status:'deleted'` REMOVES its id (latest
//     write wins, including deletes).
//   - DETERMINISTIC: folds emit id-sorted maps so assembly is reproducible.
//
// RECORD SHAPES
//   definition  { kind:'walkthrough-definition', id, entry_step, steps[], triggers[] , ... }
//   progress    { kind:'walkthrough-progress', consumed_once_keys[], consumed_at{key: ISO}, cursors{definition id: cursor} }

import type { StepShape, WalkthroughShape } from '../engine/branch-resolver';
import type { Trigger } from '../engine/trigger-intake';
import { selectTrigger } from '../engine/trigger-intake';
import type { HostEvent } from '../engine/trigger-intake';

// ── Live shapes the callers consume ─────────────────────────────────────────

/**
 * One step record. The engine reads `id` + `branch_map` (via StepShape); the
 * React surface reads the OPAQUE presentation fields (passed verbatim to the
 * blind registries). The decoder never interprets the opaque fields.
 */
export interface WalkthroughStep extends StepShape {
  readonly id: string;
  readonly presentation_ref?: unknown;
  readonly target_ref?: unknown;
  readonly cutout?: unknown;
  readonly placement?: unknown;
  readonly content?: unknown;
  readonly advance_condition?: unknown;
  /** What the step does to the control it points at when Next is pressed (`{ do, within?, text?, commit? }`, do-work/act-on-target.ts). */
  readonly act?: unknown;
  readonly nav?: unknown;
  readonly narrator?: unknown;
  /** Optional presentation changes for this step, such as a centered-card backdrop. */
  readonly look?: unknown;
  readonly target_preparation?: unknown;
  /** Step-local override of the tour's `escapable`. */
  readonly escapable?: boolean;
  /**
   * Words shown under the step's content while its owner-readback condition waits (`waiting`) and once it holds
   * (`ready`, with `{field}` filled from the readback; `ready_without` when a named field is empty).
   */
  readonly status_note?: unknown;
  /** Show the step centred, in its own words, when its target cannot be found. */
  readonly centered_when_target_missing?: boolean;
  // branch_map inherited from StepShape
}

/** A live walkthrough definition. Assignable to `WalkthroughShape` (engine-ready). */
export interface WalkthroughDefinition extends WalkthroughShape {
  readonly kind: 'walkthrough-definition';
  readonly id: string;
  readonly revision?: number;
  readonly title?: string;
  /** One plain line about what the tour shows, for a list of tours. */
  readonly summary?: string;
  /** Where the tour sits in a list of tours (lower first); tours without one follow, by id. */
  readonly order?: number;
  readonly progress_style?: unknown;
  readonly look?: unknown;
  /**
   * A tour that plays itself (`{ step_ms }`): each step shows for its `look.hold_ms` (else `step_ms`), then its action
   * runs for the person; the last step waits for them, and their own press or key outside the card stops the playing.
   */
  readonly play?: unknown;
  readonly status_copy?: unknown;
  /**
   * False keeps the tour open against Escape and a press outside it: it closes only through its own controls
   * (Skip moves past one step, End tour ends it). Absent means true. A step may override it.
   */
  readonly escapable?: boolean;
  readonly entry_step: string;
  readonly steps: readonly WalkthroughStep[];
  readonly triggers: readonly Trigger[];
}

/** One saved place in one tour. */
export interface WalkthroughCursorState {
  readonly currentStepId: string;
  readonly history: readonly string[];
  readonly status: 'active' | 'complete';
  readonly cursorRevision: number;
  readonly definitionRevision: number;
  readonly runId: string;
}

/** A person's "don't show again" and resume state. */
export interface WalkthroughProgress {
  readonly consumedOnceKeys: ReadonlySet<string>;
  /** When each consumed key was consumed (ISO 8601), where that is known. */
  readonly consumedAt: ReadonlyMap<string, string>;
  readonly cursors: Readonly<Record<string, WalkthroughCursorState>>;
}

/** One record as it is read (value may arrive parsed or as JSON text). */
export interface WalkthroughRecord {
  readonly address: string;
  readonly value_json: unknown;
}

export const WALKTHROUGH_PROGRESS_KIND = 'walkthrough-progress';

// ── Read path: fold definition records ───────────────────────────────────────

function asObject(value: unknown): Record<string, unknown> | null {
  const obj = typeof value === 'string' ? safeJson(value) : value;
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * True iff `obj` has the minimal STRUCTURAL fields the engine needs. Presentation
 * fields are not checked: they are opaque and the registries tolerate anything.
 */
function isWalkthroughDefinition(obj: Record<string, unknown>): boolean {
  if (obj.kind !== 'walkthrough-definition') return false;
  if (typeof obj.id !== 'string') return false;
  if (typeof obj.entry_step !== 'string') return false;
  if (!Array.isArray(obj.steps)) return false;
  return obj.steps.every((s) => s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string');
}

type ParsedDef =
  | { readonly kind: 'def'; readonly id: string; readonly def: WalkthroughDefinition }
  | { readonly kind: 'tombstone'; readonly id: string }
  | null;

function parseDefinition(value: unknown): ParsedDef {
  const obj = asObject(value);
  if (!obj) return null;
  if (typeof obj.id !== 'string') return null;
  if (obj.status === 'deleted') return { kind: 'tombstone', id: obj.id };
  if (!isWalkthroughDefinition(obj)) return null;
  const def: WalkthroughDefinition = {
    ...(obj as unknown as WalkthroughDefinition),
    triggers: Array.isArray(obj.triggers) ? (obj.triggers as Trigger[]) : [],
  };
  return { kind: 'def', id: obj.id, def };
}

/**
 * Fold raw definition records into an id→definition map (id-sorted, deterministic).
 * Malformed records are skipped (blind tolerance); a later record at the same id wins.
 */
export function foldWalkthroughRecords(
  records: readonly WalkthroughRecord[],
): Record<string, WalkthroughDefinition> {
  const defs: Record<string, WalkthroughDefinition> = {};
  for (const rec of records) {
    const parsed = parseDefinition(rec.value_json);
    if (!parsed) continue;
    if (parsed.kind === 'tombstone') delete defs[parsed.id];
    else defs[parsed.id] = parsed.def;
  }
  const sorted: Record<string, WalkthroughDefinition> = {};
  for (const id of Object.keys(defs).sort()) sorted[id] = defs[id];
  return sorted;
}

// ── Read path: fold the progress record ──────────────────────────────────────

function integerOr(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? Number(value) : fallback;
}

/** Fold one saved cursor, or null when it names no step. */
export function readCursor(raw: unknown): WalkthroughCursorState | null {
  const cursor = asObject(raw);
  const currentStepId = typeof cursor?.current_step_id === 'string' ? cursor.current_step_id : null;
  if (!cursor || !currentStepId) return null;
  return {
    currentStepId,
    history: Array.isArray(cursor.history) ? cursor.history.filter((value): value is string => typeof value === 'string') : [],
    status: cursor.status === 'complete' ? 'complete' : 'active',
    cursorRevision: integerOr(cursor.cursor_revision, 0),
    definitionRevision: integerOr(cursor.definition_revision, 1),
    runId: typeof cursor.run_id === 'string' ? cursor.run_id : '',
  };
}

/**
 * Fold progress records into live state. Only rows tagged `kind: 'walkthrough-progress'`
 * count, so a foreign record carrying a `consumed_once_keys` field is ignored.
 */
export function foldWalkthroughProgress(records: readonly WalkthroughRecord[]): WalkthroughProgress {
  const consumed = new Set<string>();
  const consumedAt = new Map<string, string>();
  const cursors: Record<string, WalkthroughCursorState> = {};
  for (const rec of records) {
    const obj = asObject(rec.value_json);
    if (!obj || obj.kind !== WALKTHROUGH_PROGRESS_KIND) continue;
    if (Array.isArray(obj.consumed_once_keys)) {
      for (const key of obj.consumed_once_keys) if (typeof key === 'string') consumed.add(key);
    }
    for (const [key, at] of Object.entries(asObject(obj.consumed_at) ?? {})) {
      if (typeof at === 'string') consumedAt.set(key, at);
    }
    for (const [definitionId, raw] of Object.entries(asObject(obj.cursors) ?? {})) {
      const cursor = readCursor(raw);
      if (cursor) cursors[definitionId] = cursor;
    }
  }
  return { consumedOnceKeys: consumed, consumedAt, cursors };
}

// ── Host-facing intake: compose M7 across ALL definitions ────────────────────

/**
 * The facts one tour is decided over by the person's show rules (subject `tour`, src/workspace/show-rules.json): its
 * id and title, who started it, the `reason` of the trigger that would start it, its `urgency` (the definition's own,
 * else `urgencyWhenUnset`), and `hours_since_one_like_it`, the hours since a tour started for the same reason was last
 * closed or finished (null when none was). Nothing here decides; the rules do.
 */
export function tourFacts(
  defs: Readonly<Record<string, WalkthroughDefinition>>,
  definitionId: string,
  trigger: Trigger | null,
  consumedAt: ReadonlyMap<string, string>,
  { now, startedBy = 'itself', urgencyWhenUnset = null }: { readonly now: number; readonly startedBy?: string; readonly urgencyWhenUnset?: string | null },
): Record<string, unknown> {
  const definition = defs[definitionId];
  const reason = trigger?.reason ?? null;
  let last = -Infinity;
  if (reason) {
    for (const def of Object.values(defs)) {
      for (const one of def.triggers) {
        if (one.reason !== reason || !one.once_key) continue;
        const at = Date.parse(consumedAt.get(one.once_key) ?? '');
        if (at > last) last = at;
      }
    }
  }
  return {
    id: definitionId,
    title: definition?.title ?? '',
    started_by: startedBy,
    reason,
    urgency: (definition as { urgency?: unknown } | undefined)?.urgency ?? urgencyWhenUnset,
    hours_since_one_like_it: Number.isFinite(last) ? Math.max(0, (now - last) / 3_600_000) : null,
  };
}

/**
 * Scan every definition's triggers for the first one that should fire for `event`
 * (honoring consumed once_keys and each trigger's requirements) and that the person's rules
 * let show (`shows`, asked of every candidate, so a tour a rule holds never hides the next),
 * and return which definition it starts. Pure: the caller supplies the event, folded progress
 * and the rules' answer.
 *
 * A trigger whose `reason` is one of `catchUpReasons` (DATA) does not queue: of every tour
 * that would start for this event with a catch-up reason and that shows, the one ranked
 * highest (`rank`, the tour's urgency) starts, the newest of equals, and `alsoWaiting` names
 * every other catch-up tour waiting for this event, whether the rules let it show now or hold it:
 * the card says how many and opens their list (Waiting tours, which says what holds each), and
 * the person's show rules decide when the next one shows.
 */
export function selectWalkthroughForEvent(
  defs: Readonly<Record<string, WalkthroughDefinition>>,
  event: HostEvent,
  consumedOnceKeys: ReadonlySet<string> = new Set(),
  consumedAt: ReadonlyMap<string, string> = new Map(),
  catchUpReasons: ReadonlySet<string> = new Set(),
  { shows = () => true, rank = () => 0 }: {
    readonly shows?: (definitionId: string, trigger: Trigger) => boolean;
    readonly rank?: (definitionId: string) => number;
  } = {},
): { readonly definitionId: string; readonly trigger: Trigger; readonly alsoWaiting: readonly string[] } | null {
  const hits: { definitionId: string; trigger: Trigger }[] = [];
  const held: string[] = [];
  for (const id of Object.keys(defs)) {
    const trigger = selectTrigger(defs[id].triggers, event, consumedOnceKeys, consumedAt);
    if (!trigger) continue;
    if (!shows(id, trigger)) {
      if (catchUpReasons.has(trigger.reason ?? '')) held.push(id);
      continue;
    }
    if (!catchUpReasons.has(trigger.reason ?? '')) {
      if (hits.length === 0) return { definitionId: id, trigger, alsoWaiting: [] };
      continue;
    }
    hits.push({ definitionId: id, trigger });
  }
  if (!hits.length) return null;
  let chosen = hits[0];
  for (const hit of hits) if (rank(hit.definitionId) >= rank(chosen.definitionId)) chosen = hit;
  return { ...chosen, alsoWaiting: [...hits.filter((hit) => hit !== chosen).map((hit) => hit.definitionId), ...held] };
}
