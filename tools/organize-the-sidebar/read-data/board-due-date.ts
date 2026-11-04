// packages/group/read-data/board-due-date.ts
//
// The DUE-DATE primitive: a target day on an item + the pure relative-time engine that reads it. A
// vision/goal board's items are aspirations with deadlines ("buy a house by 2027") — this turns a due
// timestamp into a countdown badge, overdue state, and an urgency bucket, all from DATA (L069/L090).
// The item carries `extra.dueDate` (ms since epoch); this leaf normalizes + computes relative time.
// Pure + deterministic: `now` is INJECTED by the caller (the shell passes Date.now(); tests pass a fixed
// instant) — no clock lives here. Day math uses UTC-day boundaries so it is timezone-independent.

const DAY_MS = 86_400_000;

/** Urgency bucket for a due date, relative to now — drives the badge tint + "Due soon" filtering. */
export type DueUrgency = 'overdue' | 'today' | 'soon' | 'upcoming' | 'later';

/** The relative-time readout for a due date. */
export interface RelativeDue {
  readonly due: number;
  /** Whole UTC-days from today to the due day (negative = past). */
  readonly daysUntil: number;
  readonly overdue: boolean;
  /** Human label: "Today" / "Tomorrow" / "Yesterday" / "in N days" / "N days ago". */
  readonly label: string;
  readonly urgency: DueUrgency;
}

/** ECMAScript `Date` valid range max (±8.64e15 ms). A due date beyond it is not a real instant, and — the
 *  reachable crash — a downstream `new Date(due).toISOString()` (e.g. SelectedItemToolbar) throws RangeError
 *  on an out-of-range ms. Bounding here fails closed to "no badge" instead of crashing the toolbar. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/** Fail-closed: a due date is a positive-integer ms timestamp within the valid Date range, else null (no badge). */
export function dueDateFromRaw(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw <= MAX_DATE_MS ? raw : null;
}

/** Format a due epoch-ms as a compact, DETERMINISTIC `YYYY-MM-DD` label — UTC + locale-free so a
 *  render/proof harness (and every user, in any timezone) sees byte-identical text. Clamps to the
 *  valid Date range first (a finite-but-out-of-range ms would `RangeError` inside `toISOString`),
 *  failing closed to the boundary date instead of crashing. The SSOT date-label formatter for the
 *  due-date timeline axis + the item badge (replaces the toolbar's private copy). */
export function dueMsToDateLabel(ms: number): string {
  const clamped = ms > MAX_DATE_MS ? MAX_DATE_MS : ms < -MAX_DATE_MS ? -MAX_DATE_MS : ms;
  return new Date(clamped).toISOString().slice(0, 10);
}

/** Floor a timestamp to its UTC-day start (so day differences are timezone-independent + deterministic). */
function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function urgencyOf(daysUntil: number): DueUrgency {
  if (daysUntil < 0) return 'overdue';
  if (daysUntil === 0) return 'today';
  if (daysUntil <= 3) return 'soon';
  if (daysUntil <= 14) return 'upcoming';
  return 'later';
}

function labelOf(daysUntil: number): string {
  if (daysUntil === 0) return 'Today';
  if (daysUntil === 1) return 'Tomorrow';
  if (daysUntil === -1) return 'Yesterday';
  return daysUntil > 0 ? `in ${daysUntil} days` : `${-daysUntil} days ago`;
}

/** Compute the relative-time readout for a due date at `now` (both ms). Pure — no clock read. */
export function relativeDue(due: number, now: number): RelativeDue {
  const daysUntil = Math.round((utcDayStart(due) - utcDayStart(now)) / DAY_MS);
  return { due, daysUntil, overdue: daysUntil < 0, label: labelOf(daysUntil), urgency: urgencyOf(daysUntil) };
}

/** True iff a due date is "soon or worse" (overdue/today/within 3 days) — the "needs attention" set. */
export function isDueSoon(due: number, now: number): boolean {
  const u = relativeDue(due, now).urgency;
  return u === 'overdue' || u === 'today' || u === 'soon';
}

/** An item paired with its due date — the input to the collection reducers. */
export interface DueItem {
  readonly id: string;
  readonly due: number;
}

/** Items sorted by NEAREST due date first (overdue → soonest upcoming) — the "Due soon" list order. */
export function sortByDue(items: readonly DueItem[]): DueItem[] {
  return [...items].sort((a, b) => a.due - b.due);
}
