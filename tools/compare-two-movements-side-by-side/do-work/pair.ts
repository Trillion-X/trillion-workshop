// tools/compare-two-movements-side-by-side/do-work/pair.ts
//
// PURPOSE
//   Reads the pairs of movements a pursuit has put side by side, and answers them as the props of show/SideBySide.tsx: the
//   same answer a page and an AI app's screen get. One row of the comparisons table is one pair: two videos, each with the
//   second it starts at, a title and a line of words.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every comparisons row is answered, in place order; a row is never dropped because it is old or has no caption.
//   2. A row with one clip of a pair, or with no clip at all, is refused by name, not skipped: a half pair would hide the fault. A row with neither clip but a clip_key is one video.
//   3. The table and column names are the one block below; nothing else here names a table.
//   4. Nothing here holds a login or a client: the reader is handed `rows` by run-sql-in-my-database/do-work/serve-a-read.ts.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serveARead, type Rows } from '../../run-sql-in-my-database/do-work/serve-a-read.ts';

// The one place the table and its columns are named.
const SOURCE = {
  table: 'comparisons',
  columns: ['id', 'place', 'title', 'detail', 'subject', 'reference', 'featured', 'clip_key', 'student_clip_key', 'pro_clip_key', 'student_start', 'pro_start'],
} as const;

export type Side = { label: string; video: string; start_s: number };
// A pair is two movements (left, right) or, when a row has no halves, one video that already holds both (video).
export type Pair = { id: string; place: number; title: string; caption: string; featured: boolean; left?: Side; right?: Side; video?: Side };
export type Pairs = { pairs: Pair[] };
export type PairsInput = { database: string; use?: { purpose: string; surface: string } };

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const seconds = (value: unknown): number => {
  const given = typeof value === 'string' ? Number(value) : value;
  return typeof given === 'number' && Number.isFinite(given) && given >= 0 ? given : 0;
};

function pairOf(row: Record<string, unknown>, index: number): Pair {
  const left = text(row.student_clip_key);
  const right = text(row.pro_clip_key);
  const whole = text(row.clip_key);
  const base = { id: text(row.id), place: Number(row.place ?? index), title: text(row.title), caption: text(row.detail), featured: row.featured === true };
  if (left !== '' && right !== '') {
    return { ...base, left: { label: text(row.subject), video: left, start_s: seconds(row.student_start) }, right: { label: text(row.reference), video: right, start_s: seconds(row.pro_start) } };
  }
  if (left !== '' || right !== '') throw new Error(`Comparison ${base.id} has only one of student_clip_key and pro_clip_key: a pair needs both movements, or neither and a clip_key.`);
  if (whole === '') throw new Error(`Comparison ${base.id} has no clip_key and no pair of clips: there is nothing to play.`);
  return { ...base, video: { label: '', video: whole, start_s: 0 } };
}

// The pairs the rows hold, in place order (ties by id so the order never changes between two reads).
export function pairsOf(rows: Record<string, unknown>[]): Pairs {
  const pairs = rows.map(pairOf);
  pairs.sort((a, b) => a.place - b.place || a.id.localeCompare(b.id));
  return { pairs };
}

export async function readPairs(_input: PairsInput, rows: Rows): Promise<Pairs> {
  return pairsOf(await rows(`select ${SOURCE.columns.join(', ')} from ${SOURCE.table} order by place, id`));
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await serveARead({ readPairs });
