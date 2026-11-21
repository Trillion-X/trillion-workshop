// src/workspace/media-search.ts
//
// PURPOSE
//   The Media screen's search: what the words show, read from the person's own media index. The words are turned into a
//   picture-space vector (tool:words-as-picture-vector), the nearest kept frames are read (media_index_vectors), and the best
//   frame of each file is kept, best first. Each file answers as one result with its moment at that frame's second, in the
//   shape the screen's moments are drawn in (SearchAnswer, search-results.ts). It replaced GET /work/api/search, which
//   nothing answers since the Worker retired.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Reading only. The pool of frames read and the number of files kept are DATA (media-library-owner.json `search`).
//   2. No score cutoff: files are ranked by their best frame's score, and the best `results` of them are kept.
//   3. A failed step throws with the tool's own words; a search that failed is never drawn as "nothing found".
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import type { SearchAnswer, SearchResult } from '../../../../workspace-screens/web/src/workspace/search-results';
import owner from './media-library-owner.json' with { type: 'json' };
import { atTheDoor, sqlRows } from './media-door';
import { runWorkshopTool } from '../../../../workspace-screens/web/src/workspace/workshop-tool-api';

const PLACE = { id: 'pictures', label: 'Pictures' };
const SOURCE = { id: 'media', label: 'Media' };

// The best frame of each file among the nearest frames. The name is the file's newest name (the library's rule).
const NEAREST_SQL = `with hits as (
  select m.identity as file, m.at_seconds, 1 - (m.vec <=> $1::vector) as score
  from media_index_vectors m order by m.vec <=> $1::vector limit $2),
best as (select distinct on (file) file, at_seconds, score from hits order by file, score desc)
select b.file, b.at_seconds, b.score, n.name, f.media_type, (f.stored_at is not null) as stored,
  (select max(v.at_seconds) from media_index_vectors v where v.identity = b.file) as duration
from best b join ns_file f on f.id = b.file
left join lateral (select name from ns_name where file = b.file order by coalesce(modified_at_ms, 0) desc limit 1) n on true
order by b.score desc limit $3`;

type Nearest = { file: string; at_seconds: number | string; score: number | string; name: string | null; media_type: string | null; stored: boolean | string; duration: number | string | null };

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path;

/** The words as a picture-space vector: the one the owner's embedding tool answers for them. */
async function pictureVectorOf(question: string): Promise<number[]> {
  const ran = await atTheDoor(() => runWorkshopTool<{ vectors?: number[][] }>(owner.search.embed_tool, { texts: [question] }));
  const vector = ran.result?.vectors?.[0];
  if (!Array.isArray(vector) || !vector.length) throw new Error(ran.error || 'The words could not be turned into a picture search.');
  return vector;
}

/** The search answer for the words, one result per file, best frame first. */
export async function searchPictures(question: string): Promise<SearchAnswer> {
  const vector = await pictureVectorOf(question);
  const nearest = await sqlRows<Nearest>(NEAREST_SQL, [`[${vector.join(',')}]`, owner.search.pool, owner.search.results]);
  const results: SearchResult[] = nearest.map(hit => {
    const at = Number(hit.at_seconds);
    const score = Number(hit.score);
    const path = hit.name ?? hit.file;
    const mediaType = hit.media_type;
    const mediaKind = mediaType?.split('/')[0] ?? null;
    return {
      id: hit.file, source: SOURCE.id, source_label: SOURCE.label, kind_label: null, title: basename(path), name: basename(path), detail: null,
      identity: hit.file, file: hit.file, stored: hit.stored === true || hit.stored === 'true', bytes: null, media_kind: mediaKind, media_type: mediaType,
      duration: hit.duration === null ? null : Number(hit.duration), path, url: null, open: null, found_in: [PLACE.id],
      places: [{ place: PLACE.id, label: PLACE.label, start: at, said: null, score }],
      moments: [{ start: at, end: at, timed: true, said: null, places: [PLACE.id] }],
      start: at, end: at, timed: true, said: null, score,
    };
  });
  return { question, places: [PLACE], sources: [SOURCE], results, unavailable: [], pending: [] };
}
