// packages/documents/do-work/publish-authored-thing.ts
//
// Outbound composers: name an authored thing, publish it as a placeable
// surface, and run an export descriptor. The export is dispatched to the
// file-output owner's action by address — this package supplies source
// data (title + node tree + descriptor) and reads the result; it never
// renders or writes files itself.

import { sendRequestToBitfieldTarget } from '#workspace-records';
import { buildEngineWriteBatchRequestFromLabels } from '#workspace-records';
import {
  authoredThingAddress,
  exportArtifactAddress,
  exportDescriptorAddress,
  findSubtree,
  type AuthoredThingRecord,
  type ExportArtifactRecord,
  type ExportDescriptorRecord,
} from '../read-data/authored-thing-refs';
import { DOCUMENTS_ADDRESS, DOCUMENTS_PATH } from './write-composition-documents';
import type { CompositionContent } from '../read-data/documents';

export type BitfieldRequestSender = (request: { target: string; payload: Uint8Array }) => Promise<unknown>;

// The file-output owner's action, invoked by address (Envelope), never by import.
export const EXPORT_ACTION_TARGET = 'slot::workflow';
export const EXPORT_ACTION_DEFINITION_ID = 'action:export-node-tree-to-file';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function slugFrom(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Write one composition record at the published-record path. Exported so the
// projection runners (materialize-authored-composition-intent) share the ONE
// write path — no duplicated write helper across the verb/projection files.
export async function writeCompositionRecord(
  partitionLabel: string,
  addressLabel: string,
  payload: unknown,
  sender: BitfieldRequestSender,
): Promise<void> {
  await sender(buildEngineWriteBatchRequestFromLabels([{
    partitionLabel,
    addressLabel,
    pathLabels: DOCUMENTS_PATH,
    payloadBytes: textEncoder.encode(JSON.stringify(payload)),
  }]));
}

const writeRecord = writeCompositionRecord;

export async function nameAuthoredThing(input: {
  partitionLabel: string;
  content: CompositionContent;
  nodeId: string;
  title: string;
  id?: string;
  sender?: BitfieldRequestSender;
}): Promise<AuthoredThingRecord> {
  const sender = input.sender ?? (sendRequestToBitfieldTarget as BitfieldRequestSender);
  const subtree = findSubtree(input.content, input.nodeId);
  if (!subtree) throw new Error(`No item with id ${input.nodeId} exists in the current content`);
  const id = slugFrom(input.id ?? input.title);
  if (!id) throw new Error('A name is needed before this can be saved');
  const now = new Date().toISOString();
  const record: AuthoredThingRecord = {
    kind: 'composition-authored-thing',
    id,
    title: input.title.trim(),
    scene_address: DOCUMENTS_ADDRESS,
    node_id: input.nodeId,
    created_at: now,
    updated_at: now,
  };
  await writeRecord(input.partitionLabel, authoredThingAddress(id), record, sender);
  console.log(`[documents] named ${id}`);
  return record;
}

export async function publishAuthoredNoteSurface(input: {
  partitionLabel: string;
  thing: AuthoredThingRecord;
  sender?: BitfieldRequestSender;
}): Promise<Record<string, unknown>> {
  const sender = input.sender ?? (sendRequestToBitfieldTarget as BitfieldRequestSender);
  const { thing } = input;
  // The data ref rides `surface_input` — the ONE seam the host forwards to a
  // mounted entry as `props.surfaceInput` (same contract every placeable surface
  // uses: addressed-marks reads surfaceInput.target, analytics reads
  // surfaceInput.projection_address). `package_entry.props` is NOT forwarded by
  // the host, so it must never carry the ref (that was the "No note was chosen
  // for this spot" bug — the ref never reached the entry).
  const record = {
    kind: 'placeable-surface',
    id: `documents.note.${thing.id}`,
    label: thing.title,
    icon: 'FileText',
    material_target: `component:documents-note:${thing.id}`,
    // Authored notes are openable surfaces (from tasks/boards via their
    // published address) but must NOT pollute the curated main-workspace
    // catalog that sidebar + screen-arrangement read — so they carry their
    // own placement label, which no workspace list matches by default.
    placement_labels: ['authored-notes'],
    // Self-sufficient: the placed note carries the block identity (node_id) and
    // heading (title) it needs to render straight from surface_input — the entry
    // never has to resolve the authored-thing record out of the global
    // published-records feed (that feed does not include dynamically-created
    // authored-thing addresses, which is why placed notes rendered "no longer in
    // the current pages"). The live content still comes from ::documents, so page
    // edits flow through. authored_thing_ref stays for the export path.
    surface_input: {
      authored_thing_ref: authoredThingAddress(thing.id),
      node_id: thing.node_id,
      title: thing.title,
    },
    package_entry: {
      package_name: 'documents',
      entry_name: 'authored-note',
    },
  };
  await writeRecord(
    input.partitionLabel,
    `package::documents::placeable-surface::note::${thing.id}`,
    record,
    sender,
  );
  console.log(`[documents] published ${thing.id}`);
  return record;
}

function decodeDispatchReply(reply: unknown): Record<string, unknown> {
  if (typeof reply === 'string') return JSON.parse(reply) as Record<string, unknown>;
  if (reply instanceof Uint8Array) return JSON.parse(textDecoder.decode(reply)) as Record<string, unknown>;
  if (reply instanceof ArrayBuffer) return JSON.parse(textDecoder.decode(new Uint8Array(reply))) as Record<string, unknown>;
  if (ArrayBuffer.isView(reply)) {
    return JSON.parse(textDecoder.decode(new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength))) as Record<string, unknown>;
  }
  if (reply && typeof reply === 'object') {
    const payload = (reply as { payload?: unknown }).payload;
    if (payload !== undefined && payload !== reply) return decodeDispatchReply(payload);
    return reply as Record<string, unknown>;
  }
  throw new Error('The export reply could not be read');
}

// The saved-file result the owner's export process reports back. `payload_hash`
// is the sha256 the FILE OWNER computed over the exact bytes it wrote (L098) —
// carried into the artifact record as verifiable provenance, never a placeholder.
type ExportResult = { path: string; payload_hash: string; byte_length?: number };

function readExportResultObject(parsed: Record<string, unknown>): ExportResult | null {
  // An error-bearing reply is NEVER a success, even if it also carries a
  // path/hash-shaped field (fail-closed, L117 — no "looks-ok" artifact slips by).
  if (typeof parsed.error === 'string' && parsed.error.length > 0) {
    throw new Error(parsed.error);
  }
  if (typeof parsed.path !== 'string') return null;
  if (typeof parsed.payload_hash !== 'string' || parsed.payload_hash.length === 0) {
    // The file exists but the owner did not report a verifiable hash → fail-closed
    // (L117): do not stamp an unverifiable artifact as saved provenance.
    throw new Error('The export finished without a verifiable file hash');
  }
  // Require a positive byte count — a zero-byte file with a real sha256 is still a
  // failed export (empty output), never a saved artifact.
  if (typeof parsed.byte_length !== 'number' || !(parsed.byte_length > 0)) {
    throw new Error('The export produced an empty file');
  }
  return {
    path: parsed.path,
    payload_hash: parsed.payload_hash,
    byte_length: parsed.byte_length,
  };
}

// The owner's compute step returns stdout carrying the export result JSON.
function exportResultFrom(reply: Record<string, unknown>): ExportResult {
  const candidates: unknown[] = [reply, reply.output, (reply.output as Record<string, unknown> | undefined)?.stdout, reply.stdout];
  for (const value of candidates) {
    if (typeof value === 'string') {
      try {
        const text = value.trim().startsWith('{') ? value : atob(value);
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (typeof parsed.error === 'string') throw new Error(parsed.error);
        const result = readExportResultObject(parsed);
        if (result) return result;
      } catch (error) {
        if (error instanceof Error && !(error instanceof SyntaxError)) throw error;
      }
    }
    if (value && typeof value === 'object') {
      const result = readExportResultObject(value as Record<string, unknown>);
      if (result) return result;
    }
  }
  const steps = reply.steps;
  if (steps && typeof steps === 'object') {
    for (const step of Object.values(steps as Record<string, unknown>)) {
      if (!step || typeof step !== 'object') continue;
      const output = (step as Record<string, unknown>).output;
      if (output === undefined) continue;
      try {
        return exportResultFrom({ output });
      } catch {
        // keep scanning remaining steps
      }
    }
  }
  throw new Error('The export finished without reporting a saved file path');
}

export async function runExportDescriptor(input: {
  partitionLabel: string;
  descriptor: ExportDescriptorRecord;
  content: CompositionContent;
  thing: AuthoredThingRecord;
  sender?: BitfieldRequestSender;
}): Promise<ExportArtifactRecord> {
  const sender = input.sender ?? (sendRequestToBitfieldTarget as BitfieldRequestSender);
  const { descriptor, thing } = input;
  const subtree = findSubtree(input.content, thing.node_id);
  if (!subtree) throw new Error(`The saved item ${thing.id} is no longer in the current content`);

  // Dispatch the owner's action by address: source data in, result out.
  const reply = await sender({
    target: EXPORT_ACTION_TARGET,
    payload: textEncoder.encode(JSON.stringify({
      operation: 'execute_definition',
      definition_id: EXPORT_ACTION_DEFINITION_ID,
      include_steps: true,
      include_output: true,
      input: {
        title: thing.title,
        tree: subtree,
        descriptor: {
          format_id: descriptor.format_id,
          destination_dir: descriptor.destination_dir,
          file_stem: descriptor.file_stem,
        },
      },
    })),
  });
  const result = exportResultFrom(decodeDispatchReply(reply));

  const artifact: ExportArtifactRecord = {
    kind: 'composition-export-artifact',
    descriptor_ref: exportDescriptorAddress(descriptor.id),
    authored_thing_ref: descriptor.authored_thing_ref,
    path: result.path,
    format_id: descriptor.format_id,
    // Verifiable provenance: the sha256 the file owner computed over the exact
    // bytes it wrote (never the old '' placeholder — that claimed nothing).
    payload_hash: result.payload_hash,
    exported_at: new Date().toISOString(),
  };
  await writeRecord(input.partitionLabel, exportArtifactAddress(descriptor.id), artifact, sender);
  console.log(`[documents] exported ${thing.id} → ${artifact.path} (${descriptor.format_id})`);
  return artifact;
}

export async function saveExportDescriptor(input: {
  partitionLabel: string;
  descriptor: ExportDescriptorRecord;
  sender?: BitfieldRequestSender;
}): Promise<void> {
  const sender = input.sender ?? (sendRequestToBitfieldTarget as BitfieldRequestSender);
  await writeRecord(
    input.partitionLabel,
    exportDescriptorAddress(input.descriptor.id),
    input.descriptor,
    sender,
  );
}

// The note's OPENABLE address: its published placeable-surface. visual-database
// renders a task's `payload.attachments` entries; this address lets the note be
// opened straight from the task (via the placeable-surface intent).
export function authoredNoteSurfaceAddress(thingId: string): string {
  return `package::documents::placeable-surface::note::${thingId}`;
}

// Attach lives in materialize-authored-composition-intent.ts as the
// `task-attachment` PROJECTION over the shared authored-composition-unit
// primitive — one addressed unit, N data-described projections. It is not a
// separate verb here (L069/L030: one path, no parallel implementation).
