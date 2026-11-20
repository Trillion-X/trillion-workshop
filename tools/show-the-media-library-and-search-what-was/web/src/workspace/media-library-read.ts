// src/workspace/media-library-read.ts
//
// PURPOSE
//   The Media screen's library, read from where the person's files owner keeps their files: one page of their media
//   files (each name of a file whose media type is video, audio or picture), newest first, from their own database
//   through the SQL tool (media-library-owner.json). It answers the page in the shape the screen draws (media-screen.tsx
//   Library). It replaced GET /work/api/media/library, which nothing answers since the Worker retired.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Reading only. Nothing names a person, a folder or a kind: the kinds, the page size and the views are DATA.
//   2. A page after the first starts strictly after the last row of the one before (its time, then its name), so no
//      row is skipped or shown twice while names are added.
//   3. A read that fails throws with the tool's own words; it is never drawn as an empty library.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { runWorkshopTool } from '../../../../workspace-screens/web/src/workspace/workshop-tool-api';
import owner from './media-library-owner.json' with { type: 'json' };

type Found = { identity: string; file: string; name: string; modified_at_ms: string | number; media_type: string | null; origin: string | null; stored: boolean | string };
const SQL = `select n.identity, n.file, n.name, coalesce(n.modified_at_ms, 0) as modified_at_ms, f.media_type, f.origin,
  (f.stored_at is not null) as stored
  from ns_name n join ns_file f on f.id = n.file
  where split_part(f.media_type, '/', 1) = any($1::text[])
    and ($2::boolean is null or (f.stored_at is not null) = $2::boolean)
    and ($3::bigint is null or (coalesce(n.modified_at_ms, 0), n.name) < ($3::bigint, $4::text))
  order by coalesce(n.modified_at_ms, 0) desc, n.name desc limit $5`;

const after = (cursor: string | null | undefined): [number | null, string | null] => {
  if (!cursor) return [null, null];
  const cut = cursor.indexOf('|');
  return [Number(cursor.slice(0, cut)), cursor.slice(cut + 1)];
};

/** One page of the library for a saved view, after a page's `next_after` when given. */
export async function readMediaLibrary(view: string, nextAfter?: string | null) {
  const stored = (owner.views as Record<string, { stored?: boolean }>)[view]?.stored ?? null;
  const [time, name] = after(nextAfter);
  const ran = await runWorkshopTool<{ rows?: Found[] }>(owner.tool, { credential_name: owner.credential_name, sql: SQL, params: [owner.kinds, stored, time, name, owner.limit] });
  if (!Array.isArray(ran.result?.rows)) throw new Error(ran.error || '');
  const rows = ran.result.rows.map(found => {
    const captured = Number(found.modified_at_ms) || null;
    return {
      identity: found.identity, file: found.file, origin: found.origin ?? 'file', name: found.name.slice(found.name.lastIndexOf('/') + 1) || found.name,
      title: null, path: found.name, media_kind: found.media_type?.split('/')[0] ?? null, media_type: found.media_type,
      stored: found.stored === true || found.stored === 'true', bytes: null, captured_ms: captured, duration: null, facts: null, edits: null, words: null,
    };
  });
  const last = ran.result.rows.at(-1);
  return {
    revision: `${view}:${rows[0]?.identity ?? ''}:${rows.length}`,
    rows,
    next_after: rows.length === owner.limit && last ? `${Number(last.modified_at_ms) || 0}|${last.name}` : null,
  };
}
