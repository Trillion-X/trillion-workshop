// packages/ui/show/action-affordance/action-affordance-types.ts
//
// The `action-affordance` published-record contract: DATA that says "show and
// invoke an existing admitted workflow action from these render contexts."
// The record executes nothing — the workflow slot owns execution, the invoking
// surface owns output placement. This module is types only.

/** One selectable option for a `choice`/`reference`/`entity-picker` field. Pure
 *  DATA. `record` optionally carries the full backing record so a picker whose
 *  answer must be the whole entity (not just an id) can hand it back — the host
 *  stays blind; consumers that need the id read `value`, those that need the
 *  entity read `record`. */
export interface AskFieldOption {
  readonly value: string;
  readonly label: string;
  readonly record?: unknown;
}

/** One blind input field the host collects before dispatch — a self-describing
 *  DATA descriptor (L090). The host NEVER enumerates domains: it reads `control`
 *  (an OPEN renderer-capability key — 'text' | 'select' | 'multi-select' | 'number' | 'scale' | …,
 *  extensible by registering a renderer, never a closed union) and paints the
 *  matching control. `options` are inline DATA; `options_address` names a live
 *  record list the host resolves generically (so Model → ai-cli-launch-adapters, Skill →
 *  ai-instruction-blocks are REFERENCED as DATA, never re-implemented). The
 *  collected value lands in the answers bag under `id` and binds into the
 *  workflow input via `{ from:'answers', path:id }`. `fill_action` makes a field
 *  self-filling — a nested run (definition_id) whose result becomes the value
 *  ("Generate prompt", "Describe image"): also just DATA, no field is special. */
export interface AskField {
  readonly id: string;
  readonly control: string;
  readonly label: string;
  /** JSON value type for schema-projected controls; absent preserves legacy
   *  string/select behavior. */
  readonly value_type?: string;
  readonly placeholder?: string;
  readonly help?: string;
  readonly options?: readonly AskFieldOption[];
  readonly options_address?: string;
  /** Hide an optional choice when its live DATA source currently has no
   * options. This is a presentation rule only; the owner still receives no
   * fabricated default value. */
  readonly hide_when_options_empty?: boolean;
  /** Full live option-source descriptor. The resolver interprets its shape,
   *  never the host; records, titled feeds, and entry maps are all DATA. */
  readonly options_source?: Record<string, unknown>;
  /** Narrow the `options_address` records to those matching a capability/tag —
   *  DATA, generic (never "image" in code): keep records where the value at
   *  `path` includes `includes` (array/string contains) or equals `equals`. So a
   *  "make an image" action filters models whose `capabilities` include the DATA
   *  capability it needs, sourced from the AI substrate, zero hardcoding. */
  readonly options_filter?: { readonly path: string; readonly includes?: string; readonly equals?: unknown };
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly min_label?: string;
  readonly max_label?: string;
  readonly default?: unknown;
  /** Resolve a value from the invoke context when the form opens. */
  readonly default_binding?: Record<string, unknown>;
  /** Generic option seed, e.g. `first`, for a live source with no fixed value. */
  readonly default_option?: string;
  /** Nested answer location for fields projected from a record schema. The
   *  field id remains a stable UI identity while the answer path stays an
   *  opaque configuration bag (for example, a destination's settings). */
  readonly answer_path?: string;
  readonly required?: boolean;
  /** Explicit field dependencies for stable recomputation. Dependencies are
   * field ids, never domain names. Cycles are descriptor errors and block
   * dispatch. Predicates also contribute their referenced path automatically. */
  readonly depends_on?: readonly string[];
  /** Generic conditional presentation. The field participates in rendering
   *  and required validation only while the current answers match this DATA
   *  predicate. Binding/execution remains owned by the template AST. */
  readonly visible_when?: {
    readonly path: string;
    readonly equals: unknown;
  };
  readonly enabled_when?: {
    readonly path: string;
    readonly equals: unknown;
  };
  /** Opaque owner materializer. The form may pass this to its injected
   * dispatcher; it never imports or executes a storage implementation. */
  readonly materializer?: {
    readonly target: string;
    readonly payload_template?: Readonly<Record<string, unknown>>;
    readonly [extension: string]: unknown;
  };
  readonly fill_action?: { readonly definition_id: string; readonly label?: string; readonly [key: string]: unknown };
}

/** Schema metadata for the full configuration subflow. Field identity remains
 *  the only join key; steps, advanced groups, and previews are presentation
 *  DATA and can be composed in any combination. */
export interface ActionConfigurationSchema {
  readonly version?: number;
  readonly steps?: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly field_ids?: readonly string[];
  }[];
  readonly advanced?: {
    readonly label?: string;
    readonly field_ids?: readonly string[];
  };
  readonly preview?: {
    readonly label?: string;
    readonly field_ids?: readonly string[];
  };
  /** DATA descriptors for fields projected from a selected option's backing
   *  record. The host resolves the record and JSON-schema path generically. */
  readonly dynamic_fields?: readonly {
    readonly id: string;
    readonly source_field_id: string;
    readonly source_record_path: string;
    readonly answer_prefix: string;
    readonly field_id_prefix?: string;
  }[];
}

export interface ActionAffordanceAsk {
  readonly prompt?: string;
  readonly title?: string;
  readonly fields?: readonly AskField[];
  readonly submit_label?: string;
  readonly configuration?: ActionConfigurationSchema;
}

/** One render-context binding of an affordance. `channel` is a string address
 *  (e.g. "group.add-shelf", "composition.slash-menu") — an open set, never an
 *  enum: a host asks for rows by its own channel string. */
export interface ActionAffordanceTrigger {
  readonly id: string;
  /** Render-context address this trigger appears in (DATA, open set). */
  readonly channel: string;
  /** Placement scopes WITHIN the channel this trigger appears in (DATA, open
   *  set — e.g. a context-menu channel can serve both a selection menu and a
   *  bare-canvas menu). Absent = the host channel's default placement, so
   *  existing records keep their behavior unchanged. The host filters by its
   *  own scope strings; this contract never enumerates them. */
  readonly contexts?: readonly string[];
  /** Event name within the channel. Defaults to 'invoke'. */
  readonly event?: string;
  /** Input the host collects before dispatch. `prompt` is the one-field text
   *  shorthand (fills `typed.text`); `fields` is the general form — a list of
   *  blind DATA descriptors whose answers fill the answers bag. Both are DATA;
   *  the host renders whatever it is handed and knows nothing about any domain.
   *  A single image-gen "modal" and a single-line rename are the SAME host over
   *  different `fields` rows. */
  readonly ask?: ActionAffordanceAsk;
  /** Binding-template over the invoke context — resolved by resolveBindingTemplate. */
  readonly input_template: Record<string, unknown>;
  /** Opaque per-trigger presentation bag (working_label, total_hint, item_kind, timeout_ms…).
   *  The reader never enumerates its keys — hosts read what they understand. */
  readonly presentation?: Record<string, unknown>;
}

/** How a run's completion is observed — the same polling contract the board's
 *  producer pipeline already speaks (see group/do-work/submit-producer-request). */
export interface ActionAffordanceStatus {
  readonly result_address_template: string;
  readonly error_address_template: string;
  readonly address_mode?: 'label-hash' | 'identity-text';
  readonly result_partition_label?: string;
}

/** Where a chosen affordance sends its resolved payload. `target` is a string
 *  address (DATA) — "slot::workflow" today, anything addressable tomorrow. */
export interface ActionAffordanceDispatch {
  readonly target: string;
  readonly payload_template: Record<string, unknown>;
  readonly status?: ActionAffordanceStatus;
}

/** One `{path, equals}` row evaluated against the invoking context. */
export interface ActionAffordanceCondition {
  readonly path: string;
  readonly equals: unknown;
}

/** The icon an action-affordance row shows when its record names none, so every
 *  surface (shelf, palette, menus) draws the same glyph for it. */
export const ACTION_AFFORDANCE_ICON = 'Sparkles';

/** The decoded `kind:"action-affordance"` published record. */
export interface ActionAffordance {
  readonly id: string;
  readonly version: number;
  readonly is_active: boolean;
  readonly label: string;
  /** Lucide icon name; a row without one shows `ACTION_AFFORDANCE_ICON`. */
  readonly icon?: string;
  readonly hint?: string;
  readonly section?: string;
  readonly priority?: number;
  /** How this action's produced output lands on the board (DATA, opaque to the
   *  reader): absent/"add" → append the produced items (default); "reconcile" →
   *  the agent returns the COMPLETE desired board, so existing members it echoes by
   *  id are edited in place, new ones are added, and omitted ones removed
   *  (authoritative — reorganize/edit, not just append). Any future mode is a new
   *  string the board's consume seam handles; the reader never enumerates it (L090). */
  readonly effect?: string;
  readonly accepts?: { readonly conditions: ReadonlyArray<ActionAffordanceCondition> };
  readonly triggers: ReadonlyArray<ActionAffordanceTrigger>;
  readonly dispatch: ActionAffordanceDispatch;
  readonly output_contract?: { readonly kind: string; readonly artifacts_path?: string };
  /** The raw record payload, carried opaque for hosts that read more. */
  readonly payload: unknown;
  /** The log address this record was read from — the write target for
   *  archive/remove (rewrite the record with is_active:false). Absent when the
   *  source did not carry an address (e.g. a hand-built test row). */
  readonly source_address?: string;
}

/** The binding sources a host supplies at invoke time. The resolver reads
 *  `ctx[from]` generically — it never enumerates which bags exist, so a host
 *  can add a new source (e.g. `voice`) with zero resolver change. */
export interface AffordanceInvokeContext {
  /** Host-minted run identity: { id, receipt_address? }. */
  readonly run: Record<string, unknown>;
  /** The invoking surface's context: { channel, target_ref, … }. */
  readonly surface: Record<string, unknown>;
  /** Ambient actor/session evidence supplied by the invoking host. A binding
   * may reference it, but forms never collect or invent identity values. */
  readonly actor?: Record<string, unknown>;
  /** Typed text when the trigger asked (one-line shorthand): { text }. */
  readonly typed?: Record<string, unknown>;
  /** The collected multi-field answers bag: { <field.id>: value, … }. Binds into
   *  a definition's input via `{ from:'answers', path:<field.id> }`. */
  readonly answers?: Record<string, unknown>;
  /** The current selection when relevant: { items: [...] }. */
  readonly selection?: Record<string, unknown>;
  /** Browser-local evidence supplied by a mounted capability before dispatch. */
  readonly local?: Record<string, unknown>;
  /** Set by buildDispatchPayload: { input: <resolved input_template> }. */
  readonly trigger?: Record<string, unknown>;
}
