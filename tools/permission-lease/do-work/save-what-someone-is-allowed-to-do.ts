/*
 * Save what someone is allowed to do, but only after checking you really allowed it.
 *
 * Plain version of the whole thing: a bot (the AI operator) can do things for you,
 * like click around a website, run a program, or use a login you saved. By default
 * it is blocked. To let it do one specific thing there has to be a saved "you are
 * allowed to do this" from you. This file saves that. The catch that makes it safe:
 * the bot cannot save its own "yes". Only a real yes from you counts, or the bot
 * could let itself do anything.
 *
 * The stored record and the reader are still spelled with the old word "lease" (the
 * stored `kind` is 'permission_lease', the reader is `isAllowed` in
 * run-a-job-on-your-stuff, and ai-action-guard reads it too). That spelling is a
 * live cross-package contract, so it changes only in the coordinated rename recorded
 * in the plan, never here alone. Everything this file owns uses plain words.
 *
 * Why it exists: `isAllowed` (run-a-job-on-your-stuff/do-work/decide-run-process.ts)
 * lets a guarded browser/program tool run only when a saved "allowed to" note names
 * the exact thing. Real users of that reader today: research-workspace runs guarded
 * web tools, tasks runs scheduled jobs, ai-tool-catalog runs programs. The only other
 * writer of such a note hardcodes one thing ('computer.actuate'), so every other
 * thing is refused by default and nothing can turn it on. This is the writer for the
 * rest.
 *
 * Both outside effects (confirm-you-allowed-it and the save/read) are handed in, so
 * the whole decision runs in a test with no engine.
 */

import { CONTROL_NOTE_KIND } from './exclusive-control-lease-core.ts';

/** What you allowed, as read back from the access-rule record. `authorized_action_refs`
 *  is that record's own field name (kept as-is because access-rule owns it). */
export interface WhatYouAllowed {
  authorized_action_refs: string[];
  decision_proof: string;
  /**
   * The bounds your yes put on everything OTHER than the list of things. Opaque
   * here: this owner reads `saved_field_bounds` and applies the comparison each
   * bound names, and never learns what a resource or a deadline is.
   *
   * It used to be dropped on the way through the adapter, which kept two of the
   * decision's fields and discarded the rest, so nothing downstream could check
   * a resource or a deadline even in principle.
   */
  constraints?: Record<string, unknown>;
}

/** Result of confirming, against durable engine truth, that you really allowed this. */
export interface AllowedConfirmation {
  verified: boolean;
  reason?: string;
  decision?: WhatYouAllowed;
}

/**
 * The confirm seam. The default dispatches to access-rule's `verify-decision` target
 * by name (blind Envelope), which reads your real yes from durable truth: saying yes
 * in a wrapper is never enough. Handed in during tests.
 */
export type ConfirmAllowed = (claim: {
  decision_proof: string;
  actor_ref: string;
  session_ref: string;
  subject_ref: string;
  action_ref?: string;
  revisions: Record<string, string>;
}) => Promise<AllowedConfirmation>;

/** Save seam: write one self-describing "allowed to" note into published-record. */
export type WriteAllowedNote = (addressLabel: string, payload: Record<string, unknown>) => Promise<void>;

/** Read seam: current "allowed to" notes for a note_ref (so we can read our own back). */
export type ReadAllowedNotes = (noteRef: string) => Promise<Record<string, unknown>[]>;

export interface AllowedToRequest {
  /**
   * What the note is called. Spelled `lease_ref` because that is the ONE name
   * the declared workflow input schema has ever used, and the one the stored
   * record uses.
   *
   * It was `note_ref` here, matching nothing: the declared action requires
   * `lease_ref` and forwards the caller's input unchanged, so every dispatch of
   * the shipped "Save permission" control threw `note_ref must be a non-empty
   * string` before it reached a single decision. A field name that exists only
   * inside one file and its own tests is not a plain-words rename in progress,
   * it is a second name for one thing, and the tests that used it were the only
   * callers that could pass.
   */
  lease_ref: string;
  subject_ref: string;
  holder: string;
  /** The things the caller asks to be allowed. Cut down to only what you allowed. */
  requested_operation_refs: string[];
  /** Your real yes for this, plus who/when it was said under. */
  decision_proof: string;
  actor_ref: string;
  session_ref: string;
  revisions: Record<string, string>;
  connector_ref?: string;
  credential_handle_ref?: string;
  service_connection_handle_ref?: string;
  expires_at?: string | null;
  /**
   * Optional refs-only context for the allowed operations. This is saved only
   * when the durable access decision binds the whole value exactly through
   * constraints.saved_field_bounds.bound_context { compare: 'same', value }.
   * The permission owner remains vocabulary-blind; consumers validate their
   * own context shape and must not treat this object as another permission.
   */
  bound_context?: Record<string, unknown>;
  idempotency_key: string;
}

export interface AllowedToReceipt {
  kind: 'saved-allowed-to-receipt';
  accepted: boolean;
  note_ref: string | null;
  subject_ref: string;
  holder: string;
  allowed_things: string[];
  /** Requested things you did NOT allow; never saved. Empty on a clean save. */
  refused_things: string[];
  saved: boolean;
  reason?: string;
}

const ALLOWED_NOTE_ADDRESS_PREFIX = 'package::permission-lease::allowed-to::';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function requiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  const out = value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') throw new TypeError(`${label} entries must be non-empty strings`);
    return entry.trim();
  });
  return [...new Set(out)];
}

function requiredRevisions(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new TypeError('revisions must be an object');
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string' || raw.trim() === '') throw new TypeError(`revisions.${key} must be a non-empty string`);
    out[key] = raw.trim();
  }
  if (Object.keys(out).length === 0) throw new TypeError('revisions must not be empty');
  return out;
}

/**
 * How to ask whether one saved value stays inside one bound the yes declared.
 *
 * A MAP RATHER THAN BRANCHES, so a new kind of bound is one row here and a
 * DATA row on the decision, and this file never learns the NAME of a field it
 * is checking. The saver knows which values it writes down; the decision knows
 * what it allows; neither has to know the other's vocabulary.
 */
const HOW_TO_COMPARE: Record<string, (saved: unknown, bound: unknown) => boolean> = {
  /** The saved value has to be the value your yes named. */
  same: (saved, bound) => JSON.stringify(saved ?? null) === JSON.stringify(bound ?? null),
  /**
   * A deadline. Later is BROADER, so a saved deadline may not pass the bound,
   * and no deadline at all is the broadest of them: a note that never expires
   * against a yes that does is exactly the widening this exists to catch.
   */
  'no-later-than': (saved, bound) => {
    if (bound === null || bound === undefined) return true;
    if (saved === null || saved === undefined) return false;
    const savedAt = Date.parse(String(saved));
    const boundAt = Date.parse(String(bound));
    if (Number.isNaN(savedAt) || Number.isNaN(boundAt)) return false;
    return savedAt <= boundAt;
  },
};

/**
 * Everything the saved note would say beyond the things you allowed, checked
 * against what your yes actually allows.
 *
 * WHY THIS EXISTS. The operation list was cut down to the intersection with
 * your yes, so what was saved could never be more than what you allowed. Every
 * OTHER field was copied straight out of the request and written down without
 * anyone comparing it to anything: the resource the note is about, when it
 * stops, which connection and which saved key it covers. A yes given for one
 * resource until Friday could be saved as a note about a different resource
 * that never expires, and the intersection above would still report that only
 * allowed things were saved. The narrow half was airtight and the wide half was
 * unguarded, which is worse than no guard, because the receipt says checked.
 *
 * Silence is not permission. A value the yes does not bound is refused rather
 * than allowed, so adding a savable field cannot quietly add an unbounded one.
 */
function widerThanTheYes(
  savedValues: Record<string, { value: unknown; grantsReach: boolean }>,
  constraints: unknown,
): { field: string; reason: string } | null {
  const declared = isRecord(constraints) && isRecord(constraints.saved_field_bounds)
    ? constraints.saved_field_bounds
    : {};
  for (const [field, { value, grantsReach }] of Object.entries(savedValues)) {
    const bound = declared[field];
    if (isRecord(bound) && typeof bound.compare === 'string') {
      // A DECLARED BOUND IS CHECKED EVEN WHEN THE VALUE IS MISSING, and this
      // is the case that is easy to skip and is the widest of them: saying
      // nothing about a deadline against a yes that had one is a note that
      // never stops. An absent value is a value.
      const compare = HOW_TO_COMPARE[bound.compare];
      if (!compare) return { field, reason: 'the-yes-asks-for-a-comparison-nobody-here-knows' };
      if (!compare(value, bound.value)) return { field, reason: 'wider-than-the-yes' };
      continue;
    }
    // No bound. A value that only describes the note can stand on its own; a
    // value that hands the holder further REACH cannot, because saving it
    // records authority the yes never mentioned. Which is which is a property
    // of the field, decided by whoever writes the note, and any field becomes
    // bounded the moment a grant declares a bound for it.
    if (grantsReach) return { field, reason: 'the-yes-does-not-say-what-this-may-be' };
  }
  return null;
}

/** The same set of things, whatever order the store handed them back in. */
function sameThings(stored: unknown, expected: string[]): boolean {
  if (!Array.isArray(stored) || stored.length !== expected.length) return false;
  const seen = new Set(stored.map((entry) => String(entry)));
  return expected.every((entry) => seen.has(entry));
}

function refused(
  parsed: { note_ref: string; subject_ref: string; holder: string },
  reason: string,
  allowed: string[] = [],
  refusedThings: string[] = [],
): AllowedToReceipt {
  return {
    kind: 'saved-allowed-to-receipt',
    accepted: false,
    note_ref: null,
    subject_ref: parsed.subject_ref,
    holder: parsed.holder,
    allowed_things: allowed,
    refused_things: refusedThings,
    saved: false,
    reason,
  };
}

/**
 * Save an "allowed to" note ONLY after confirming you really allowed it.
 *
 * The rule that makes the block real: every thing in the saved note is a thing you
 * allowed. If a requested thing is not one you allowed, it is refused (listed, never
 * saved). If your yes does not check out, nothing is saved at all (refuse by default).
 */
export async function saveWhatSomeoneIsAllowedToDo(
  input: unknown,
  seams: {
    confirmAllowed: ConfirmAllowed;
    writeAllowedNote: WriteAllowedNote;
    readAllowedNotes: ReadAllowedNotes;
  },
): Promise<AllowedToReceipt> {
  if (!isRecord(input)) throw new TypeError('"allowed to" request must be an object');
  const parsed = {
    // The one translation: the declared name in, the plain word inside.
    note_ref: requiredText(input.lease_ref, 'lease_ref'),
    subject_ref: requiredText(input.subject_ref, 'subject_ref'),
    holder: requiredText(input.holder, 'holder'),
    requested_operation_refs: requiredStringArray(input.requested_operation_refs, 'requested_operation_refs'),
    decision_proof: requiredText(input.decision_proof, 'decision_proof'),
    actor_ref: requiredText(input.actor_ref, 'actor_ref'),
    session_ref: requiredText(input.session_ref, 'session_ref'),
    revisions: requiredRevisions(input.revisions),
    // Required by the interface AND by the declared input schema, and never
    // parsed, so the saved note carried `idempotency_key: undefined` and a
    // retried save could not be told from a second grant.
    idempotency_key: requiredText(input.idempotency_key, 'idempotency_key'),
    connector_ref: typeof input.connector_ref === 'string' && input.connector_ref.trim() ? input.connector_ref.trim() : undefined,
    credential_handle_ref: typeof input.credential_handle_ref === 'string' && input.credential_handle_ref.trim() ? input.credential_handle_ref.trim() : undefined,
    service_connection_handle_ref: typeof input.service_connection_handle_ref === 'string' && input.service_connection_handle_ref.trim() ? input.service_connection_handle_ref.trim() : undefined,
    expires_at: input.expires_at === null ? null : (typeof input.expires_at === 'string' && input.expires_at.trim() ? input.expires_at.trim() : undefined),
    bound_context: input.bound_context === undefined ? undefined
      : isRecord(input.bound_context) ? structuredClone(input.bound_context)
        : (() => { throw new TypeError('bound_context must be an object'); })(),
  };

  // Never take a raw secret; a saved handle only.
  const unsafe = input as Record<string, unknown>;
  if (unsafe.credential_value !== undefined || unsafe.secret !== undefined || unsafe.token !== undefined || unsafe.password !== undefined) {
    return refused(parsed, 'saved-key-handle-required');
  }

  // Confirm you really allowed this, against durable truth, for THIS holder. The
  // subject your yes must name is the note holder, so a bot cannot take a yes you
  // gave someone else and save a note for itself.
  //
  // No action_ref is passed. This saver lists SEVERAL requested actions, and
  // asking against one of them made the verifier refuse the whole request when
  // the FIRST requested action was not authorized while accepting the same set
  // reordered. The decision is looked up by proof, the full authorized list
  // comes back, and the filter below is what decides what saves. Ordering the
  // caller writes their list in no longer changes the outcome.
  const confirmation = await seams.confirmAllowed({
    decision_proof: parsed.decision_proof,
    actor_ref: parsed.actor_ref,
    session_ref: parsed.session_ref,
    subject_ref: parsed.holder,
    revisions: parsed.revisions,
  });
  if (!confirmation.verified || !confirmation.decision) {
    return refused(parsed, confirmation.reason ?? 'not-allowed');
  }

  // Cut down. Save ONLY things you allowed. What is saved is inside what you allowed
  // by construction, so asking for more can never save more.
  const allowedSet = new Set(confirmation.decision.authorized_action_refs);
  const allowed = parsed.requested_operation_refs.filter((ref) => allowedSet.has(ref));
  const refusedThings = parsed.requested_operation_refs.filter((ref) => !allowedSet.has(ref));
  if (allowed.length === 0) {
    return refused(parsed, 'none-of-it-was-allowed', [], refusedThings);
  }

  // Everything the note would say beyond the things you allowed, checked
  // against what the yes actually bounds. This is the whole of A11: the
  // narrow half of the save was airtight and the wide half was copied
  // through unread.
  const savedBeyondTheThings: Record<string, { value: unknown; grantsReach: boolean }> = {
    // What the note is about. It describes the note rather than extending it,
    // and a grant that wants it pinned says so with a bound.
    subject_ref: { value: parsed.subject_ref, grantsReach: false },
    // A deadline, and the test is WIDER THAN THE YES rather than UNBOUNDED. A
    // note that never stops is only too wide when the yes stopped; against a
    // yes that said nothing about time it is exactly as wide. The moment a
    // grant declares a deadline, `no-later-than` refuses both a later one and
    // an absent one, which is the whole of the check without this field ever
    // needing to be reach-granting on its own.
    expires_at: { value: parsed.expires_at, grantsReach: false },
    // Each of these points the note at something else the holder may then
    // touch, which is reach by definition and never assumed.
    connector_ref: { value: parsed.connector_ref, grantsReach: parsed.connector_ref !== undefined },
    credential_handle_ref: {
      value: parsed.credential_handle_ref,
      grantsReach: parsed.credential_handle_ref !== undefined,
    },
    service_connection_handle_ref: {
      value: parsed.service_connection_handle_ref,
      grantsReach: parsed.service_connection_handle_ref !== undefined,
    },
    // Context can name additional records a holder may read or act on, so it
    // is always reach-granting and must be exactly bounded by the durable yes.
    bound_context: {
      value: parsed.bound_context,
      grantsReach: parsed.bound_context !== undefined,
    },
  };
  const tooWide = widerThanTheYes(savedBeyondTheThings, confirmation.decision.constraints);
  if (tooWide) {
    return refused(parsed, `${tooWide.reason}: ${tooWide.field}`, [], refusedThings);
  }

  const payload: Record<string, unknown> = {
    // The saved kind stays 'permission_lease' (the frozen cross-package contract
    // isAllowed and ai-action-guard read). Its field `lease_ref` and `allowed_operation_refs`
    // are that same record shape. The rename to plain words happens in the coordinated
    // migration, never here alone.
    kind: CONTROL_NOTE_KIND,
    lease_ref: parsed.note_ref,
    subject_ref: parsed.subject_ref,
    holder: parsed.holder,
    allowed_operation_refs: allowed,
    allowed_actions: [],
    revoked: false,
    idempotency_key: parsed.idempotency_key,
    allowed_by_decision_proof: confirmation.decision.decision_proof,
    ...(parsed.connector_ref ? { connector_ref: parsed.connector_ref } : {}),
    ...(parsed.credential_handle_ref ? { credential_handle_ref: parsed.credential_handle_ref } : {}),
    ...(parsed.service_connection_handle_ref ? { service_connection_handle_ref: parsed.service_connection_handle_ref } : {}),
    ...(parsed.expires_at !== undefined ? { expires_at: parsed.expires_at } : {}),
    ...(parsed.bound_context !== undefined ? { bound_context: parsed.bound_context } : {}),
  };

  // WHAT IS ALREADY HERE UNDER THIS NAME, before writing over it.
  //
  // The key was parsed, stored, and never used, so a retry and a second grant
  // were the same act: the second write replaced the first and the readback
  // then confirmed the thing that had just overwritten it. Three answers, and
  // only one of them is a write:
  //
  //   the same request again  -> already done, say so, write nothing
  //   the same key, different -> two different grants wearing one name, refuse
  //   revoked                 -> a retry cannot switch a note back on
  const alreadyHere = (await seams.readAllowedNotes(parsed.note_ref)).find(
    (record) => isRecord(record) && record.lease_ref === parsed.note_ref,
  );
  if (isRecord(alreadyHere)) {
    if (alreadyHere.revoked === true) {
      return refused(parsed, 'this-was-revoked-and-needs-a-new-yes', [], refusedThings);
    }
    if (alreadyHere.idempotency_key === parsed.idempotency_key) {
      const sameRequest = Object.entries(payload).every(
        ([field, value]) => JSON.stringify(alreadyHere[field] ?? null) === JSON.stringify(value ?? null),
      );
      if (!sameRequest) {
        return refused(parsed, 'same-key-different-request', [], refusedThings);
      }
      // Exact retry. The work is done and doing it again changes nothing, so
      // this reports what is there rather than writing it a second time.
      return {
        kind: 'saved-allowed-to-receipt',
        accepted: true,
        note_ref: parsed.note_ref,
        subject_ref: parsed.subject_ref,
        holder: parsed.holder,
        allowed_things: allowed,
        refused_things: refusedThings,
        saved: true,
      };
    }
    // A different key at the same name is a different grant, and letting it
    // land would silently replace one someone is relying on.
    return refused(parsed, 'this-name-already-holds-a-different-grant', [], refusedThings);
  }

  await seams.writeAllowedNote(`${ALLOWED_NOTE_ADDRESS_PREFIX}${encodeURIComponent(parsed.note_ref)}`, payload);

  // Read our own note back: OUR note, not a note. It used to match on the name,
  // the kind and not-revoked, so an older grant to a DIFFERENT holder, or one
  // allowing different things, confirmed this save. A readback that can be
  // satisfied by somebody else's row is not a readback, it is a name lookup
  // wearing one, and it reports saved for a save that never landed.
  const readback = await seams.readAllowedNotes(parsed.note_ref);
  const written = readback.find((record) => isRecord(record)
    && record.lease_ref === parsed.note_ref
    && (record.kind === undefined || record.kind === CONTROL_NOTE_KIND)
    && record.revoked !== true
    && record.holder === parsed.holder
    && record.subject_ref === parsed.subject_ref
    && record.idempotency_key === parsed.idempotency_key
    && record.allowed_by_decision_proof === confirmation.decision.decision_proof
    && sameThings(record.allowed_operation_refs, allowed)
    && record.expires_at === payload.expires_at
    && record.credential_handle_ref === payload.credential_handle_ref
    && record.service_connection_handle_ref === payload.service_connection_handle_ref
    && record.connector_ref === payload.connector_ref
    && JSON.stringify(record.bound_context ?? null) === JSON.stringify(payload.bound_context ?? null));
  if (!written) {
    throw new Error('"allowed to" note save could not be confirmed by reading it back');
  }

  return {
    kind: 'saved-allowed-to-receipt',
    accepted: true,
    note_ref: parsed.note_ref,
    subject_ref: parsed.subject_ref,
    holder: parsed.holder,
    allowed_things: allowed,
    refused_things: refusedThings,
    saved: true,
  };
}
