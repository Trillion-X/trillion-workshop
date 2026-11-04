// packages/documents/do-work/projection-runners-pack.ts
//
// THE LEAF CAPABILITY PACK — the ONLY place projection kinds are named.
//
// The primitive (`materializeAuthoredCompositionIntent`) is the generic core: it
// resolves the addressed authored composition unit once, then dispatches to a
// runner looked up in an INJECTED map. It names zero projections. This pack lives
// OUTSIDE that core (enum-dissolution: "the extensible list is outside the generic
// core it consumes") and binds the current projection names to the leaf verbs that
// dispatch to each OWNING generic package by Envelope:
//   identity        → just the named SSOT unit (no side projection)
//   surface         → this package's placeable-surface (openable note)
//   file            → the file-output owner via `slot::workflow`
//   task-attachment → visual-database/tasks via payload.attachments
//   knowledge       → the knowledge-records corpus via its write-source action
//
// Adding a projection = one entry here + one `composition-projection-action` DATA
// row. Zero core change, zero surface change. Composition wiring (or a caller)
// injects this pack; a different owner could inject a different pack entirely.

import {
  publishAuthoredNoteSurface,
  runExportDescriptor,
  saveExportDescriptor,
  authoredNoteSurfaceAddress,
  writeCompositionRecord,
} from './publish-authored-thing';
import { exportCompositionFragment, exportDocumentMarkdown } from './imported-document.mjs';
import {
  buildTaskAttachmentAppend,
  noteAttachmentRefs,
  type TaskRecord,
} from './build-task-attachment-append';
import type {
  ExportArtifactRecord,
  ExportDescriptorRecord,
} from '../read-data/authored-thing-refs';
import type {
  AuthoredCompositionUnit,
  ProjectionResult,
  ProjectionRunnerMap,
} from './materialize-authored-composition-intent';

const textEncoder = new TextEncoder();

// knowledge-records ingest is a workflow action, dispatched by Envelope (never
// imported). The composition package supplies source data (the note's address +
// title) and the knowledge corpus owns indexing.
const WORKFLOW_TARGET = 'slot::workflow';
const KNOWLEDGE_WRITE_SOURCE_DEFINITION = 'action:knowledge-records.write-source';

// Built lazily (a function, not a module-load const) so it never trips an ES
// module cyclic-init hazard against the leaf verbs it composes.
export function defaultProjectionRunners(owners: { savePortableFile?: (input: { name: string; folder: string; text: string; mediaType?: string }) => Promise<string> } = {}): ProjectionRunnerMap {
  return {
    // Identity projection → the named SSOT unit itself, no side effect. This is
    // what "Name this" produces: the primitive already resolves+names the unit,
    // so the runner just echoes it back. Unifies naming into the one path.
    identity: async (unit): Promise<ProjectionResult> => {
      return { kind: 'identity', thing: unit.thing };
    },

    // Render projection → this package's placeable-surface (openable note).
    surface: async (unit, _descriptor, ctx): Promise<ProjectionResult> => {
      const record = await publishAuthoredNoteSurface({
        partitionLabel: ctx.partitionLabel,
        thing: unit.thing,
        sender: ctx.sender,
      });
      return { kind: 'surface', record, surfaceAddress: authoredNoteSurfaceAddress(unit.thing.id) };
    },

    // File projection → the file-output owner (via runExportDescriptor's Envelope
    // dispatch). The caller supplies only what it knows as DATA — `format_id`
    // (fail-closed if absent) + `destination_dir`; the runner derives the
    // thing-dependent descriptor fields from the resolved unit, persists the
    // descriptor, and returns the saved artifact.
    file: async (unit, descriptor, ctx): Promise<ProjectionResult> => {
      const formatId = typeof descriptor.format_id === 'string' ? descriptor.format_id : '';
      if (!formatId) throw new Error('A file projection needs a format');
      const destinationDir = typeof descriptor.destination_dir === 'string' ? descriptor.destination_dir : '';
      if (formatId === 'composition-fragment-json' || formatId === 'composition-markdown') {
        if (!owners.savePortableFile) throw new Error('The shared Files upload owner is required to save this file.');
        const text = formatId === 'composition-fragment-json'
          ? `${JSON.stringify(exportCompositionFragment({ title: unit.thing.title, subtree: unit.subtree }), null, 2)}\n`
          : `${exportDocumentMarkdown({ children: [unit.subtree] })}\n`;
        if (textEncoder.encode(text).byteLength > 5 * 1024 * 1024) throw new Error('This composition is too large for a portable import file.');
        const safeId = unit.thing.id.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'composition';
        const name = formatId === 'composition-fragment-json' ? `${safeId}.trillion-composition.json` : `${safeId}.md`;
        const path = await owners.savePortableFile({ name, folder: destinationDir, text, mediaType: formatId === 'composition-markdown' ? 'text/markdown' : 'application/json' });
        return { kind: 'file', path, format_id: formatId, name };
      }
      const exportDescriptor: ExportDescriptorRecord = {
        kind: 'composition-export-descriptor',
        id: `${unit.thing.id}-${formatId}`,
        authored_thing_ref: unit.address,
        format_id: formatId,
        destination_dir: destinationDir,
        file_stem: unit.thing.id,
      };
      await saveExportDescriptor({ partitionLabel: ctx.partitionLabel, descriptor: exportDescriptor, sender: ctx.sender });
      const artifact: ExportArtifactRecord = await runExportDescriptor({
        partitionLabel: ctx.partitionLabel,
        descriptor: exportDescriptor,
        content: unit.content,
        thing: unit.thing,
        sender: ctx.sender,
      });
      return { kind: 'file', artifact, path: artifact.path };
    },

    // Task-attachment projection → visual-database/tasks (payload.attachments). The
    // note must be openable first, so this reuses the surface publish (composition
    // of projections, not a re-implementation).
    'task-attachment': async (unit, descriptor, ctx): Promise<ProjectionResult> => {
      const taskRecord = descriptor.taskRecord as TaskRecord | undefined;
      if (!taskRecord?.address?.trim()) throw new Error('A task is needed before this can be attached');
      await publishAuthoredNoteSurface({ partitionLabel: ctx.partitionLabel, thing: unit.thing, sender: ctx.sender });
      const filePath = typeof descriptor.filePath === 'string' ? descriptor.filePath : undefined;
      const refs = noteAttachmentRefs({
        surfaceAddress: authoredNoteSurfaceAddress(unit.thing.id),
        title: unit.thing.title,
        ...(filePath ? { filePath } : {}),
      });
      const write = buildTaskAttachmentAppend(taskRecord, refs);
      if (write.changed) {
        await writeCompositionRecord(ctx.partitionLabel, write.address, write.payload, ctx.sender);
        console.log(`[documents] attached ${unit.thing.id} → ${write.address}`);
      }
      return { kind: 'task-attachment', thing: unit.thing, attachments: write.attachments, changed: write.changed };
    },

    // Knowledge projection → the `knowledge-records` corpus (via its write-source
    // workflow action, Envelope-dispatched). This package supplies only the
    // source pointer (the note's addressed unit) + corpus_ref as DATA; the corpus
    // owns indexing/chunking/retrieval. No god package.
    knowledge: async (unit, descriptor, ctx): Promise<ProjectionResult> => {
      const corpusRef = typeof descriptor.corpus_ref === 'string' ? descriptor.corpus_ref : '';
      if (!corpusRef) throw new Error('A knowledge projection needs a corpus_ref');
      const sourceId = `documents-note-${unit.thing.id}`;
      await ctx.sender({
        target: WORKFLOW_TARGET,
        payload: textEncoder.encode(JSON.stringify({
          operation: 'execute_definition',
          definition_id: KNOWLEDGE_WRITE_SOURCE_DEFINITION,
          input: {
            id: sourceId,
            corpus_ref: corpusRef,
            source_ref: unit.address,
            title: unit.thing.title,
            created_at: new Date().toISOString(),
          },
        })),
      });
      return { kind: 'knowledge', sourceId, corpusRef };
    },
  };
}
