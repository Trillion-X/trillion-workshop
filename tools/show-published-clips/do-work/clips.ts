// tools/show-published-clips/do-work/clips.ts
//
// PURPOSE
//   Reads the clips a pursuit has published and answers them as the props of show/ClipStrip.tsx: each clip with its still and
//   the video that plays when the still is tapped. A page and an AI app draw the same strip from the same answer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a published clip is answered, and only one with both a still and a video: a clip without its still is not drawn,
//      and a still with no video would promise a play it cannot give.
//   2. Clips are answered in position order (ties by id), at most `limit` (24 by default, 1 to 100).
//   3. The table and column names are the one block below; nothing else here names a table.
//   4. Nothing here holds a login or a client: the reader is handed `rows` by run-sql-in-my-database/do-work/serve-a-read.ts.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serveARead, type Rows } from '../../run-sql-in-my-database/do-work/serve-a-read.ts';

// The one place the table and its columns are named.
const SOURCE = {
  table: 'clips',
  columns: ['id', 'position', 'title', 'still', 'video', 'published', 'published_at'],
} as const;

export const DEFAULT_LIMIT = 24;
export const MOST = 100;

export type Clip = { id: string; position: number; title: string; still: string; video: string };
export type Clips = { clips: Clip[] };
export type ClipsInput = { database: string; limit?: number; use?: { purpose: string; surface: string } };

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function limitOf(asked: unknown): number {
  if (asked === undefined || asked === null) return DEFAULT_LIMIT;
  if (!Number.isInteger(asked) || (asked as number) < 1 || (asked as number) > MOST) throw new Error(`limit must be a whole number from 1 to ${MOST}.`);
  return asked as number;
}

// The clips the rows hold that may be shown, in position order.
export function clipsOf(rows: Record<string, unknown>[], limit: number = DEFAULT_LIMIT): Clips {
  const shown = rows
    .filter(row => row.published === true && text(row.still) !== '' && text(row.video) !== '')
    .map((row, index): Clip => ({ id: text(row.id), position: Number(row.position ?? index), title: text(row.title), still: text(row.still), video: text(row.video) }))
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  return { clips: shown.slice(0, limit) };
}

export async function readClips(input: ClipsInput, rows: Rows): Promise<Clips> {
  const limit = limitOf(input.limit);
  return clipsOf(await rows(`select ${SOURCE.columns.join(', ')} from ${SOURCE.table} where published order by position, id`), limit);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await serveARead({ readClips });
