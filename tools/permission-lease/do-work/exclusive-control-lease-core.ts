/*
 * Pure cores for the one-controller takeover. This leaf has ZERO imports (no
 * engine, no browser, no store, no read-data surface, no package contract JSON),
 * so it bundles into a node-platform target handler without dragging the
 * package's UI read-data or its full things-to-store-and-run.json.
 *
 * The takeover is one saved-note variant carrying a self-describing `lease_class`
 * and `holder` (L090: never a closed enum branch in code, always a DATA value read
 * off the record). At most one party may be in control of one scope at a time; a
 * human TAKE saves a note that they are now in control; a human RELEASE writes a
 * durable hand-back; and "refuse while a party other than the actuator holds it"
 * is the gate the actuator reads before every actuate. Both the record/check wiring
 * (exclusive-control-lease.ts) and the live target handlers
 * (exclusive-control-lease-targets.ts) reuse these cores verbatim, so the contract
 * is defined once (SSOT) and unit-tests with no engine.
 *
 * Wire values kept as-is on purpose (a coordinated cross-package rename, tracked in
 * the plan rename-the-lease-jargon-to-plain-words): the saved `kind` stays
 * 'permission_lease' / 'permission_lease_check' / 'permission_lease_revocation',
 * and the record fields stay `lease_ref` / `lease_class`, because `isAllowed`
 * (run-a-job-on-your-stuff) and ai-action-guard read those exact strings today.
 * Only the TypeScript-facing names (types, functions, classes, constants) are
 * plain here; the file name is deferred with the wire layer since renaming it
 * moves the manifest `source_path` and needs a rebuild.
 */

export const ONLY_ONE_CONTROLS_RULE = 'exclusive-control';
export const CONTROL_NOTE_KIND = 'permission_lease';
export const CONTROL_CHECK_KIND = 'permission_lease_check';
export const CONTROL_HANDBACK_KIND = 'permission_lease_revocation';
/** The actuator's own role. The bot is in control by default; a DATA value, overridable. */
export const DEFAULT_ACTUATOR_HOLDER = 'bot';

/** Self-describing DATA. 'bot' | 'human' | any future party. Never a closed union. */
export type Holder = 'bot' | 'human' | string;

export interface ControlNote {
  kind: typeof CONTROL_NOTE_KIND;
  lease_ref: string;
  lease_class: typeof ONLY_ONE_CONTROLS_RULE;
  scope_ref: string;
  holder: Holder;
  holder_subject_ref?: string;
  since?: string;
  reason?: string;
  expires_at?: string | null;
  revoked?: boolean;
}

export interface ControlCheck {
  kind: typeof CONTROL_CHECK_KIND;
  allowed: boolean;
  scope_ref: string;
  blocked_reason_ref?: string;
  holder?: Holder;
  holder_subject_ref?: string;
  lease_ref?: string;
}

export interface GrantControlInput {
  leaseRef: string;
  scopeRef: string;
  holder: Holder;
  holderSubjectRef?: string;
  reason?: string;
  since?: string;
  expiresAt?: string | null;
}

export interface ControlCheckOptions {
  scopeRef: string;
  actuatorHolder?: Holder;
  /**
   * Required. An optional clock here would need a default, and the only default
   * available to a pure core is the machine clock, which is the reach this
   * boundary exists to keep out. The caller answers what time it is.
   */
  now: Date;
  highWaterMark?: Date;
}

export interface GrantControlOptions {
  now: Date;
  highWaterMark?: Date;
}

/** Thrown when a second party asks to control a scope someone is already controlling. */
export class AlreadyInControlError extends Error {
  readonly scopeRef: string;
  readonly heldBy: Holder;
  readonly heldLeaseRef: string;
  constructor(scopeRef: string, heldBy: Holder, heldLeaseRef: string) {
    super(`computer ${scopeRef} is already controlled by ${heldBy}; only one party may control it at a time`);
    this.name = 'AlreadyInControlError';
    this.scopeRef = scopeRef;
    this.heldBy = heldBy;
    this.heldLeaseRef = heldLeaseRef;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function thingsFrom(records: unknown): Record<string, unknown>[] {
  const list = Array.isArray(records)
    ? records
    : isRecord(records) && Array.isArray((records as { things?: unknown }).things)
      ? (records as { things: unknown[] }).things
      : [];
  return list.filter(isRecord) as Record<string, unknown>[];
}

/* =============================================================================
 * PURE: clock. SP3 high-water mark. A passed expiry stays passed: a rolled-back
 * system clock cannot resurrect an expired hold, because the effective clock is
 * MAX(system clock, persisted high-water mark).
 * ========================================================================== */
export function effectiveNow(now: Date, highWaterMark?: Date): Date {
  if (highWaterMark && highWaterMark.getTime() > now.getTime()) return highWaterMark;
  return now;
}

function isExpired(expiresAt: string | null | undefined, effNow: Date): boolean {
  if (!expiresAt) return false;
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time <= effNow.getTime();
}

/** A hold is current iff it is a control note on this scope, not handed back, not expired. */
export function isCurrentlyInControl(note: ControlNote, scopeRef: string, effNow: Date): boolean {
  return note.kind === CONTROL_NOTE_KIND
    && note.lease_class === ONLY_ONE_CONTROLS_RULE
    && note.scope_ref === scopeRef
    && note.revoked !== true
    && !isExpired(note.expires_at, effNow);
}

/* =============================================================================
 * PURE: decode. Read the control notes out of a record set and apply durable
 * hand-backs. A `permission_lease_revocation` record naming a lease_ref, or a
 * note payload with `revoked: true`, marks that note released (hand-back).
 * ========================================================================== */
export function decodeControlNotes(records: unknown): ControlNote[] {
  const things = thingsFrom(records);
  const handedBack = new Set<string>();
  for (const thing of things) {
    if (thing.remove) continue;
    const payload = isRecord(thing.payload) ? thing.payload : thing;
    if (payload.kind !== CONTROL_HANDBACK_KIND) continue;
    const leaseRef = asString(payload.lease_ref);
    if (leaseRef) handedBack.add(leaseRef);
  }
  return things.flatMap((thing) => {
    if (thing.remove) return [];
    const payload = isRecord(thing.payload) ? thing.payload : thing;
    if (payload.kind !== CONTROL_NOTE_KIND || payload.lease_class !== ONLY_ONE_CONTROLS_RULE) return [];
    const leaseRef = asString(payload.lease_ref);
    const scopeRef = asString(payload.scope_ref);
    const holder = asString(payload.holder);
    if (!leaseRef || !scopeRef || !holder) return [];
    return [{
      kind: CONTROL_NOTE_KIND,
      lease_ref: leaseRef,
      lease_class: ONLY_ONE_CONTROLS_RULE,
      scope_ref: scopeRef,
      holder,
      ...(asString(payload.holder_subject_ref) ? { holder_subject_ref: asString(payload.holder_subject_ref) } : {}),
      ...(asString(payload.since) ? { since: asString(payload.since) } : {}),
      ...(asString(payload.reason) ? { reason: asString(payload.reason) } : {}),
      ...(payload.expires_at !== undefined ? { expires_at: asString(payload.expires_at) ?? null } : {}),
      revoked: payload.revoked === true || handedBack.has(leaseRef),
    } as ControlNote];
  });
}

/* =============================================================================
 * PURE CORE 1: the gate. Before ANY actuate the actuator asks this. Refused iff a
 * party OTHER than the actuator is currently driving the scope. The blocked
 * reason is DERIVED from the holder DATA value (holder='human' yields
 * 'blocked:human-holds-control'), never a hardcoded 'human' branch. A different
 * scope's note does not match and does not gate this scope.
 * ========================================================================== */
export function checkControl(
  notes: ControlNote[],
  options: ControlCheckOptions,
): ControlCheck {
  const actuatorHolder = options.actuatorHolder ?? DEFAULT_ACTUATOR_HOLDER;
  const effNow = effectiveNow(options.now, options.highWaterMark);
  const hold = notes.find((note) =>
    isCurrentlyInControl(note, options.scopeRef, effNow) && note.holder !== actuatorHolder);
  if (hold) {
    return {
      kind: CONTROL_CHECK_KIND,
      allowed: false,
      scope_ref: options.scopeRef,
      blocked_reason_ref: `blocked:${hold.holder}-holds-control`,
      holder: hold.holder,
      ...(hold.holder_subject_ref ? { holder_subject_ref: hold.holder_subject_ref } : {}),
      lease_ref: hold.lease_ref,
    };
  }
  return { kind: CONTROL_CHECK_KIND, allowed: true, scope_ref: options.scopeRef };
}

/* =============================================================================
 * PURE CORE 2: only one controller. At most one party may control one scope at a
 * time. Granting a second one (any holder) while one is current is refused; two
 * bots, or a bot and a human, cannot both control a scope. Renewing the same lease_ref is not
 * a conflict. Returns the note to write on success.
 * ========================================================================== */
export function assertNobodyElseIsInControl(
  existingNotes: ControlNote[],
  input: GrantControlInput,
  options: GrantControlOptions = {},
): ControlNote {
  const leaseRef = requiredText(input.leaseRef, 'leaseRef');
  const scopeRef = requiredText(input.scopeRef, 'scopeRef');
  const holder = requiredText(input.holder, 'holder');
  const effNow = effectiveNow(options.now, options.highWaterMark);
  const conflict = existingNotes.find((note) =>
    isCurrentlyInControl(note, scopeRef, effNow) && note.lease_ref !== leaseRef);
  if (conflict) throw new AlreadyInControlError(scopeRef, conflict.holder, conflict.lease_ref);
  return {
    kind: CONTROL_NOTE_KIND,
    lease_ref: leaseRef,
    lease_class: ONLY_ONE_CONTROLS_RULE,
    scope_ref: scopeRef,
    holder,
    ...(input.holderSubjectRef ? { holder_subject_ref: input.holderSubjectRef } : {}),
    ...(input.since ? { since: input.since } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}),
    revoked: false,
  };
}

/** Build the durable hand-back record. A hand-back of the held note releases the wheel. */
export function buildControlHandBack(
  leaseRef: string,
  detail: { subjectRef?: string; reason?: string; revokedAt?: string } = {},
): Record<string, unknown> {
  return {
    kind: CONTROL_HANDBACK_KIND,
    lease_ref: requiredText(leaseRef, 'leaseRef'),
    ...(detail.subjectRef ? { subject_ref: detail.subjectRef } : {}),
    ...(detail.reason ? { reason: detail.reason } : {}),
    ...(detail.revokedAt ? { revoked_at: detail.revokedAt } : {}),
  };
}

/* =============================================================================
 * WithDeps orchestrators. Read the current control notes through an injected
 * reader, run the pure core, write through an injected writer. Every side effect
 * is injected, so these unit-test with no engine (see the test file). Mirrors
 * govern-computer-action's governComputerActionWithDeps.
 * ========================================================================== */
export interface ControlCheckDeps {
  readControlNotes: (scopeRef: string) => Promise<unknown>;
  /** Required: the clock is an injected dependency here, never a machine read. */
  now: () => Date;
  highWaterMark?: () => Date | undefined;
}

export async function checkControlWithDeps(
  options: Omit<ControlCheckOptions, 'now'> & { now?: Date },
  deps: ControlCheckDeps,
): Promise<ControlCheck> {
  const records = await deps.readControlNotes(options.scopeRef);
  const notes = decodeControlNotes(records);
  return checkControl(notes, {
    ...options,
    now: options.now ?? deps.now(),
    highWaterMark: options.highWaterMark ?? deps.highWaterMark?.(),
  });
}

export interface GrantControlDeps {
  readControlNotes: (scopeRef: string) => Promise<unknown>;
  writeControlNote: (note: ControlNote) => Promise<void>;
  /** Required: the clock is an injected dependency here, never a machine read. */
  now: () => Date;
  highWaterMark?: () => Date | undefined;
}

export async function recordControlWithDeps(
  input: GrantControlInput,
  deps: GrantControlDeps,
): Promise<ControlNote> {
  const records = await deps.readControlNotes(input.scopeRef);
  const existing = decodeControlNotes(records);
  const note = assertNobodyElseIsInControl(existing, input, {
    now: deps.now(),
    highWaterMark: deps.highWaterMark?.(),
  });
  await deps.writeControlNote(note);
  return note;
}
