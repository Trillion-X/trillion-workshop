// packages/documents/read-data/visibility-operators.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The operator catalog the "Show when…" condition editor offers — surfaced as
// DATA, not hardcoded in the component (L090). Each entry maps an engine
// `op:core.*` id (the SAME ops the workflow executor evaluates — equals/gt/
// contains/…) to a human label and whether it takes a value. The condition editor
// renders this list blindly; adding/removing an operator is a DATA change here,
// ZERO component code. This mirrors the engine's executor op set (the SSOT in
// workflow-core's executor context) — it does not invent new ops.
//
// `is_empty`/`is_not_empty` are intentionally absent — they are NOT in the
// verified executor op set (see the workflow-canvas operator-catalog lesson). Use
// is_null / is_not_null for presence checks.
//
// =============================================================================
// AI ASSISTANT DIRECTIVE
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

export type VisibilityOperator = {
  /** Engine op id (e.g. 'op:core.equals'). The binding transform carries this verbatim. */
  op: string;
  /** Human label for the dropdown (the "Show when … <label> …" reading). */
  label: string;
  /** Whether this operator needs a right-hand value input (presence checks do not). */
  needsValue: boolean;
};

/**
 * The verified op:core comparison set, in editor display order. Mirrors the
 * workflow executor's transform dispatch (equals/not_equals/gt/gte/lt/lte/
 * contains/includes/in_list/starts_with/is_null/is_not_null). A boolean source
 * with NO operator (visible follows it directly) is offered separately by the
 * editor as "is true".
 */
export const VISIBILITY_OPERATORS: ReadonlyArray<VisibilityOperator> = [
  { op: 'op:core.equals', label: 'equals', needsValue: true },
  { op: 'op:core.not_equals', label: 'does not equal', needsValue: true },
  { op: 'op:core.gt', label: 'is greater than', needsValue: true },
  { op: 'op:core.gte', label: 'is greater than or equal to', needsValue: true },
  { op: 'op:core.lt', label: 'is less than', needsValue: true },
  { op: 'op:core.lte', label: 'is less than or equal to', needsValue: true },
  { op: 'op:core.contains', label: 'contains', needsValue: true },
  { op: 'op:core.includes', label: 'includes', needsValue: true },
  { op: 'op:core.in_list', label: 'is one of', needsValue: true },
  { op: 'op:core.starts_with', label: 'starts with', needsValue: true },
  { op: 'op:core.is_null', label: 'is empty', needsValue: false },
  { op: 'op:core.is_not_null', label: 'is set', needsValue: false },
];

/** Look up an operator by its engine op id. */
export function visibilityOperatorByOp(op: string | undefined): VisibilityOperator | null {
  if (!op) return null;
  return VISIBILITY_OPERATORS.find((entry) => entry.op === op) ?? null;
}

/** Whether the chosen operator needs a value input (drives the editor layout). */
export function operatorNeedsValue(op: string | undefined): boolean {
  const entry = visibilityOperatorByOp(op);
  return entry ? entry.needsValue : true;
}
