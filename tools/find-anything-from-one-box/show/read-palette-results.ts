// packages/command-palette/show/read-palette-results.ts
//
// Palette-local reply reader. Current-item discovery owns the item set; this
// package owns its own generic display-field filtering so runtime/sidebar/screen
// arrangement stay blind to package vocabulary.

import type {
  PaletteItem,
  PaletteSearchResult,
  PaletteItemSource,
} from './palette-types';
import type { PaletteQueryReply } from '../do-work/ask-current-items-ranked-by-text';

const textDecoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || (ArrayBuffer.isView(value) && value.constructor.name === 'Uint8Array');
}

function decodeReplyPayload(reply: unknown): unknown {
  const payload = isRecord(reply) && isBytes(reply.payload) ? reply.payload : reply;
  if (!isBytes(payload)) return payload;
  const text = textDecoder.decode(payload).trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function readNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}


function readNestedPayload(row: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(row.payload) ? row.payload : null;
}

function makeRenderableRow(row: Record<string, unknown>): Record<string, unknown> {
  const payload = readNestedPayload(row);
  return payload ? { ...row, ...payload, payload } : row;
}

function readMatchRanges(value: unknown): ReadonlyArray<readonly [number, number]> {
  if (!Array.isArray(value)) return [];
  const ranges: Array<readonly [number, number]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const start = entry[0];
    const end = entry[1];
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start) {
      ranges.push([start, end]);
    }
  }
  return ranges;
}

function readMatches(record: Record<string, unknown>): PaletteSearchResult['matches'] {
  const direct = record.matches;
  if (!Array.isArray(direct)) return [];
  return direct
    .map((entry): PaletteSearchResult['matches'][number] | null => {
      if (!isRecord(entry)) return null;
      const key = readString(entry, ['key', 'field']);
      if (!key) return null;
      const indices = readMatchRanges(entry.indices);
      return indices.length > 0 ? { key, indices } : null;
    })
    .filter((entry): entry is PaletteSearchResult['matches'][number] => entry !== null);
}


function readItemRows(decoded: unknown): unknown[] {
  if (Array.isArray(decoded)) return decoded;
  if (!isRecord(decoded)) return [];
  if (isRecord(decoded.output)) {
    const rows = readItemRows(decoded.output);
    if (rows.length > 0) return rows;
  }
  if (isRecord(decoded.reply)) {
    const rows = readItemRows(decoded.reply);
    if (rows.length > 0) return rows;
  }
  for (const key of ['palette_items', 'items', 'results', 'result', 'choices']) {
    const value = decoded[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function readPaletteItem(
  row: unknown,
  source: PaletteItemSource,
  index: number,
): PaletteItem | null {
  if (!isRecord(row)) return null;
  const renderableRow = makeRenderableRow(row);
  const title = readString(renderableRow, ['title', 'label', 'name', 'text', 'words']);
  if (!title) return null;

  return {
    id: readString(renderableRow, ['id', 'address', 'key']) ?? `${source.recordId}:${index}`,
    target: readString(renderableRow, ['target', 'run_target', 'invoke_target']),
    group: readString(renderableRow, ['group', 'kind', 'type']) ?? 'Results',
    title,
    description: readString(renderableRow, ['description', 'summary', 'subtitle', 'secondary_text']) ?? '',
    renderHint: readString(renderableRow, ['render_hint']) ?? undefined,
    raw: renderableRow,
    source,
  };
}

export function readPaletteItemsFromReply(reply: PaletteQueryReply): PaletteItem[] {
  if (reply.error) return [];
  const decoded = decodeReplyPayload(reply.reply);
  const source: PaletteItemSource = {
    target: reply.target,
    recordId: reply.recordId,
    sourcePath: reply.sourcePath,
    publishedRecord: reply.publishedRecord,
  };

  return readItemRows(decoded)
    .map((row, index) => readPaletteItem(row, source, index))
    .filter((item): item is PaletteItem => item !== null);
}

export function readPaletteResultsFromReplies(
  replies: readonly PaletteQueryReply[],
  queryText: string,
): PaletteSearchResult[] {
  const results: Array<PaletteSearchResult & { readonly originalIndex: number }> = [];
  for (const reply of replies) {
    for (const item of readPaletteItemsFromReply(reply)) {
      const raw = isRecord(item.raw) ? item.raw : {};
      const sourceScore = readNumber(raw, ['rank_score', 'score']) || 0;
      results.push({
        item,
        queryText,
        score: sourceScore,
        matches: readMatches(raw),
        originalIndex: results.length,
      });
    }
  }
  return results
    .sort((left, right) => {
      const leftRaw = left.item.raw as Record<string, unknown>;
      const rightRaw = right.item.raw as Record<string, unknown>;
      return right.score - left.score
        || String(leftRaw.canonical_address ?? left.item.id).localeCompare(String(rightRaw.canonical_address ?? right.item.id))
        || String(leftRaw.canonical_revision ?? '').localeCompare(String(rightRaw.canonical_revision ?? ''))
        || String(leftRaw.payload_hash ?? '').localeCompare(String(rightRaw.payload_hash ?? ''))
        || left.originalIndex - right.originalIndex;
    })
    .map(({ originalIndex: _originalIndex, ...result }) => result);
}

export function groupResults(
  results: readonly PaletteSearchResult[],
): Map<string, PaletteSearchResult[]> {
  const groups = new Map<string, PaletteSearchResult[]>();
  for (const result of results) {
    const groupName = result.item.group;
    const group = groups.get(groupName);
    if (group) {
      group.push(result);
    } else {
      groups.set(groupName, [result]);
    }
  }
  return groups;
}
