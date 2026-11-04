// packages/guided-overlay/engine/trigger-intake.ts
//
// PURPOSE
// The trigger intake (engine mechanism M7). A walkthrough declares `triggers[]`,
// each binding a host event to a start. This module decides, for a given host
// event, which trigger (if any) should fire — honoring authored suppression-key
// DATA. It NEVER enumerates `reason`: the reason is opaque DATA carried through;
// only the event match + suppression gate are Physics. New trigger reasons need zero
// engine change.
//
// Pure: no I/O, no clock. The caller supplies the event and the set of already-
// consumed suppression keys (read from persisted scoped-run state).

/** A trigger's binding to a host-emitted event. */
export interface TriggerOnEvent {
  readonly event_kind: string;
  /** Subset of event fields that must match (equality). Absent = match any of this kind. */
  readonly match?: Readonly<Record<string, unknown>>;
  /** Array-valued event fields that must include every listed value. */
  readonly match_all?: Readonly<Record<string, readonly unknown[]>>;
}

/** A trigger as it appears in walkthrough DATA. */
export interface Trigger {
  readonly reason: string; // opaque DATA — never enumerated
  readonly on_event: TriggerOnEvent;
  /** Authored suppression-key DATA — the engine never interprets its contents. */
  readonly once_key?: string;
  /** Event fields that scope suppression without engine-owned domain names. */
  readonly once_key_fields?: readonly string[];
  /** Generic events that consume this trigger's suppression key without starting its tour. */
  readonly consume_on?: readonly TriggerOnEvent[];
  /**
   * Suppression keys that must already be consumed for this trigger to fire, each
   * optionally only when it was consumed before an instant (ISO 8601). A tour that
   * points at what changed since someone took an earlier tour names that tour's key
   * and the moment the change shipped; someone who took it later already saw it.
   */
  readonly requires?: readonly TriggerRequirement[];
  /** The step this trigger starts the tour at (an id in its steps); absent starts at `entry_step`. */
  readonly start_step?: string;
  /** True starts the tour in place of any tour already showing, as a tour asked for by name does. */
  readonly takes_over?: boolean;
}

/** One suppression key a trigger waits for, as authored DATA. */
export interface TriggerRequirement {
  readonly once_key: string;
  readonly consumed_before?: string;
}

/** A host-emitted event: a kind + arbitrary self-describing fields. */
export interface HostEvent {
  readonly event_kind: string;
  readonly [field: string]: unknown;
}

/** True iff `event` is the kind the trigger binds to AND all `match` fields equal. */
export function eventMatchesTrigger(trigger: Trigger, event: HostEvent): boolean {
  if (trigger.on_event.event_kind !== event.event_kind) return false;
  const match = trigger.on_event.match;
  for (const [key, expected] of Object.entries(match ?? {})) {
    if (event[key] !== expected) return false;
  }
  for (const [key, expected] of Object.entries(trigger.on_event.match_all ?? {})) {
    const actual = event[key];
    if (!Array.isArray(actual) || !expected.every(value => actual.includes(value))) return false;
  }
  return true;
}

/**
 * Whether this trigger should fire for this event now: the event matches AND its
 * authored suppression key is not consumed. Triggers without suppression DATA
 * may fire every time their event occurs.
 */
export function shouldFireTrigger(
  trigger: Trigger,
  event: HostEvent,
  consumedSuppressionKeys: ReadonlySet<string>,
  consumedAt: ReadonlyMap<string, string> = new Map(),
): boolean {
  if (!eventMatchesTrigger(trigger, event)) return false;
  const suppressionKey = suppressionKeyForEvent(trigger, event);
  if (suppressionKey !== null && consumedSuppressionKeys.has(suppressionKey)) return false;
  return requirementsMet(trigger, consumedSuppressionKeys, consumedAt);
}

/**
 * Every required key is consumed and, where the requirement names an instant, was
 * consumed before it. A key consumed at an unknown time never satisfies a dated
 * requirement: the engine does not guess when something happened.
 */
export function requirementsMet(
  trigger: Trigger,
  consumedSuppressionKeys: ReadonlySet<string>,
  consumedAt: ReadonlyMap<string, string> = new Map(),
): boolean {
  for (const requirement of trigger.requires ?? []) {
    if (!consumedSuppressionKeys.has(requirement.once_key)) return false;
    if (requirement.consumed_before === undefined) continue;
    const before = Date.parse(requirement.consumed_before);
    const at = Date.parse(consumedAt.get(requirement.once_key) ?? '');
    if (!Number.isFinite(before) || !Number.isFinite(at) || at >= before) return false;
  }
  return true;
}

/** Materialize authored suppression DATA with opaque event fields declared by DATA. */
export function suppressionKeyForEvent(trigger: Trigger, event: HostEvent): string | null {
  if (trigger.once_key === undefined) return null;
  const fields = trigger.once_key_fields?.filter((field) => field.trim().length > 0) ?? [];
  if (fields.length === 0) return trigger.once_key;
  const scope = fields.map((field) => {
    const value = event[field];
    const encoded = value === undefined || value === null
      ? '__missing__'
      : encodeURIComponent(typeof value === 'string' ? value : JSON.stringify(value));
    return `${encodeURIComponent(field)}=${encoded}`;
  });
  return `${trigger.once_key}::${scope.join('::')}`;
}

/**
 * Select the FIRST trigger in declaration order that should fire for `event`.
 * Returns null when none match (or all are consumed). Declaration order is the
 * tie-break — authors order triggers by priority in DATA.
 */
export function selectTrigger(
  triggers: readonly Trigger[],
  event: HostEvent,
  consumedSuppressionKeys: ReadonlySet<string> = new Set(),
  consumedAt: ReadonlyMap<string, string> = new Map(),
): Trigger | null {
  const selected = triggers.find((t) => shouldFireTrigger(t, event, consumedSuppressionKeys, consumedAt));
  if (!selected) return null;
  const suppressionKey = suppressionKeyForEvent(selected, event);
  return suppressionKey === selected.once_key ? selected : { ...selected, once_key: suppressionKey ?? undefined };
}

/**
 * Build the event a generic Start or Replay control can emit for one definition.
 * Prefer repeatable, walkthrough-specific bindings, then progressively broader
 * bindings. Match fields remain opaque DATA and are copied into the event.
 */
export function startEventForWalkthrough(
  triggers: readonly Trigger[],
  walkthroughId: string,
): HostEvent | null {
  const ranked = triggers
    .map((trigger, index) => {
      const match = trigger.on_event.match ?? {};
      const boundId = match.walkthrough_id;
      if (boundId !== undefined && boundId !== walkthroughId) return null;
      return {
        trigger,
        index,
        rank: (trigger.once_key === undefined ? 0 : 2) + (boundId === walkthroughId ? 0 : 1),
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
  const selected = ranked[0]?.trigger;
  if (!selected) return null;
  return {
    event_kind: selected.on_event.event_kind,
    ...selected.on_event.match,
    walkthrough_id: walkthroughId,
  };
}
