// packages/documents/read-data/projection-actions.ts
//
// Authoring output actions ("Name this", "Save as a file", "Put on a board",
// "Attach to a task", and anything added later) read as DATA from
// `composition-projection-action` records — never a mode string enumerated in
// the surface (L069/L090/enum-dissolution). Each row is self-describing: which
// runner to dispatch (`projection_kind`), the input form to collect (`ask.fields`
// — rendered by the SHARED generic `ActionForm`, so the surface owns no field
// widgets), and how the collected answers map into the projection descriptor
// (`descriptor_bindings`).
//
// A new authoring output = ONE of these DATA rows + ONE registered runner in the
// projection-runners pack. Zero surface edit, zero handler edit. The rows come
// off the same live `published-records` feed the surface already subscribes to
// (mirrors `availableExportFormats` / `taskPickerOptions`).

import type { AskField } from '../../ui/show/action-affordance/action-affordance-types';

// The input form for an action, as ActionForm consumes it.
export interface ProjectionAsk {
  readonly title: string;
  readonly submit_label: string;
  readonly fields: readonly AskField[];
}

// How one descriptor field is filled from the collected answers. `from` names the
// answer field id; `pick` selects part of a rich answer (an entity-picker answer
// is the full option `{value,label,record}` — `pick:'record'` takes the entity,
// `pick:'value'` takes its id; omitted = the answer verbatim).
export interface ProjectionBinding {
  readonly from: string;
  readonly pick?: 'value' | 'record';
}

// A self-describing authoring output action. `projection_kind` selects the leaf
// runner (dispatched blindly by the primitive); the rest drives the generic form
// and descriptor assembly with zero per-action branching in the surface.
export interface ProjectionActionRow {
  readonly id: string;
  readonly menu_label: string;
  readonly projection_kind: string;
  readonly ask: ProjectionAsk;
  // Which answer becomes the materialize `title` (else the suggested note title).
  readonly title_from?: string;
  // descriptor field -> answer binding.
  readonly descriptor_bindings?: Readonly<Record<string, ProjectionBinding | string>>;
  // Success message; `{value}` (title), `{title}`, `{path}` are filled.
  readonly success_template: string;
  readonly order: number;
}

const PROJECTION_ACTION_KIND = 'composition-projection-action';

type DecodedRecord = { payload?: Record<string, unknown> | null };

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseAsk(raw: unknown, fallbackTitle: string): ProjectionAsk {
  const a = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const fields = Array.isArray(a.fields) ? (a.fields as AskField[]) : [];
  return {
    title: str(a.title) || fallbackTitle,
    submit_label: str(a.submit_label) || 'Save',
    fields,
  };
}

// Enumerate the authoring output actions published as DATA, sorted by `order`
// then id. Returns [] when none are present (fail-closed: the surface offers no
// outputs until the package's DATA rows are admitted — never a hardcoded set).
export function foldProjectionActions(records: readonly DecodedRecord[]): ProjectionActionRow[] {
  const rows: ProjectionActionRow[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const p = record.payload;
    if (!p || p.kind !== PROJECTION_ACTION_KIND) continue;
    const id = str(p.id);
    const projectionKind = str(p.projection_kind);
    if (!id || !projectionKind || seen.has(id)) continue;
    seen.add(id);
    const menuLabel = str(p.menu_label) || id;
    rows.push({
      id,
      menu_label: menuLabel,
      projection_kind: projectionKind,
      ask: parseAsk(p.ask, menuLabel),
      ...(str(p.title_from) ? { title_from: str(p.title_from) } : {}),
      descriptor_bindings:
        p.descriptor_bindings && typeof p.descriptor_bindings === 'object'
          ? (p.descriptor_bindings as Record<string, ProjectionBinding | string>)
          : {},
      success_template: str(p.success_template) || 'Done',
      order: typeof p.order === 'number' ? p.order : 0,
    });
  }
  rows.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
  return rows;
}

// Pure: map a completed ActionForm answers bag into the materialize call inputs
// for an action — the `title` and the projection descriptor — with zero
// per-projection branching (the row's DATA drives it). An entity-picker answer
// is `{value,label,record}`; `pick` selects which part a binding needs.
export function buildProjectionDispatch(
  action: ProjectionActionRow,
  answers: Record<string, unknown>,
  opts: { suggestedTitle: string },
): { title: string; projection: Record<string, unknown> } {
  const titleAnswer = action.title_from ? answers[action.title_from] : undefined;
  const title = typeof titleAnswer === 'string' && titleAnswer.trim() ? titleAnswer.trim() : opts.suggestedTitle;
  const projection: Record<string, unknown> = { kind: action.projection_kind };
  for (const [field, binding] of Object.entries(action.descriptor_bindings ?? {})) {
    const spec: ProjectionBinding = typeof binding === 'string' ? { from: binding } : binding;
    const raw = answers[spec.from];
    let val: unknown = raw;
    if (spec.pick && raw && typeof raw === 'object') {
      val = (raw as Record<string, unknown>)[spec.pick];
    }
    if (val !== undefined) projection[field] = val;
  }
  return { title, projection };
}

// Fill `{value}`/`{title}`/`{path}` in a success template. Unknowns -> ''.
export function fillSuccessTemplate(
  template: string,
  context: { value?: string; title?: string; path?: string },
): string {
  return template.replace(/\{(value|title|path)\}/g, (_, key: 'value' | 'title' | 'path') => context[key] ?? '');
}
