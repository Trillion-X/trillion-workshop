//
// THE visual-database ↔ inspector bridge. It makes any standing record on a record
// board inspectable through the shared `ui` InspectorSidebar, reusing visual-database's
// OWN generic pieces:
//   - rendering  → `editorForShape` (the visual-database editor registry)
//   - writing    → `buildRecordWrite` + `RecordWriter` (the proven live write-batch,
//                  task #16 / RecordFormSurface — NOT a new writer)
//   - field path → `payloadFieldPath` (the ONE SSOT for "where does this field live")
//
// ZERO new editor, ZERO new writer, ZERO record ontology here: the inspector is a
// second GESTURE over visual-database's existing mechanism (L069 — one editor mechanism,
// N gesture-surfaces), never a second mechanism. No god package: `ui` owns the blind
// sidebar; visual-database owns editors + writer; this module only adapts the two opaque
// prop shapes (InspectorFieldEditorProps ↔ FieldEditorProps) and routes writes by an
// open write-kind key. It imports no other feature package.
//
// Coverage: EVERY shape renders correctly. The editor is injected through the ui
// InspectorSidebar `renderFieldEditor(source, props)` hook (which already carries the
// full source), so the bridge resolves the source's REAL descriptor by `descriptorRef`
// and its option `domain` via `effectiveDomain` — choice/multi get their options, and
// role-specific editors (title) get the real record. No shape is degraded; nothing is
// synthetic beyond a fallback record when the address can't be resolved.

import * as React from 'react';
import type { InspectorFieldEditorProps } from '../../ui/show/inspector-sidebar';
import type { InspectionSource } from '../../ui/show/inspection-ref';
import { editorForShape } from './field-editors';
import {
  effectiveDomain,
  recordAddress,
  recordPayload,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseModel,
  type VisualDatabaseRecord,
} from '../read-data/visual-database';
import {
  buildRecordWrite,
  payloadFieldPath,
  type AddressedWrite,
  type FieldWrite,
} from '../do-work/record-write-builders';
import type { RecordWriter } from '../do-work/record-writes';

/** Open write-kind key an inspector source carries for a record-field edit. The
 *  mount's dispatch routes on it; it is never a `switch` in `ui`. */
export const RECORD_FIELD_WRITE_KIND = 'visual-database.field';

/** Readable fields include immutable evidence. A payload path locates the value;
 *  `editable` controls its write capability separately, never whether it is visible. */
export function inspectableDescriptors(
  model: VisualDatabaseModel,
): readonly VisualDatabaseFieldDescriptor[] {
  return model.fields.filter(
    (descriptor) =>
      descriptor.role !== 'id' &&
      payloadFieldPath(descriptor) !== null,
  );
}

/** Build the inspector sources for ONE record — one readable field = one source.
 *  `fieldPath` is payload-relative (SSOT via `payloadFieldPath`) so the sidebar's
 *  `valueAtPath(payloadSnapshot, fieldPath)` reads exactly the cell `buildRecordWrite`
 *  writes. `descriptorRef` lets the dispatch resolve the descriptor; `shape` drives the
 *  injected editor. `write` carries only the open kind + a `$value` template — the
 *  record ontology stays in visual-database, reached through the dispatch below. */
export function buildRecordInspectionSources(
  record: VisualDatabaseRecord,
  model: VisualDatabaseModel,
): readonly InspectionSource[] {
  const address = recordAddress(record);
  if (!address) return [];
  const sources: InspectionSource[] = [];
  for (const descriptor of inspectableDescriptors(model)) {
    const path = payloadFieldPath(descriptor);
    if (!path) continue;
    sources.push({
      recordAddress: address,
      fieldPath: path,
      descriptorRef: descriptor.id,
      label: descriptor.label,
      ...(descriptor.shape ? { shape: descriptor.shape } : {}),
      ...(descriptor.editable !== false
        ? { write: { kind: RECORD_FIELD_WRITE_KIND, inputTemplate: { value: '$value' } } }
        : {}),
    });
  }
  return sources;
}

/** The sidebar's record loader: hand back the payload snapshot (what `fieldPath`
 *  indexes) with no CAS basis — visual-database's inline editors write unconditionally
 *  for its single-writer surfaces, so the inspector matches that (no fabricated guard;
 *  the CAS seam already exists on `AddressedWrite.expectedCurrent` for when a
 *  multi-writer surface needs it). */
export function makeRecordInspectionLoader(
  findRecord: (address: string) => VisualDatabaseRecord | null,
): (address: string) => Promise<{ record: unknown; basis: unknown } | null> {
  return async (address: string) => {
    const record = findRecord(address);
    if (!record) return null;
    return { record: recordPayload(record) ?? {}, basis: undefined };
  };
}

/** The sidebar's write dispatcher: resolve the descriptor + record from the source,
 *  build the ONE proven field write, persist through the injected `RecordWriter`.
 *  Pure routing — an unsupported kind is an honest error, never a silent no-op. */
export function makeRecordInspectionDispatch(options: {
  findRecord: (address: string) => VisualDatabaseRecord | null;
  descriptorById: (id: string) => VisualDatabaseFieldDescriptor | null;
  writer: RecordWriter;
  unsupportedText?: string;
}): (
  write: { readonly kind: string },
  input: Record<string, unknown>,
  source: InspectionSource,
) => Promise<void> {
  return async (write, input, source) => {
    if (write.kind !== RECORD_FIELD_WRITE_KIND) {
      throw new Error(options.unsupportedText ?? `record inspector: unsupported write kind ${write.kind}`);
    }
    const record = source.recordAddress ? options.findRecord(source.recordAddress) : null;
    const descriptor = source.descriptorRef ? options.descriptorById(source.descriptorRef) : null;
    if (!record || !descriptor) {
      throw new Error(options.unsupportedText ?? 'record inspector: record/descriptor not resolvable');
    }
    if (descriptor.editable === false || descriptor.role === 'id') {
      throw new Error('This field is read-only.');
    }
    const addressed: AddressedWrite | null = buildRecordWrite(record, [
      { descriptor, value: input.value },
    ]);
    if (!addressed) throw new Error('record inspector: record has no writable address');
    await options.writer(addressed);
  };
}

/** Adapt visual-database's editor registry into the inspector's editor slot. The
 *  inspector hands `{ value, pending, commit }`; visual-database editors want a full
 *  `FieldEditorProps`. Synthesize a minimal descriptor + record so scalar editors
 *  render and commit correctly. `extra` may carry the real descriptor/domain/model
 *  for shapes that need options (choice/multi) once the source→editor seam threads
 *  them. Returns the `(source, props)` function the InspectorSidebar `renderFieldEditor`
 *  prop expects — the source carries `descriptorRef`, so EVERY shape resolves its real
 *  descriptor + option domain (choice/multi included); nothing degrades to text. */
export function makeRecordInspectionEditor(options: {
  model: VisualDatabaseModel;
  findRecord: (address: string) => VisualDatabaseRecord | null;
}): (source: InspectionSource, props: InspectorFieldEditorProps) => React.ReactNode | null {
  return (source, props) => {
    const descriptor = source.descriptorRef
      ? options.model.fields.find((field) => field.id === source.descriptorRef) ?? null
      : null;
    // No descriptor → let the sidebar fall through to its built-in scalar/structured
    // editor (honest; the record ontology stays in visual-database).
    if (!descriptor) return null;
    const Editor = editorForShape(descriptor.shape ?? 'text');
    // Real option domain (choice/multi resolve their options; scalar shapes get []).
    const domain = effectiveDomain(descriptor, options.model);
    // Real record so role-specific editors (title's displayTitle, references) render
    // correctly; a minimal fallback only when the address can't be resolved.
    const record =
      (source.recordAddress ? options.findRecord(source.recordAddress) : null) ??
      ({ id: 'inspect', title: '', raw: { id: 'inspect', payload: {} } } as unknown as VisualDatabaseRecord);
    return (
      <Editor
        record={record}
        descriptor={descriptor}
        value={props.value}
        domain={domain}
        commit={(next: unknown) => props.commit(next)}
        readOnly={props.pending}
        model={options.model}
      />
    );
  };
}
