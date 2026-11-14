// packages/business-event/read-data/business-event-types.ts
//
// =============================================================================
// PURPOSE — the canonical business-event spine (B01.W02 event contract / W03 shape)
// =============================================================================
//
// ONE record shape carries every observable business moment — an ad view, a
// checkout, a coaching session, a refund, an owner approval, a content publish —
// with provenance and decision rights, so the business can OBSERVE -> DECIDE ->
// ACT -> PROVE -> LEARN instead of merely displaying disconnected reports. Every
// downstream control surface (attribution, retention, finance, cadence, audit)
// reads from this ONE spine; none invents its own event type.
//
// =============================================================================
// WHY THIS SHAPE (1000x gauntlet trace)
// =============================================================================
//
// L055 deepest root: the business is blind because each surface defines its own
//   ad-hoc event. The deepest fix is ONE generic, self-describing event record
//   that any surface emits and any surface reads — provenance + decision-right
//   included so a money/access event is never confused with a page view.
// L063 category / L069 generative primitive: acquisition, funnel, coaching,
//   retention, finance, support, and ops events are NOT seven schemas — they are
//   ONE record whose `kind`/`action` are OPEN DATA. Adding a new business moment
//   is a DATA row (a new `kind` label + a mapping rule), never a new type or a
//   new code branch. The same record runs a golf or basketball business by
//   swapping DATA only (the cross-domain check).
// Enum dissolution (Primitive guard, B01.W03): `kind`, `action`, every party
//   `kind`, `source.system`/`source.channel`, `decisionRight`, and the origin of
//   `provenance` are OPEN strings — no CRM stage, channel, offer, cohort,
//   provider, or finance label is ever a TypeScript union or a `switch`. Closed
//   sets here would be a Society-in-Physics leak (CLAUDE.md). The ONLY closed set
//   is `assurance` (signed | observed | derived | declared) — a Physics property
//   of HOW the event is known, not a business label.
// SSOT: the BusinessEvent record IS the source of truth for "what happened."
//   Read-models PURELY derive from a stream of these; they never re-define them.
// Machine-readable (CLAUDE.md): every field is an explicit named field. No
//   encoded strings (no "actor:student:42" packing) — `actor` is a structured
//   `EventParty`, parseable without string surgery.
// =============================================================================

/**
 * A self-describing reference to any participant in an event — the actor (who
 * acted) or the object (what was acted upon). `kind` is OPEN DATA (`student`,
 * `lead`, `offer`, `content-piece`, `channel`, `coach`, `payment`, a future
 * `sponsor` — anything). `id` is unique within its kind. The event spine NEVER
 * branches on `kind`; a surface that cares resolves it through DATA.
 */
export interface EventParty {
  readonly kind: string;
  readonly id: string;
  /** Human display label, when present — never used for logic. */
  readonly label?: string;
}

/**
 * Where the event came from (provenance of origin). All OPEN DATA: `system` is
 * the emitting package/process/provider, `channel` the medium. A new source is a
 * DATA value, never a code branch.
 */
export interface EventSource {
  /** The emitting system — package id, process id, provider, or owner action. */
  readonly system: string;
  /** Medium, when present (a publish channel, an ad network, a device) — DATA. */
  readonly channel?: string;
  /** External id from the source system, when present (a Stripe/webhook event id). */
  readonly externalId?: string;
}

/**
 * HOW we know the event is true. This is the ONLY closed set in the contract —
 * it is a Physics property of trust, not a business label:
 *   - `signed`   : carried by a verified signed-event (money/access/refund).
 *   - `observed` : directly captured from a real interaction (a page view).
 *   - `derived`  : computed/projected from other events (a cohort assignment).
 *   - `declared` : asserted by an owner/operator action (a manual correction).
 * Downstream finance/access logic MUST require `signed` for money/grant effects.
 */
export type EventAssurance = 'signed' | 'observed' | 'derived' | 'declared';

/** Provenance bundle — how the event is known and what authority stands behind it. */
export interface EventProvenance {
  readonly assurance: EventAssurance;
  /** For `signed` assurance: the signed-event id this business-event derives from. */
  readonly signedEventId?: string;
  /** Who/what holds authority over this event's truth — OPEN DATA (a principal id,
   *  an authority name). Lets the ledger answer "who can dispute/correct this?". */
  readonly decisionRight?: string;
}

/**
 * THE canonical business event. Every business moment is one of these. Fields are
 * the B01.W02 contract: actor, object, action, source, timestamp, provenance,
 * correlation id, decision-right (carried inside provenance).
 */
export interface BusinessEvent {
  /** Stable unique id for this event occurrence. */
  readonly id: string;
  /** OPEN business-moment category (`acquisition`, `funnel`, `coaching`,
   *  `retention`, `finance`, `ops`, …). DATA — never a union, never a switch. */
  readonly kind: string;
  /** OPEN verb describing what happened (`viewed`, `subscribed`, `refunded`,
   *  `completed-session`, `published`, `approved`). DATA. */
  readonly action: string;
  /** Who acted. */
  readonly actor: EventParty;
  /** What was acted upon (may be absent — some events have no distinct object). */
  readonly object?: EventParty;
  /** Where it came from (provenance of origin). */
  readonly source: EventSource;
  /** When it happened — ISO 8601 UTC. */
  readonly occurredAt: string;
  /** Ties events into a loop/journey (a session id, a checkout id, a run id). */
  readonly correlationId?: string;
  /** How we know it's true + decision-right. */
  readonly provenance: EventProvenance;
  /** Open self-describing payload — any extra DATA the emitter carries. The spine
   *  never reads specific keys; consumers project what they need via DATA. */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** A frozen, ordered stream of business events — the ledger's raw input. */
export type BusinessEventStream = readonly BusinessEvent[];
