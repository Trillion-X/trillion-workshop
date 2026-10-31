// packages/ask-questions-sort-answers-follow-up/read-data/synthesis-result.ts
//
// The LIVING readout primitive: a synthesis surface persists its latest reply as
// a durable `synthesis-result` published-record, so reopening the surface shows
// the result immediately (no AI re-run). All logic here is PURE — the view does
// the I/O. Everything specific (sequence, per-surface key) is DATA (L090).
//
// Keying: the 3 Conviction surfaces (Convictions / Prime Directive / Codex) share
// one sequenceId, so the stable key is (sequenceId, resultKey). resultKey is
// DATA on surfaceInput; when absent it falls back to a stable slug of the title
// so distinct surfaces never collide.

export type SynthesisResultRecord = {
  kind: string;
  sequence_id?: string;
  result_key?: string;
  output_kind?: string;
  text?: string;
  produced_at?: string;
};

export const SYNTHESIS_RESULT_KIND = 'synthesis-result';

/** Stable slug for a human string (lowercase, hyphen-joined word chars). */
export function slugify(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** The stable per-surface key: explicit DATA `resultKey`, else a slug of the
 *  title, else 'default'. Never throws. */
export function resultKeyFor(resultKey?: string, title?: string): string {
  const explicit = typeof resultKey === 'string' ? resultKey.trim() : '';
  if (explicit) return slugify(explicit) || 'default';
  const fromTitle = slugify(title ?? '');
  return fromTitle || 'default';
}

/** The durable address for one surface's latest synthesis. Written at the
 *  2-segment [current-item, published-record] path so it lands in the
 *  `published-records` feed the view reads (Lane-A 2-seg feed lesson). */
export function synthesisResultAddress(sequenceId: string | undefined, key: string): string {
  const seq = (sequenceId ?? 'seq').trim() || 'seq';
  return `package::ask-questions-sort-answers-follow-up::synthesis-result::${seq}::${key}`;
}

type Row = { address?: string; payload?: unknown };

function rowsOf(published: unknown): Row[] {
  if (Array.isArray(published)) return published as Row[];
  if (published && typeof published === 'object' && Array.isArray((published as { rows?: unknown }).rows)) {
    return (published as { rows: Row[] }).rows;
  }
  return [];
}

function payloadOf(row: Row): SynthesisResultRecord | null {
  const p = row && typeof row === 'object' ? (row.payload ?? row) : null;
  return p && typeof p === 'object' ? (p as SynthesisResultRecord) : null;
}

/** The latest persisted synthesis text for (sequenceId, key), or null. Latest by
 *  produced_at. Pure — reads whatever `published-records` rows are given. */
export function latestSynthesisResult(
  published: unknown,
  sequenceId: string | undefined,
  key: string,
): string | null {
  let best: { at: string; text: string } | null = null;
  for (const row of rowsOf(published)) {
    const p = payloadOf(row);
    if (!p || p.kind !== SYNTHESIS_RESULT_KIND) continue;
    if ((p.sequence_id ?? '') !== (sequenceId ?? '')) continue;
    if ((p.result_key ?? '') !== key) continue;
    const text = typeof p.text === 'string' ? p.text.trim() : '';
    if (!text) continue;
    const at = typeof p.produced_at === 'string' ? p.produced_at : '';
    if (!best || at > best.at) best = { at, text };
  }
  return best?.text ?? null;
}
