// packages/revenue-ledger/read-data/revenue-types.ts
//
// Purpose: Canonical types for the config-driven revenue projection.
// Generic Physics — no customer-specific field names, no closed enums.
// Society data (which fields, which event kinds) lives in customer-config/.
//
// Non-Negotiable Invariants:
//   PaymentEvent is open: any field from any provider can appear.
//   RevenueProjectionConfig drives ALL field resolution — code names nothing.
//   RevenueView carries only numbers and open-keyed maps; labels are Society.
//   event_role_map is a plain Record (open) — unknown roles are ignored.

/** Self-describing signed payment event projected from the event log.
 *  Fields are open: the reducer reads only what config paths point to. */
export type PaymentEvent = {
  event_id: string;
  occurred_at: string;
  /** The event kind/role string matched against event_role_map in config. */
  event_kind: string;
  /** Raw fact attributes from the checkout event template. Open — any field
   *  may be present; the reducer reads via configured paths only. */
  attributes: Record<string, unknown>;
};

/** Tests whether a recurring subscription is currently active.
 *  The field at field_path is compared against active_values.
 *  Absent means ALL events with a non-zero recurring amount are active. */
export type ActivePredicate = {
  field_path: string[];
  active_values: string[];
};

/** Config row that drives the entire projection. This is Society DATA.
 *  One row per operator deployment. The generic reducer reads from these
 *  paths exclusively — no field name is hardcoded anywhere in code. */
export type RevenueProjectionConfig = {
  /** Path into PaymentEvent.attributes holding the charged amount (integer cents). */
  amount_field_path: string[];
  /** Path into PaymentEvent.attributes holding the ISO currency code. */
  currency_field_path: string[];
  /** Path into PaymentEvent.attributes holding the recurring amount (integer cents).
   *  Absent means the event contributes 0 to recurring totals. */
  recurring_field_path: string[];
  /** Optional predicate for recurring active status. */
  active_predicate?: ActivePredicate;
  /** Open map from event_kind to a role token:
   *   "add"      event amount is revenue
   *   "subtract" event amount is a refund or reversal
   *   "ignore"   event is tracked but not counted
   *  Any unknown string is treated as "ignore" (fail-safe extensibility). */
  event_role_map: Record<string, string>;
  /** Path into PaymentEvent.attributes for cohort grouping key.
   *  Absent means all events land in the "unknown" cohort bucket. */
  cohort_key_path?: string[];
};

/** Revenue view produced by the projection. All amounts in integer cents.
 *  Maps are open — keys come from event data, not from code. */
export type RevenueView = {
  gross_cents: number;
  refunds_cents: number;
  net_cents: number;
  recurring_active_cents: number;
  recurring_active_count: number;
  by_cohort: Record<string, CohortBucket>;
  by_event_role: Record<string, RoleBucket>;
  review: ReviewBucket;
};

export type ReviewBucket = {
  count: number;
  items: ReviewItem[];
};

export type ReviewItem = {
  event_id: string;
  reason: 'missing-amount' | 'negative-amount' | 'duplicate-event' | 'conflicting-amount';
  event_kind: string;
  amount_raw?: unknown;
};

export type CohortBucket = {
  gross_cents: number;
  net_cents: number;
  count: number;
};

export type RoleBucket = {
  total_cents: number;
  count: number;
};
