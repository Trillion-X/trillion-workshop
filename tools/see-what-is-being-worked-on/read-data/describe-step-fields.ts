// packages/workflow-canvas/read-data/describe-step-fields.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The translation boundary (L098) that turns one workflow step — the engine's
// real, open step vocabulary (action/loop/ask/wait/read/write/return/…) — into
// a list of self-describing FIELD DESCRIPTORS that a BLIND renderer paints.
//
// Reference anatomy (locked by the workflow-canvas screen contract): the Lindy
// node inspector is a uniform FIELD STACK — every node type renders the same
// shape (label + helper + control), only the fields differ (Agent Step: prompt
// textarea + model select + confirmation select + skills; Enter loop: items +
// max cycles + concurrency; trigger: connection + filters). The fields are data,
// not bespoke per-kind forms.
//
// =============================================================================
// THE GENERATIVE PRIMITIVE (L069)  +  ENUM DISSOLUTION (L090)
// =============================================================================
//
//   step (engine kind + config)  ──describeStepFields──▶  StepFieldDescriptor[]
//                                                              │
//                                                     blind generic renderer
//                                                     (switches ONLY on
//                                                      control.kind — a closed
//                                                      set of UI primitives)
//
// The step-KIND knowledge lives HERE, in the data-owner/translation layer where
// it belongs (read-data) — never in the renderer (Physics/host). The renderer
// enumerates nothing. Adding a step kind = adding a STEP_FIELD_SCHEMAS row
// (Society DATA) + (only if a brand-new option source) one ctx field. ZERO
// renderer code. The control kinds are L1/L2 UI vocabulary (text/select/…),
// closed by Physics like HTML input types — NOT step-kind aliases.
//
// SSOT: the engine step-executor still OWNS the config shape (it reads
// config.definition_id / config.source / … at runtime). This layer does not
// INVENT keys — it translates the keys the engine defines into human labels +
// control kinds. That is the L098 boundary, not a second source of truth.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure: (step, ctx) -> descriptors. No I/O, no React, no engine vocabulary
//    in the OUTPUT (labels are human; the renderer never sees 'ask'/'write').
// 2. Machine-readable: every binding is an explicit `path: string[]` into the
//    addressed value — never an encoded "a.b.c" string (machine-readable rule).
// 3. Behavior-faithful: the descriptors reproduce the exact current StepEditor
//    fields, labels, defaults, option sources, and the ask-prefill / wait-union
//    behaviors — nothing dropped (L030/L101).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

// ---------------------------------------------------------------------------
// Descriptor model — the self-describing field language the renderer consumes
// ---------------------------------------------------------------------------

/** One choice in a select/union control. May carry prefill metadata. */
export interface StepFieldOption {
  value: string;
  label: string;
  /** Most-common LIVE payload for this choice — prefills an empty sibling
   *  (Lindy's filled-by-default field anatomy). Carried as data on the option,
   *  read generically by a `prefillSibling` directive. */
  examplePayload?: Record<string, unknown>;
  /** Human-readable keys this choice usually includes (the "Usually includes:"
   *  hint). Presentation data, not engine vocabulary. */
  payloadKeys?: readonly string[];
}

/** Where a control's options come from. A tiny CLOSED set of generic option
 *  SOURCES (not step kinds) — the translation layer's own vocabulary. */
export type StepOptionSource = 'actions' | 'workTargets';

/** Generic UI control primitives — closed by Physics (L1/L2 UI vocabulary,
 *  like HTML input types). The renderer switches on exactly this set. */
export type StepFieldControl =
  | { kind: 'text'; placeholder?: string; fallback?: string }
  | { kind: 'number' }
  | { kind: 'datetime' }
  | { kind: 'duration' }
  | {
      kind: 'select';
      optionsFrom: StepOptionSource;
      placeholder?: string;
      /** Shown as placeholder + disables the control when no options exist. */
      emptyHint?: string;
      /** On change: if the chosen option carries `examplePayload` and the
       *  target sibling is empty, set the sibling to it (the ask prefill). */
      prefillSibling?: { path: string[]; from: 'examplePayload' };
    }
  | { kind: 'structured'; injectable?: boolean }
  | {
      kind: 'union';
      /** Key inside the addressed object that selects the branch. */
      discriminantKey: string;
      /** Each branch carries its OWN option label + field templates. The union
       *  is self-describing: its discriminant options derive from these branches,
       *  so there is no external option list to keep in sync (ONE source —
       *  replaces the old optionsFrom:'waitTypes' + the duplicate WAIT_TYPES). */
      branches: Record<string, UnionBranch>;
      /** Fallback branch when the stored discriminant is unknown/missing. */
      defaultBranch: string;
    };

/** Declarative field template (the DATA in STEP_FIELD_SCHEMAS). Resolved against
 *  a concrete step + ctx into a StepFieldDescriptor. */
export interface StepFieldTemplate {
  /** Path into the addressed object (config by default). */
  path: string[];
  /** Human label, or null for an unlabeled control (e.g. a union branch body). */
  label: string | null;
  help?: string | null;
  control: StepFieldControl;
  /** When 'step', the path addresses the whole step record (kind+config),
   *  not config — used by the raw structured editor for open/custom steps. */
  base?: 'config' | 'step';
  /** Seed value written when this field's branch becomes active (union switch).
   *  Lets the blind renderer reconstruct a freshly-switched branch's shape
   *  from data — e.g. wait→duration seeds { type, secs: 60 } — without knowing
   *  the step kind. */
  default?: unknown;
}

/** One discriminated-union branch: the option label shown in the discriminant
 *  picker + the field templates revealed when that branch is active. The branch
 *  is the SINGLE source for both — the picker options are derived from these. */
export interface UnionBranch {
  label: string;
  fields: readonly StepFieldTemplate[];
}

/** A resolved, render-ready field. Same shape as the template but with select/
 *  union options materialized from ctx and the current value bound. */
export interface StepFieldDescriptor {
  path: string[];
  base: 'config' | 'step';
  label: string | null;
  help: string | null;
  control: ResolvedControl;
  /** Seed value for a union branch switch (null when not applicable). */
  default: unknown;
}

export type ResolvedControl =
  | { kind: 'text'; placeholder?: string; fallback?: string }
  | { kind: 'number' }
  | { kind: 'datetime' }
  | { kind: 'duration' }
  | {
      kind: 'select';
      options: readonly StepFieldOption[];
      placeholder?: string;
      emptyHint?: string;
      prefillSibling?: { path: string[]; from: 'examplePayload' };
    }
  | { kind: 'structured'; injectable: boolean }
  | {
      kind: 'union';
      discriminantKey: string;
      options: readonly StepFieldOption[];
      activeBranch: string;
      /** Resolved descriptors for the active branch, addressed relative to the
       *  union object (the renderer joins union path + branch path). */
      branchFields: readonly StepFieldDescriptor[];
      branchTemplates: Record<string, readonly StepFieldTemplate[]>;
      defaultBranch: string;
    };

/** Context the translation needs — the live option surfaces the inspector mines
 *  (other actions, work targets + their example payloads, wait types). Supplied
 *  by read-data's caller; never hardcoded here. */
export interface DescribeStepCtx {
  actions: readonly StepFieldOption[];
  workTargets: readonly StepFieldOption[];
}

// ---------------------------------------------------------------------------
// The schema table — Society DATA. Adding a step kind = adding a row here.
// Faithful to the current StepEditor (NodeInspector.tsx lines 454-619).
// ---------------------------------------------------------------------------

/** Steps with no schema row fall through to a single raw structured editor over
 *  the whole step (write / return / custom / anything the engine adds later). */
export const STEP_FIELD_SCHEMAS: Record<string, readonly StepFieldTemplate[]> = {
  action: [
    { path: ['definition_id'], label: 'Run this action', control: { kind: 'select', optionsFrom: 'actions', placeholder: 'Choose an action', emptyHint: 'Create another action first' } },
  ],
  loop: [
    { path: ['source'], label: 'List to go through', control: { kind: 'text' } },
    { path: ['item_var'], label: 'Call each item', control: { kind: 'text', fallback: 'item' } },
    { path: ['definition_id'], label: 'Run this action for each item', control: { kind: 'select', optionsFrom: 'actions', placeholder: 'Choose an action', emptyHint: 'Create another action first' } },
  ],
  ask: [
    { path: ['name'], label: 'Who does the work', control: { kind: 'select', optionsFrom: 'workTargets', placeholder: 'Choose who does it', emptyHint: 'Nothing to ask yet', prefillSibling: { path: ['input'], from: 'examplePayload' } } },
    { path: ['input'], label: 'What to send', control: { kind: 'structured', injectable: true } },
  ],
  wait: [
    {
      path: ['wait_condition'],
      label: 'Wait',
      control: {
        kind: 'union',
        discriminantKey: 'type',
        defaultBranch: 'duration',
        branches: {
          duration: { label: 'For a period of time', fields: [{ path: ['secs'], label: null, control: { kind: 'duration' }, default: 60 }] },
          event: { label: 'Until something happens', fields: [{ path: ['event_type'], label: 'What to wait for', control: { kind: 'text' }, default: '' }] },
          until: { label: 'Until a set time', fields: [{ path: ['datetime'], label: 'Date and time', control: { kind: 'datetime' }, default: '' }] },
        },
      },
    },
  ],
  read: [
    { path: ['from'], label: 'What to read', control: { kind: 'text' } },
  ],
};

// ---------------------------------------------------------------------------
// The step-kind catalog — the package's SINGLE source of truth for the engine's
// step vocabulary: each kind's human label (the add-step menu) + empty shape
// (the add-step factory). describe-step-fields already owns each kind's FIELD
// schema; co-locating the label + empty config here means the inspector reads
// ONE table instead of re-listing the kinds in a STEP_SHAPES array + an
// emptyStepOfKind switch (SSOT / L088). Adding a kind = one catalog row.
// ---------------------------------------------------------------------------

interface StepKindCatalogEntry {
  value: string;
  label: string;
  /** Presentation icon identity for this kind — a primitive icon name (never a
   *  domain word), rendered by show/node-icon's blind iconForName. This is the
   *  ONE kind→icon source: the node card, the inspector add-step menu, and the
   *  "Select next step" catalog all read it (read-data owns the translation,
   *  L098/L088). Extending the engine with a kind = one row here, zero view
   *  changes anywhere. */
  iconName: string;
  /** The empty step of this kind. action/loop seed definition_id with the
   *  fallback action id; everything else ignores it. */
  empty: (fallbackActionId: string) => unknown;
}

const STEP_KIND_CATALOG: readonly StepKindCatalogEntry[] = [
  { value: 'action', label: 'Run another action', iconName: 'play', empty: (a) => ({ kind: 'action', config: { definition_id: a, inputs: {} } }) },
  { value: 'loop', label: 'Repeat for each item', iconName: 'repeat', empty: (a) => ({ kind: 'loop', config: { source: '', item_var: 'item', definition_id: a, max_iterations: 100 }, join: 'all' }) },
  { value: 'ask', label: 'Ask outside work', iconName: 'arrow-right-left', empty: () => ({ kind: 'ask', config: { name: '', input: {} } }) },
  { value: 'wait', label: 'Wait', iconName: 'timer', empty: () => ({ kind: 'wait', config: { wait_condition: { type: 'duration', secs: 60 } } }) },
  { value: 'write', label: 'Write a record', iconName: 'pen-line', empty: () => ({ kind: 'write', config: { items: [] } }) },
  { value: 'read', label: 'Read a record', iconName: 'book-open', empty: () => ({ kind: 'read', config: { from: '' } }) },
  { value: 'return', label: 'Return a value', iconName: 'corner-down-left', empty: () => ({ kind: 'return', config: { value: null } }) },
  { value: 'custom', label: 'Advanced step', iconName: 'settings', empty: () => ({ kind: 'custom', config: {} }) },
];

/** The step kinds + human labels + icon names for any add-step surface (SSOT). */
export function stepKindCatalog(): readonly { value: string; label: string; iconName: string }[] {
  return STEP_KIND_CATALOG.map((entry) => ({ value: entry.value, label: entry.label, iconName: entry.iconName }));
}

/** Presentation icon name for a step kind (the node card's blind icon source).
 *  Unknown kinds fall back to the generic 'settings' glyph. */
export function stepKindIconName(kind: string): string {
  return STEP_KIND_CATALOG.find((e) => e.value === kind)?.iconName ?? 'settings';
}

/** Build an empty step of the given kind (the add-step factory). Unknown kinds
 *  fall through to a custom step. */
export function emptyStepOfKind(kind: string, fallbackActionId: string): unknown {
  const entry = STEP_KIND_CATALOG.find((e) => e.value === kind);
  return entry ? entry.empty(fallbackActionId) : { kind: 'custom', config: {} };
}

// ---------------------------------------------------------------------------
// Resolution — pure (step, ctx) -> descriptors
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** The engine kind of a step, or 'custom' for anything without a schema row. */
export function stepKind(step: unknown): string {
  if (!isRecord(step)) return 'custom';
  const kind = readText(step.kind);
  return kind in STEP_FIELD_SCHEMAS ? kind : (kind || 'custom');
}

function configOf(step: unknown): Record<string, unknown> {
  return isRecord(step) && isRecord(step.config) ? step.config : {};
}

function optionsForSource(source: StepOptionSource, ctx: DescribeStepCtx): readonly StepFieldOption[] {
  return source === 'actions' ? ctx.actions : ctx.workTargets;
}

/** Read the value at `path` from a base object (shallow→deep). */
function valueAtPath(base: unknown, path: readonly string[]): unknown {
  let cursor: unknown = base;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function resolveControl(
  control: StepFieldControl,
  objectAtBase: Record<string, unknown>,
  ctx: DescribeStepCtx,
): ResolvedControl {
  switch (control.kind) {
    case 'select': {
      return {
        kind: 'select',
        options: optionsForSource(control.optionsFrom, ctx),
        placeholder: control.placeholder,
        emptyHint: control.emptyHint,
        prefillSibling: control.prefillSibling,
      };
    }
    case 'structured':
      return { kind: 'structured', injectable: Boolean(control.injectable) };
    case 'union': {
      const unionObject = isRecord(objectAtBase) ? objectAtBase : {};
      const stored = readText(unionObject[control.discriminantKey], control.defaultBranch);
      const activeBranch = stored in control.branches ? stored : control.defaultBranch;
      const branchTemplates = control.branches[activeBranch]?.fields ?? [];
      const branchFields = branchTemplates.map((tpl) =>
        resolveTemplate(tpl, unionObject, ctx),
      );
      return {
        kind: 'union',
        discriminantKey: control.discriminantKey,
        // The discriminant options ARE the branches — derived from the same
        // self-describing source as the branch fields, never a parallel list.
        options: Object.entries(control.branches).map(([value, branch]) => ({ value, label: branch.label })),
        activeBranch,
        branchFields,
        branchTemplates: Object.fromEntries(
          Object.entries(control.branches).map(([key, branch]) => [key, branch.fields]),
        ),
        defaultBranch: control.defaultBranch,
      };
    }
    case 'text':
      return { kind: 'text', placeholder: control.placeholder, fallback: control.fallback };
    case 'number':
      return { kind: 'number' };
    case 'datetime':
      return { kind: 'datetime' };
    case 'duration':
      return { kind: 'duration' };
  }
}

function resolveTemplate(
  template: StepFieldTemplate,
  objectAtBase: Record<string, unknown>,
  ctx: DescribeStepCtx,
): StepFieldDescriptor {
  // For a union the "object at base" is the union's own object (nested);
  // resolveControl reads the discriminant from the value at the template path.
  const nested = template.control.kind === 'union'
    ? (isRecord(valueAtPath(objectAtBase, template.path)) ? (valueAtPath(objectAtBase, template.path) as Record<string, unknown>) : {})
    : objectAtBase;
  return {
    path: template.path,
    base: template.base ?? 'config',
    label: template.label,
    help: template.help ?? null,
    control: resolveControl(template.control, nested, ctx),
    default: template.default ?? null,
  };
}

/**
 * Translate one step into render-ready field descriptors. The ONLY place that
 * knows the engine's step-kind → field mapping. Steps without a schema row
 * resolve to a single raw structured editor over the whole step.
 */
export function describeStepFields(step: unknown, ctx: DescribeStepCtx): readonly StepFieldDescriptor[] {
  const kind = stepKind(step);
  const templates = STEP_FIELD_SCHEMAS[kind];
  if (!templates) {
    return [{ path: [], base: 'step', label: 'Step details', help: null, control: { kind: 'structured', injectable: false } }];
  }
  const config = configOf(step);
  return templates.map((tpl) => resolveTemplate(tpl, config, ctx));
}
