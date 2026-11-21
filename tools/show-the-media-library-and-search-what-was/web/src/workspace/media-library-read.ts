// src/workspace/media-library-read.ts
//
// PURPOSE
//   The Media screen's library, read from where the person's files owner keeps their files: one page of their media
//   files, one row per file (its newest name from ns_name), newest first, from their own database through the SQL tool
//   (media-library-owner.json). Each row carries its length, the largest second a picture of it was kept at
//   (media_index_vectors). It answers the page in the shape the screen draws (media-screen.tsx Library). It replaced
//   GET /work/api/media/library, which nothing answers since the Worker retired.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Reading only. Nothing names a person, a folder or a kind: the kinds, the page size and the views are DATA.
//   2. A page after the first starts strictly after the last row of the one before (its time, then its file id), so no
//      row is skipped or shown twice while files are added. `total` counts every media file, not the page.
//   3. A read that fails throws with the tool's own words; it is never drawn as an empty library.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import owner from './media-library-owner.json' with { type: 'json' };
import { sqlRows } from './media-door';
import { noteLength } from './media-playback';

type Found = { file: string; name: string; media_type: string | null; origin: string | null; modified_at_ms: string | number; stored: boolean | string; duration: number | string | null; byte_length: number | string | null };

// The newest names first: the media files of ns_file are a hash join against ns_name (read once, in time order), so the
// page's few files are the only ones joined to their longest kept second. A name whose file is already on an earlier
// page is not drawn twice: readMediaLibrary keeps the first row of each file.
const PAGE_SQL = `with media as (
  select f.id, f.media_type, f.origin, f.stored_at, f.byte_length from ns_file f
  where split_part(f.media_type, '/', 1) = any($1::text[]) and ($2::boolean is null or (f.stored_at is not null) = $2::boolean)),
newest as (
  select n.file, n.name, coalesce(n.modified_at_ms, 0) as m from ns_name n join media f on f.id = n.file
  where ($3::bigint is null or (coalesce(n.modified_at_ms, 0), n.file) < ($3::bigint, $4::text))
  order by m desc, n.file desc limit $5)
select p.file, p.name, p.m as modified_at_ms, f.media_type, f.origin, (f.stored_at is not null) as stored, f.byte_length, d.duration
from newest p join media f on f.id = p.file
left join lateral (select max(v.at_seconds) as duration from media_index_vectors v where v.identity = p.file) d on true
order by p.m desc, p.file desc`;

// The total: its own bounded count (at most 200000 rows counted; the library is about 45000 media files).
const COUNT_SQL = `select count(*) as total from (select 1 from ns_file f
  where split_part(f.media_type, '/', 1) = any($1::text[]) and ($2::boolean is null or (f.stored_at is not null) = $2::boolean) limit 200000) c`;

const after = (cursor: string | null | undefined): [number | null, string | null] => {
  if (!cursor) return [null, null];
  const cut = cursor.indexOf('|');
  return [Number(cursor.slice(0, cut)), cursor.slice(cut + 1)];
};

const storedOf = (view: string) => (owner.views as Record<string, { stored?: boolean }>)[view]?.stored ?? null;

/** How many media files the view holds, every page counted. */
export async function countMediaLibrary(view: string): Promise<number> {
  const [counted] = await sqlRows<{ total: string | number }>(COUNT_SQL, [owner.kinds, storedOf(view)]);
  const total = Number(counted?.total);
  if (!Number.isSafeInteger(total)) throw new Error('The number of media files could not be read.');
  return total;
}

/** One page of the library for a saved view, after a page's `next_after` when given. */
export async function readMediaLibrary(view: string, nextAfter?: string | null) {
  const [time, file] = after(nextAfter);
  const [found, total] = await Promise.all([
    sqlRows<Found>(PAGE_SQL, [owner.kinds, storedOf(view), time, file, owner.limit]),
    countMediaLibrary(view),
  ]);
  // The newest row of each file is the one drawn: found is newest first.
  const firsts = new Map<string, Found>();
  for (const item of found) if (!firsts.has(item.file)) firsts.set(item.file, item);
  const rows = [...firsts.values()].map(item => {
    const captured = Number(item.modified_at_ms) || null;
    if (item.byte_length !== null) noteLength(item.file, Number(item.byte_length));
    return {
      identity: item.file, file: item.file, origin: item.origin ?? 'file', name: item.name.slice(item.name.lastIndexOf('/') + 1) || item.name,
      title: null, path: item.name, media_kind: item.media_type?.split('/')[0] ?? null, media_type: item.media_type,
      stored: item.stored === true || item.stored === 'true', captured_ms: captured,
      duration: item.duration === null ? null : Number(item.duration), facts: null, edits: null, words: null,
    };
  });
  const last = found.at(-1);
  return {
    revision: `${view}:${rows[0]?.identity ?? ''}:${rows.length}:${total}`,
    total,
    rows,
    next_after: found.length === owner.limit && last ? `${Number(last.modified_at_ms) || 0}|${last.file}` : null,
  };
}
