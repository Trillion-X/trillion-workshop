// do-work/read-published-clips-run.mjs: the export tool:read-published-clips runs through records-door's run-an-export.mjs, which calls
// readPublishedClips(input, { door }). The fenced select runs in the named database as the use the caller sends (input.use, set by the
// site route from its own whitelist: publish/site or members/members). The engine's under_use mount hands the reader login and the use
// ticket for that use (run-sql-in-my-database: descriptors 4 and 5). Each row's names are then shared BY NAME, one short-lived
// share_file each, through the files right the row stores (/published-clips/ only). The answer is clips with their URLs; no
// identity, name, key or path is answered.
//   single clip or reel: cut_url (the file) and picture_url (its cover, <id>.jpg)
//   comparison: cut_url (the combined render, played on tap across the card) and pair.left/right.picture_url (each side's still)
import { readFileSync } from 'node:fs';
import { CLIPS_SQL, clipsOf, clipsParams, clipsRequest } from '../read-data/clips-query.mjs';

const CONNECTION_DESCRIPTOR = 4;
const TICKET_DESCRIPTOR = 5;
// Each link is short: a page load asks again after this, and no link lasts past it.
export const LINK_SECONDS = 900;
// Links are asked for a few at a time, so one page load does not hold the Files session.
const AT_ONCE = 4;

const held = descriptor => {
  try { return readFileSync(descriptor, 'utf8').trim(); } catch { return ''; }
};

// Every name a clip's answer needs: its file, and its cover or its two still names.
function namesOf(clip) {
  return clip.still_names ? [clip.file_name, clip.still_names.left, clip.still_names.right] : [clip.file_name, clip.cover_name];
}

// The share of each name: one files call each, the link the Files session answers (url, expires_at).
async function linksFor(names, door) {
  const links = new Map();
  for (let at = 0; at < names.length; at += AT_ONCE) {
    const batch = names.slice(at, at + AT_ONCE);
    const answers = await Promise.all(batch.map(name => door.files('share_file', { name_or_identity: name, seconds: LINK_SECONDS })));
    batch.forEach((name, index) => {
      const url = answers[index]?.url;
      if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('The Files session gave no link for a clip.');
      links.set(name, url);
    });
  }
  return links;
}

// The clips the site shows, with their links. `runQuery` is the database read (run-sql's runSql in the container, a test's own here);
// `door` is the run's door.
export async function readPublishedClips(input, { door, runQuery } = {}) {
  if (typeof input?.database !== 'string' || input.database === '') throw new Error('Give database: the name of the pursuit database the clips are in.');
  if (!input.use || typeof input.use !== 'object' || typeof input.use.purpose !== 'string' || typeof input.use.surface !== 'string') {
    throw new Error('Give use: { purpose, surface }, the use the clips are shown for.');
  }
  const request = clipsRequest({ purpose: input.use.purpose, surface: input.use.surface, kind: input.kind, limit: input.limit });
  const query = runQuery ?? (async () => (await import('/opt/run-sql-in-my-database/do-work/run-sql.mjs')).runSql({
    connection: held(CONNECTION_DESCRIPTOR),
    ticket: held(TICKET_DESCRIPTOR),
    input: { database: input.database, sql: CLIPS_SQL, params: clipsParams(request), use: { purpose: request.purpose, surface: request.surface } },
  }));
  const { rows } = await query(CLIPS_SQL);
  const clips = clipsOf(rows);
  const links = await linksFor(clips.flatMap(namesOf), door);
  return {
    clips: clips.map(clip => ({
      id: clip.id,
      moment: clip.moment,
      kind: clip.kind,
      aspect: clip.aspect,
      captured_day: clip.captured_day,
      cut_url: links.get(clip.file_name),
      picture_url: clip.cover_name ? links.get(clip.cover_name) : null,
      ...(clip.still_names ? { pair: {
        left: { person: clip.pair.left.person ?? null, day: clip.pair.left.day ?? null, picture_url: links.get(clip.still_names.left) },
        right: { person: clip.pair.right.person ?? null, day: clip.pair.right.day ?? null, picture_url: links.get(clip.still_names.right) },
      } } : {}),
    })),
  };
}
