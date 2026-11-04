//
// The pure Grid Element Property Cascade — the generative primitive behind every
// adjustable grid aspect (column width, divider line, cell radius, label size,
// alignment, row height, conditional formatting, validation, and any future one).
//
// It is Physics: zero field vocabulary, zero React, zero I/O. A grid element's
// value for any property is looked up by walking an ORDERED chain of opaque
// property bags (cell -> column -> row -> grid), and the resolved values are
// APPLIED through a capability MAP keyed by each descriptor's `apply` id — never
// a branch on WHAT the property is:
//   - apply:'style'    -> a computed React.CSSProperties (via cssProp + unit)
//   - apply:'format'   -> a conditional tone from a Physics-closed predicate
//   - apply:'validate' -> a valid/invalid verdict from the same predicate set
// New style aspect  = a descriptor row with a cssProp (ZERO code here).
// New behavior kind = one entry in an injected apply-capability map (ZERO branch).
//
// DELETION TEST: drop the user's example descriptors, feed a totally different
// set (row-height, box-shadow, freeze, a regex rule) — every function below works
// unchanged, because none of them names a single property.

import type { CSSProperties } from 'react';

import type {
  VisualDatabaseElementStyle,
  VisualDatabaseGridPropertyDescriptor,
} from './visual-database';

/** A React inline style object (type-only React import — zero runtime coupling). */
export type GridStyleObject = CSSProperties;

/** A resolved cell verdict from behavioral applies. */
export interface GridCellVerdict {
  /** Conditional-format tone key (DATA), e.g. 'good' | 'warn' | 'bad'. */
  tone?: string;
  /** Validation result — false when the cell violates a `validate` rule. */
  valid: boolean;
  /** Human message for an invalid cell (DATA-derived). */
  message?: string;
}

// ---------------------------------------------------------------------------
// Cascade resolution — the ONE lookup every aspect shares
// ---------------------------------------------------------------------------

/** First defined value for `key` walking the ordered bag chain (most-specific
 *  first: cell -> column -> row -> grid). '', null, undefined count as unset so
 *  a cleared override falls through to the next tier / the descriptor default. */
export function resolveGridProperty(
  key: string,
  chain: readonly (VisualDatabaseElementStyle | undefined)[],
  fallback?: unknown,
): unknown {
  for (const bag of chain) {
    if (!bag) continue;
    const value = bag[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

/** The current OWN value of `key` at the most-specific bag as a string (''=unset)
 *  — what the TuningControl binds to (it edits the OWN tier, not the resolved
 *  cascade). */
export function ownGridPropertyValue(key: string, bag: VisualDatabaseElementStyle | undefined): string {
  const value = bag?.[key];
  if (value === undefined || value === null) return '';
  return String(value);
}

// ---------------------------------------------------------------------------
// apply:'style' — resolved values become a computed inline style object
// ---------------------------------------------------------------------------

/** Build the inline style object for one element from every apply:'style'
 *  descriptor whose scope is relevant, resolved over the element's bag chain.
 *  `cssProp` is a React.CSSProperties key (DATA); numeric values get `unit`
 *  appended. No per-property branch — this is a fold over descriptors. */
export function elementStyle(
  descriptors: readonly VisualDatabaseGridPropertyDescriptor[],
  chain: readonly (VisualDatabaseElementStyle | undefined)[],
): GridStyleObject {
  const style: Record<string, string | number> = {};
  for (const descriptor of descriptors) {
    if (descriptor.apply !== 'style' || !descriptor.cssProp) continue;
    const value = resolveGridProperty(descriptor.key, chain, descriptor.defaultValue);
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'number') {
      style[descriptor.cssProp] = descriptor.unit ? `${value}${descriptor.unit}` : value;
    } else {
      style[descriptor.cssProp] = String(value);
    }
  }
  return style as GridStyleObject;
}

// ---------------------------------------------------------------------------
// Predicate op set — closed by Physics (comparison is mathematical), so this is
// an allowed finite set (like Option/Result), NOT a Society enum. Heavier rules
// use apply:'derive' -> formula-engine (reused by address, no engine here).
// ---------------------------------------------------------------------------

const PREDICATES: Record<string, (cell: unknown, arg?: unknown) => boolean> = {
  empty: (cell) => cell === undefined || cell === null || cell === '',
  nonempty: (cell) => !(cell === undefined || cell === null || cell === ''),
  number: (cell) => cell !== '' && cell !== null && cell !== undefined && Number.isFinite(Number(cell)),
  eq: (cell, arg) => String(cell) === String(arg),
  neq: (cell, arg) => String(cell) !== String(arg),
  contains: (cell, arg) => String(cell).includes(String(arg)),
  gt: (cell, arg) => Number(cell) > Number(arg),
  lt: (cell, arg) => Number(cell) < Number(arg),
  regex: (cell, arg) => { try { return new RegExp(String(arg)).test(String(cell)); } catch { return false; } },
};

/** Evaluate a rule value against a cell. A rule is either a bare op string
 *  ('nonempty') or a `{ op, value? }` object — both DATA. Unknown ops → true
 *  (fail-open for format, fail-open verdict handled by caller for validate). */
function runPredicate(rule: unknown, cell: unknown): boolean {
  if (typeof rule === 'string') return PREDICATES[rule]?.(cell) ?? true;
  if (rule && typeof rule === 'object') {
    const op = (rule as Record<string, unknown>).op;
    const arg = (rule as Record<string, unknown>).value;
    if (typeof op === 'string') return PREDICATES[op]?.(cell, arg) ?? true;
  }
  return true;
}

// ---------------------------------------------------------------------------
// apply:'format' and apply:'validate' — behavioral applies (beyond UI)
// ---------------------------------------------------------------------------

/** Default tone mapping for the built-in format ops (DATA overrides via the rule
 *  object's `tone`). Physics-closed for the shorthand ops; a rule object may set
 *  any tone key. */
const FORMAT_TONE: Record<string, string> = { empty: 'warn', nonempty: 'good' };

/** Resolve a cell's conditional-format tone (apply:'format') from the column's
 *  resolved `formatWhen`-style rules. Returns the FIRST matching rule's tone. */
export function evaluateCellFormat(
  descriptors: readonly VisualDatabaseGridPropertyDescriptor[],
  chain: readonly (VisualDatabaseElementStyle | undefined)[],
  cellValue: unknown,
): string | undefined {
  for (const descriptor of descriptors) {
    if (descriptor.apply !== 'format') continue;
    const rule = resolveGridProperty(descriptor.key, chain, descriptor.defaultValue);
    if (rule === undefined || rule === null || rule === '') continue;
    if (runPredicate(rule, cellValue)) {
      const explicit = rule && typeof rule === 'object' ? (rule as Record<string, unknown>).tone : undefined;
      const shorthand = typeof rule === 'string' ? FORMAT_TONE[rule] : undefined;
      return typeof explicit === 'string' ? explicit : (shorthand ?? 'good');
    }
  }
  return undefined;
}

/** Verdict for a cell (apply:'validate'). A cell is valid unless a resolved
 *  validate rule fails. `message` comes from the rule DATA or a generic default. */
export function evaluateCellValidation(
  descriptors: readonly VisualDatabaseGridPropertyDescriptor[],
  chain: readonly (VisualDatabaseElementStyle | undefined)[],
  cellValue: unknown,
): GridCellVerdict {
  for (const descriptor of descriptors) {
    if (descriptor.apply !== 'validate') continue;
    const rule = resolveGridProperty(descriptor.key, chain, descriptor.defaultValue);
    if (rule === undefined || rule === null || rule === '') continue;
    if (!runPredicate(rule, cellValue)) {
      const msg = rule && typeof rule === 'object' ? (rule as Record<string, unknown>).message : undefined;
      return { valid: false, message: typeof msg === 'string' ? msg : `Must be ${typeof rule === 'string' ? rule : 'valid'}` };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Scope filtering — which descriptors a given control panel shows
// ---------------------------------------------------------------------------

/** Descriptors settable at a given element scope (for the property panel). */
export function propertiesForScope(
  descriptors: readonly VisualDatabaseGridPropertyDescriptor[],
  scope: 'grid' | 'row' | 'column',
): readonly VisualDatabaseGridPropertyDescriptor[] {
  return descriptors.filter((descriptor) => descriptor.scope === scope);
}
