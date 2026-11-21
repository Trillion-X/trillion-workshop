// read-data/clips-query.mjs: the one SQL that answers published clips to a surface, and the checks on the request that asks it.
//
// A published clip is a recording_moment row whose extra names the use it is published for (surfaces: { purpose, surface }).
// A published row has recording = cut = the clip's 1f: identity, with start and end blank.
// The fence is the row policy alone, consent_fence: material_allowed('recording/' || recording, start, end, run_purpose(), run_surface()).
// This query does not call material_allowed. It selects under the use the run claims (run-sql-in-my-database: the engine's ticket and
// claim_use, with purpose and surface). With no claimed use the policy answers no row.

export const KINDS = ['swing', 'comparison', 'reel'];
export const DEFAULT_LIMIT = 24;
export const MAX_LIMIT = 100;

export const CLIPS_SQL = `
SELECT id, moment, cut, picture, published_file_name, recording_name, start, "end", captured_day, extra::jsonb AS extra
  FROM recording_moment
 WHERE published_file_name IS NOT NULL
   AND moment IN ('clip', 'comparison', 'reel')
   AND extra::jsonb->'surfaces' @> jsonb_build_array(jsonb_build_object('purpose', $1::text, 'surface', $2::text))
   AND ($3::text IS NULL OR extra::jsonb->>'kind' = $3::text)
 ORDER BY captured_day DESC NULLS LAST, id
 LIMIT $4::int`;

// The request's checks: purpose and surface are the claimed use's own words, kind one of KINDS or absent, limit a whole number.
export function clipsRequest(input) {
  const asked = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (typeof asked.purpose !== 'string' || asked.purpose === '') throw new Error('Give purpose: the use the clips are shown for (publish or members).');
  if (typeof asked.surface !== 'string' || asked.surface === '') throw new Error('Give surface: where the clips are shown (site or members-page).');
  if (asked.kind !== undefined && !KINDS.includes(asked.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}.`);
  const limit = asked.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be a whole number from 1 to ${MAX_LIMIT}.`);
  return { purpose: asked.purpose, surface: asked.surface, kind: asked.kind ?? null, limit };
}

// The statement's parameters, in the order CLIPS_SQL names them.
export function clipsParams({ purpose, surface, kind, limit }) {
  return [purpose, surface, kind, limit];
}

// The Files names a clip is shared by: the publish step keeps /published-clips/<identity>.<ext> (published_file_name) and, for a
// comparison, <identity>-left.jpg and <identity>-right.jpg beside it. The site never passes a name; these come from the row only.
export function stillNamesOf(publishedFileName) {
  const base = publishedFileName.slice(publishedFileName.lastIndexOf('/') + 1);
  const identity = base.slice(0, base.lastIndexOf('.'));
  const folder = publishedFileName.slice(0, publishedFileName.lastIndexOf('/') + 1);
  return { left: `${folder}${identity}-left.jpg`, right: `${folder}${identity}-right.jpg` };
}

// A single clip or reel keeps its cover as <id>.jpg beside <id>.<ext>.
export function coverNameOf(publishedFileName) {
  const base = publishedFileName.slice(publishedFileName.lastIndexOf('/') + 1);
  const identity = base.slice(0, base.lastIndexOf('.'));
  return `${publishedFileName.slice(0, publishedFileName.lastIndexOf('/') + 1)}${identity}.jpg`;
}

// The answer rows: what a surface shows of a clip, with the Files identities the site resolves into links (never the evidence,
// the speaker or the recording's own address).
export function clipsOf(rows) {
  return rows.map(row => {
    const extra = typeof row.extra === 'string' ? JSON.parse(row.extra) : (row.extra ?? {});
    return {
      id: row.id,
      moment: row.moment,
      kind: extra.kind ?? null,
      aspect: extra.aspect ?? null,
      speed: extra.speed ?? null,
      cut: row.cut,
      file_name: row.published_file_name,
      ...(extra.pair ? { still_names: stillNamesOf(row.published_file_name) } : { cover_name: coverNameOf(row.published_file_name) }),
      picture: row.picture ?? null,
      recording_name: row.recording_name ?? null,
      start: row.start ?? null,
      end: row.end ?? null,
      captured_day: row.captured_day ?? null,
      ...(extra.pair ? { pair: extra.pair } : {}),
    };
  });
}
