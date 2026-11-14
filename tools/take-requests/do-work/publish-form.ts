// packages/request-intake/do-work/publish-form.ts
//
// Form Builder v2 T2 — the blind document→descriptor publish translation.
//
// Purpose: fold a documents node subtree into the exact records
// request-form's reader (readRequestFormSurface) already renders: ONE
// `request-form-surface` record with `fields[]` inline, plus one
// `request-form-field-option` record per externally-declared option.
//
// Non-negotiable invariants:
// • The walk is GENERIC depth-first over `children`. A node is a form field
//   iff it carries `props.form_field` — the translator NEVER enumerates
//   value_kind or any field kind (enum dissolution / L090). Every form_field
//   key is copied VERBATIM onto the emitted field row; unknown keys ride
//   through untouched so user-minted kinds need zero code anywhere.
// • Field label resolution: form_field.label, else the nearest descendant
//   Text child's text, else the field id — pure data, no vocabulary.
// • Re-publish is patch-shaped: emitted records are deterministic per
//   (surface_id, field node id), so the caller can field-patch, never
//   delete-and-rebuild.
// • Zero imports from documents or request-form — the node
//   shape is structural (id/kind/props/children) and the output shape is
//   request-form's primitive-contract DATA. No compile-time coupling.

export type AnyRecord = Record<string, unknown>;

/** Structural view of a composition node — NOT an import (L106). */
export interface PublishNode {
  id: string;
  kind?: string;
  props?: AnyRecord;
  children?: PublishNode[];
}

export interface PublishFormInput {
  /** The subtree to publish (a whole document root or one form root). */
  root: PublishNode;
  /** Stable public surface id; one document may publish many forms. */
  surfaceId: string;
  /** Presentation + submit routing DATA (Society), copied verbatim. */
  surface?: AnyRecord;
  /** The owner action every submit fires (request-form dispatches blindly). */
  ownerAction?: AnyRecord;
}

export interface PublishFormResult {
  surfaceRecord: AnyRecord;
  optionRecords: AnyRecord[];
  fieldCount: number;
}

function isObject(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Nearest descendant Text-ish node's text, document order. */
function nearestText(node: PublishNode): string | null {
  for (const child of node.children ?? []) {
    const text = isObject(child.props) && typeof child.props.text === 'string' && child.props.text.trim().length > 0
      ? child.props.text.trim()
      : null;
    if (text) return text;
    const deeper = nearestText(child);
    if (deeper) return deeper;
  }
  return null;
}

/** Generic depth-first collection of every node carrying props.form_field. */
function collectFieldNodes(node: PublishNode, out: PublishNode[]): void {
  if (isObject(node.props) && isObject(node.props.form_field)) out.push(node);
  for (const child of node.children ?? []) collectFieldNodes(child, out);
}

export function publishForm(input: PublishFormInput): PublishFormResult {
  const fieldNodes: PublishNode[] = [];
  collectFieldNodes(input.root, fieldNodes);

  const optionRecords: AnyRecord[] = [];
  const fields = fieldNodes.map((node, index) => {
    const formField = (node.props as AnyRecord).form_field as AnyRecord;
    const { label, options, ...rest } = formField;
    const fieldName = node.id;
    const resolvedLabel = typeof label === 'string' && label.trim().length > 0
      ? label.trim()
      : nearestText(node) ?? fieldName;
    if (Array.isArray(options)) {
      options.forEach((option, optionIndex) => {
        if (!isObject(option)) return;
        optionRecords.push({
          kind: 'request-form-field-option',
          surface_id: input.surfaceId,
          field_name: fieldName,
          order: typeof option.order === 'number' ? option.order : optionIndex,
          ...option,
        });
      });
    }
    // Everything the field self-describes rides verbatim (rest spread) —
    // required/multiline/rows/input_type/placeholder/value_kind/anything.
    return {
      name: fieldName,
      label: resolvedLabel,
      order: index,
      ...rest,
    };
  });

  const surfaceRecord: AnyRecord = {
    kind: 'request-form-surface',
    surface_id: input.surfaceId,
    title: nearestText(input.root) ?? input.surfaceId,
    ...(input.surface ?? {}),
    fields,
    ...(input.ownerAction ? { owner_action: input.ownerAction } : {}),
  };

  return { surfaceRecord, optionRecords, fieldCount: fields.length };
}

/**
 * The record-write rows a caller hands to the live write path
 * (engine.operation.write-batch / the package-local writer). Deterministic
 * addresses per (surface, field) → re-publish patches in place (L043-safe),
 * never delete-and-rebuild.
 */
export function publishFormWrites(input: PublishFormInput): Array<{
  address: string;
  path: string[];
  payload: AnyRecord;
}> {
  const result = publishForm(input);
  return [
    {
      address: `request-intake.form::${input.surfaceId}::surface`,
      path: ['current-item', 'published-record'],
      payload: result.surfaceRecord,
    },
    ...result.optionRecords.map((option) => ({
      address: `request-intake.form::${input.surfaceId}::option::${option.field_name}::${option.value ?? option.order}`,
      path: ['current-item', 'published-record'],
      payload: option,
    })),
  ];
}
