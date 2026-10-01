// packages/revenue-ledger/read-data/project-revenue.ts
//
// Purpose: Pure, config-driven reducer over an open stream of payment events.
// Generic Physics — reads field paths from config, never names them in code.
// Society (which fields, which roles, what is a "cohort") lives in the config.
//
// Non-Negotiable Invariants:
//   No hardcoded field names (amount_cents, subscription_status, offer_id, etc).
//   No switch/if on event_kind — role lookup is a plain map read.
//   Unknown role in event_role_map => "ignore" (fail-safe).
//   Empty config or empty events => honest-zero RevenueView (Stonehenge test).
//   All arithmetic in integer cents (number) — no floating-point money math.

import type {
  ActivePredicate,
  CohortBucket,
  PaymentEvent,
  RevenueProjectionConfig,
  RevenueView,
  RoleBucket,
} from './revenue-types.ts';

// ---------------------------------------------------------------------------
// Path helpers — generic traversal over unknown attribute bags
// ---------------------------------------------------------------------------

function getPath(obj: unknown, path: string[]): unknown {
  let cursor: unknown = obj;
  for (const key of path) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function amountFactAt(obj: unknown, path: string[]): { raw: unknown; amount?: number } {
  const raw = getPath(obj, path);
  if (raw === null || raw === undefined || raw === '') return { raw };
  const n = Number(raw);
  return Number.isFinite(n) ? { raw, amount: Math.floor(n) } : { raw };
}

function centsAt(obj: unknown, path: string[]): number {
  return amountFactAt(obj, path).amount ?? 0;
}

function stringAt(obj: unknown, path: string[]): string {
  const raw = getPath(obj, path);
  return raw !== null && raw !== undefined ? String(raw) : '';
}

// ---------------------------------------------------------------------------
// Active-predicate evaluation
// ---------------------------------------------------------------------------

function isActive(attributes: Record<string, unknown>, predicate: ActivePredicate | undefined): boolean {
  if (!predicate) return true;
  const value = stringAt(attributes, predicate.field_path);
  return predicate.active_values.includes(value);
}

// ---------------------------------------------------------------------------
// Bucket helpers
// ---------------------------------------------------------------------------

function emptyView(): RevenueView {
  return {
    gross_cents: 0,
    refunds_cents: 0,
    net_cents: 0,
    recurring_active_cents: 0,
    recurring_active_count: 0,
    by_cohort: {},
    by_event_role: {},
    review: { count: 0, items: [] },
  };
}

function ensureCohort(view: RevenueView, key: string): CohortBucket {
  if (!view.by_cohort[key]) {
    view.by_cohort[key] = { gross_cents: 0, net_cents: 0, count: 0 };
  }
  return view.by_cohort[key];
}

function ensureRoleBucket(view: RevenueView, role: string): RoleBucket {
  if (!view.by_event_role[role]) {
    view.by_event_role[role] = { total_cents: 0, count: 0 };
  }
  return view.by_event_role[role];
}

// ---------------------------------------------------------------------------
// Main projection
// ---------------------------------------------------------------------------

/** Pure reducer: projects payment events into a RevenueView using config.
 *
 *  Generic contract:
 *    - Events and config may come from any provider.
 *    - Zero events or missing config fields produce honest-zero output.
 *    - No code change required to support new providers, new event kinds,
 *      different field names, or additional cohort groupings — edit config DATA.
 */
export function projectRevenue(
  events: PaymentEvent[],
  config: RevenueProjectionConfig,
): RevenueView {
  const view = emptyView();
  const seenEventAmounts = new Map<string, number>();

  for (const event of events) {
    const role = config.event_role_map[event.event_kind] ?? 'ignore';
    const amountFact = amountFactAt(event.attributes, config.amount_field_path);
    const amount = amountFact.amount ?? 0;
    const cohortKey = config.cohort_key_path
      ? (stringAt(event.attributes, config.cohort_key_path) || 'unknown')
      : 'unknown';

    // Role bucket (open — any role string is valid)
    const roleBucket = ensureRoleBucket(view, role);
    roleBucket.count += 1;

    // Cohort bucket
    const cohort = ensureCohort(view, cohortKey);
    cohort.count += 1;

    if (role === 'add') {
      if (amountFact.amount === undefined) {
        view.review.items.push({
          event_id: event.event_id,
          reason: 'missing-amount',
          event_kind: event.event_kind,
          amount_raw: amountFact.raw,
        });
        continue;
      }
      if (amount < 0) {
        view.review.items.push({
          event_id: event.event_id,
          reason: 'negative-amount',
          event_kind: event.event_kind,
          amount_raw: amountFact.raw,
        });
        continue;
      }
      if (seenEventAmounts.has(event.event_id)) {
        const seenAmount = seenEventAmounts.get(event.event_id);
        view.review.items.push({
          event_id: event.event_id,
          reason: seenAmount === amount ? 'duplicate-event' : 'conflicting-amount',
          event_kind: event.event_kind,
          amount_raw: amountFact.raw,
        });
        continue;
      }
      seenEventAmounts.set(event.event_id, amount);
      roleBucket.total_cents += amount;
      view.gross_cents += amount;
      cohort.gross_cents += amount;
      cohort.net_cents += amount;

      // Recurring: read the configured recurring path; apply active predicate
      const recurringAmount = centsAt(event.attributes, config.recurring_field_path);
      if (recurringAmount > 0 && isActive(event.attributes, config.active_predicate)) {
        view.recurring_active_cents += recurringAmount;
        view.recurring_active_count += 1;
      }
    } else if (role === 'subtract') {
      if (amountFact.amount === undefined) {
        view.review.items.push({
          event_id: event.event_id,
          reason: 'missing-amount',
          event_kind: event.event_kind,
          amount_raw: amountFact.raw,
        });
        continue;
      }
      if (amount < 0) {
        view.review.items.push({
          event_id: event.event_id,
          reason: 'negative-amount',
          event_kind: event.event_kind,
          amount_raw: amountFact.raw,
        });
        continue;
      }
      if (seenEventAmounts.has(event.event_id)) {
        const seenAmount = seenEventAmounts.get(event.event_id);
        view.review.items.push({
          event_id: event.event_id,
          reason: seenAmount === amount ? 'duplicate-event' : 'conflicting-amount',
          event_kind: event.event_kind,
          amount_raw: amountFact.raw,
        });
        continue;
      }
      seenEventAmounts.set(event.event_id, amount);
      roleBucket.total_cents += amount;
      view.refunds_cents += amount;
      cohort.net_cents -= amount;
    } else {
      roleBucket.total_cents += amount;
    }
    // Any other role (including "ignore" and unknown strings) tracks in role bucket only
  }

  view.review.count = view.review.items.length;
  view.net_cents = view.gross_cents - view.refunds_cents;
  return view;
}
