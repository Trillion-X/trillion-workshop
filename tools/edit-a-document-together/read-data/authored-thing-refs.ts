// packages/documents/read-data/authored-thing-refs.ts
//
// Decoders for authored-thing, export-descriptor, and export-artifact records,
// plus subtree lookup inside a composition scene.

import {
  flattenProjectedRows,
  isRecord,
  type CompositionContent,
  type SceneNode,
} from './documents';

export const AUTHORED_THING_ADDRESS_PREFIX = 'package::documents::authored-thing::';
export const EXPORT_DESCRIPTOR_ADDRESS_PREFIX = 'package::documents::export-descriptor::';
export const EXPORT_ARTIFACT_ADDRESS_PREFIX = 'package::documents::export-artifact::';

export type AuthoredThingRecord = {
  kind: 'composition-authored-thing';
  id: string;
  title: string;
  scene_address: string;
  node_id: string;
  created_at: string;
  updated_at: string;
};

export type ExportDescriptorRecord = {
  kind: 'composition-export-descriptor';
  id: string;
  authored_thing_ref: string;
  format_id: string;
  destination_dir: string;
  file_stem: string;
};

export type ExportArtifactRecord = {
  kind: 'composition-export-artifact';
  descriptor_ref: string;
  authored_thing_ref: string;
  path: string;
  format_id: string;
  payload_hash: string;
  exported_at: string;
};

export function authoredThingAddress(id: string): string {
  return `${AUTHORED_THING_ADDRESS_PREFIX}${id}`;
}

export function exportDescriptorAddress(id: string): string {
  return `${EXPORT_DESCRIPTOR_ADDRESS_PREFIX}${id}`;
}

export function exportArtifactAddress(descriptorId: string): string {
  return `${EXPORT_ARTIFACT_ADDRESS_PREFIX}${descriptorId}`;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

function authoredThingFrom(value: unknown): AuthoredThingRecord | null {
  if (!isRecord(value) || value.kind !== 'composition-authored-thing') return null;
  const id = stringField(value, 'id');
  const title = stringField(value, 'title');
  const sceneAddress = stringField(value, 'scene_address');
  const nodeId = stringField(value, 'node_id');
  if (!id || !title || !sceneAddress || !nodeId) return null;
  return {
    kind: 'composition-authored-thing',
    id,
    title,
    scene_address: sceneAddress,
    node_id: nodeId,
    created_at: stringField(value, 'created_at') ?? '',
    updated_at: stringField(value, 'updated_at') ?? '',
  };
}

function exportDescriptorFrom(value: unknown): ExportDescriptorRecord | null {
  if (!isRecord(value) || value.kind !== 'composition-export-descriptor') return null;
  const id = stringField(value, 'id');
  const thingRef = stringField(value, 'authored_thing_ref');
  const formatId = stringField(value, 'format_id');
  const destinationDir = stringField(value, 'destination_dir');
  const fileStem = stringField(value, 'file_stem');
  if (!id || !thingRef || !formatId || !destinationDir || !fileStem) return null;
  return {
    kind: 'composition-export-descriptor',
    id,
    authored_thing_ref: thingRef,
    format_id: formatId,
    destination_dir: destinationDir,
    file_stem: fileStem,
  };
}

function exportArtifactFrom(value: unknown): ExportArtifactRecord | null {
  if (!isRecord(value) || value.kind !== 'composition-export-artifact') return null;
  const descriptorRef = stringField(value, 'descriptor_ref');
  const thingRef = stringField(value, 'authored_thing_ref');
  const path = stringField(value, 'path');
  const formatId = stringField(value, 'format_id');
  if (!descriptorRef || !thingRef || !path || !formatId) return null;
  return {
    kind: 'composition-export-artifact',
    descriptor_ref: descriptorRef,
    authored_thing_ref: thingRef,
    path,
    format_id: formatId,
    payload_hash: stringField(value, 'payload_hash') ?? '',
    exported_at: stringField(value, 'exported_at') ?? '',
  };
}

export function readAuthoredThingRecords(raw: unknown): AuthoredThingRecord[] {
  return flattenProjectedRows(raw)
    .map(authoredThingFrom)
    .filter((value): value is AuthoredThingRecord => value !== null);
}

export function readExportDescriptors(raw: unknown): ExportDescriptorRecord[] {
  return flattenProjectedRows(raw)
    .map(exportDescriptorFrom)
    .filter((value): value is ExportDescriptorRecord => value !== null);
}

export function readExportArtifacts(raw: unknown): ExportArtifactRecord[] {
  return flattenProjectedRows(raw)
    .map(exportArtifactFrom)
    .filter((value): value is ExportArtifactRecord => value !== null);
}

export function findSubtree(content: CompositionContent, nodeId: string): SceneNode | null {
  const stack: SceneNode[] = [...content.children];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    if (node.id === nodeId) return node;
    for (const child of node.children ?? []) {
      stack.push(child);
    }
  }
  return null;
}
