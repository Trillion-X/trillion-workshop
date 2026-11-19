// tools/show-the-media-library-and-search-what-was/do-work/answer-the-media-page.mjs
// (old trillion src/work-media.mjs at tag old-trillion-before-worker-retire; imports name this repository's copies,
// the /search branch is left to its own route tool and the /media/library branch to the Namespace's owner. The route tool that runs it is at the end of this file.)
//
// PURPOSE
//   The signed-in Media screen's reads and suggestion actions, using the same person's store the AI-facing tools use.
//   The screen asks for the library, searches its recordings, and changes the next-edit suggestion; the store owns the
//   rows, search and choice state.
//
//   GET  /work/api/media/library?revision=<known>  the rows, or only that nothing changed
//   GET  /work/api/search?q=<words>&places=&sources=  the one search (src/search.mjs): things with where they matched
//   GET  /work/api/media/next-edit                 the next suggestion
//   POST /work/api/media/next-edit                 another, not now, choose a destination, or start the edit
//   GET  /work/api/recent-files?limit=&before=     the files the person used, newest first (src/recent-files.mjs)
//   POST /work/api/recent-files                    keep that a file was used: { file, kind }
//   POST /work/api/media/transcribe {identity, language?}  start tool:transcribe-file on one recording; GET ?task=<id> reads that run
//   GET /work/api/media/transcribe?identity=<1f:>  whether the transcription started by itself for that recording is
//                                                   still working or failed for good ({ run: { state, attempt, max_attempts } | null })
//   /work/api/media/send-to-editor, /work/api/media/finished   a saved edit to Premiere or Resolve and back (src/work-media-editor.mjs)
//
// NON-NEGOTIABLE INVARIANTS
//   1. The route reads no store. What it needs from the person's store (the library, Recent, the next edit, a shared project,
//      a transcription run) answers 503 with words that name it, and the caller hands in what it reads.
//   2. A write is accepted only from the service's own origin.
//   3. Library rows and search results are read-only; a saved edit is answered, not stored.
//   4. Saving or rendering an edit keeps each of its clips as edited on the Recent screen; a file use names only a file
//      the person keeps and a word, and the store stamps its time (src/recent-files.mjs).

const json = (value, status = 200) => Response.json(value, { status });
import { PERSON_APP } from '../../shared-code/src/activity.mjs';
import liveWords from '../../show-live-words-while-recording/src/live-words.json' with { type: 'json' };
import { handleMediaEditor, isMediaEditorPath, startedRunAnswer } from '../../send-a-saved-edit-from-the-media-editor/src/work-media-editor.mjs';
import { handleMediaSession, isMediaSessionPath } from '../../keep-the-media-editors-open-session-its-published/src/work-media-session.mjs';
import { layerSourcesAreFiles } from '../../media-composition/read-data/layers-to-edit.mjs';
const LIBRARY = '/work/api/media/library';
const SEARCH = '/work/api/search';
const NEXT_EDIT = '/work/api/media/next-edit';
const EDIT = '/work/api/media/edit';
const RENDER = '/work/api/media/render';
const RECENT = '/work/api/recent-files';
const TRANSCRIBE = '/work/api/media/transcribe';
const LIVE_WORDS = '/work/api/media/live-words';
const FRAME_SIZES = { '16:9': [1920, 1080], '9:16': [1080, 1920], '4:5': [1080, 1350], '1:1': [1080, 1080] };

export const isWorkMediaPath = path => [LIBRARY, SEARCH, NEXT_EDIT, EDIT, RENDER, TRANSCRIBE, LIVE_WORDS, RECENT].includes(path) || isMediaEditorPath(path) || isMediaSessionPath(path);

// Every clip of an edit, once each, kept as edited on the person's Recent screen: the use is answered for the caller to record.
const markEdited = (fileUses, clips) => { for (const file of new Set(clips.map(clip => clip.identity))) fileUses.push({ file, kind: 'edited' }); };

/** The Media screen's own routes. Nothing is read from a store here: what a route needs from one answers 503 with words. */
export async function handleWorkMedia(request, { fileUses, userId, origin, url, env, startLiveWords, runTool, edit }) {
  // Sending a saved edit to the person's own video editor and attaching what they exported (src/work-media-editor.mjs).
  if (isMediaEditorPath(url.pathname)) throw new Unreachable('The hand-off of a saved edit to the video editor');
  // The edit's logged session, its published versions and its track check (src/work-media-session.mjs).
  if (isMediaSessionPath(url.pathname)) throw new Unreachable('The logged session and published versions of an edit');
  if (url.pathname === LIVE_WORDS) {
    if (!userId) return json({ error: 'Sign in to see your words while recording.' }, 401);
    if (request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Open this as a live recording.' }, 426);
    const sampleRate = Number(url.searchParams.get('sample_rate'));
    if (!Number.isInteger(sampleRate) || sampleRate < liveWords.sample_rate.min || sampleRate > liveWords.sample_rate.max) return json({ error: 'This microphone sample rate is not supported.' }, 400);
    if (typeof startLiveWords !== 'function') return json({ error: 'Live words are unavailable. Your recording still saves.' }, 503);
    try {
      // The call is counted and held against the account's model budget at its own records (screens:startLiveWords)
      // before the socket opens. The browser sends PCM from the selected recording stream; the model's socket is passed
      // through without keeping audio or words in this route.
      await startLiveWords(sampleRate);
      return await env.AI.run(liveWords.model, {
        encoding: 'linear16', sample_rate: String(sampleRate), mip_opt_out: 'true',
      }, { websocket: true });
    } catch {
      return json({ error: 'Live words are unavailable. Your recording still saves.' }, 503);
    }
  }
  // GET /work/api/media/library is the Namespace's own media library (old src/namespace.mjs:2131): no route here
  // reaches it, so it is not answered here (see the route tool below).
  if (url.pathname === LIBRARY) return json({ error: 'The Media library is not reachable from this page\'s route tool yet.' }, 503);

  // GET /work/api/search is the one search's own route tool now (Trillion-X/trillion-workshop#214), not this page's.

  if (url.pathname === RECENT) {
    if (request.method === 'GET') throw new Unreachable('The files the person used (Recent)');
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    if (request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
    const used = await request.json().catch(() => null);
    if (typeof used?.file !== 'string' || !used.file) return json({ error: 'Send the file that was used: { file, kind }.' }, 400);
    fileUses.push({ file: used.file, ...(typeof used.kind === 'string' ? { kind: used.kind } : {}) });
    return json({ file: used.file, answered_for_the_caller: true });
  }

  if (url.pathname === NEXT_EDIT) {
    if (request.method === 'GET') throw new Unreachable('The next-edit suggestion');
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    if (request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
    const input = await request.json().catch(() => null);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: 'Send the Media action as an object.' }, 400);
    throw new Unreachable('The next-edit suggestion');
  }

  if (url.pathname === EDIT) {
    const id = url.searchParams.get('id');
    if (request.method === 'GET') {
      if (!id || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) return json({ error: 'Choose an edit.' }, 400);
      const spaceId = url.searchParams.get('space_id');
      if (spaceId) throw new Unreachable(`A shared project (space ${spaceId})`);
      // The saved edit is the request's `edit` (the caller read it from a store); the route keeps no edit of its own.
      return json({ edit: edit ?? null });
    }
    if (request.method === 'DELETE') {
      if (request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
      const spaceId = url.searchParams.get('space_id');
      const expectedRaw = url.searchParams.get('expected_revision');
      const expectedRevision = expectedRaw === null ? NaN : Number(expectedRaw);
      if (!id || !/^[a-zA-Z0-9-]{1,80}$/.test(id) || !spaceId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return json({ error: 'Choose a shared edit and its current revision.' }, 400);
      throw new Unreachable(`A shared project (space ${spaceId})`);
    }
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    if (request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
    const input = await request.json().catch(() => null);
    if (!validEdit(input)) return json({ error: 'The edit needs clips with a source and valid start and end times.' }, 400);
    if (typeof input.space_id === 'string' && input.space_id) {
      if (input.expected_revision !== null && (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0)) return json({ error: 'The shared edit revision is not valid.' }, 400);
      if (!Object.hasOwn(input, 'expected_revision')) return json({ error: 'Read the current shared edit revision before saving.' }, 400);
      throw new Unreachable(`A shared project (space ${input.space_id})`);
    }
    // The checked edit is the answer: the caller stores it. Nothing is kept here.
    markEdited(fileUses, input.clips);
    return json({ edit: { id: input.id, title: input.title, clips: input.clips, ratio: input.ratio ?? null, file: input.file ?? null, ...(input.captions ? { captions: input.captions } : {}), ...(input.textOverlays ? { textOverlays: input.textOverlays } : {}), ...(input.edl ? { edl: input.edl } : {}), ...(input.panels ? { panels: input.panels } : {}), saved_at: new Date().toISOString() } });
  }

  if (url.pathname === RENDER) {
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    if (request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
    if (typeof userId !== 'string' || !userId) return json({ error: 'Sign in to render this edit.' }, 401);
    const input = await request.json().catch(() => null);
    if (!validEdit(input)) return json({ error: 'The edit needs clips with a source and valid start and end times.' }, 400);
    if (typeof input.space_id === 'string' && input.space_id) throw new Unreachable(`A shared project (space ${input.space_id})`);
    const size = FRAME_SIZES[input.ratio];
    markEdited(fileUses, input.clips);
    const edl = { ...(input.edl ?? {}), ...(size ? { encode: { width: size[0], height: size[1] } } : {}), spine: { segments: input.clips.map((clip, index) => ({ ...segmentExtras(input.edl?.spine?.segments?.[index], clip), kind: 'clip', id: `clip-${index}`, source: clip.identity, in: clip.start, out: clip.end, ...(clip.look_stack ? { look_stack: clip.look_stack } : {}) })) } };
    return startedRunAnswer(runTool({ tool_id: 'tool:render-an-edit', input: { edl }, request_key: `media-render:${input.id}:${crypto.randomUUID()}`, wait_seconds: 0 }, { app: PERSON_APP, owner: userId }));
  }

  // The words said in one recording: the account's own transcription tool, run as the person's page, then read by task.
  if (url.pathname === TRANSCRIBE) {
    if (typeof userId !== 'string' || !userId) return json({ error: 'Sign in to transcribe recordings.' }, 401);
    if (request.method === 'GET') {
      // Whether the transcription a rule started by itself for this recording is still working or failed for good is kept
      // by the person's automations, which this route does not read.
      const recording = url.searchParams.get('identity');
      if (recording !== null) {
        if (!/^1f:[0-9a-f]{64}$/.test(recording)) return json({ error: 'Choose a recording that is uploaded.' }, 400);
        throw new Unreachable('The transcription a rule started for this recording');
      }
      const task = url.searchParams.get('task') ?? '';
      if (!/^task_[0-9a-f]{1,64}$/.test(task)) return json({ error: 'Choose a transcription.' }, 400);
      throw new Unreachable(`The transcription run ${task}`);
    }
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    if (request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
    const input = await request.json().catch(() => null);
    if (typeof input?.identity !== 'string' || !/^1f:[0-9a-f]{64}$/.test(input.identity)) return json({ error: 'Choose a recording that is uploaded.' }, 400);
    // A language (ISO 639-1 or 639-2 code) asks for the recording to be heard again in it.
    if (input.language !== undefined && !(typeof input.language === 'string' && /^[a-z]{2,3}$/.test(input.language))) return json({ error: 'Choose a language the recording can be heard in.' }, 400);
    return startedRunAnswer(runTool({ tool_id: 'tool:transcribe-file', input: { identity: input.identity, ...(input.language ? { language: input.language } : {}) }, request_key: `media-transcribe:${input.identity}:${crypto.randomUUID()}`, wait_seconds: 0 }, { app: PERSON_APP, owner: userId }));
  }

  return json({ error: 'Not found' }, 404);
}

/** Per-clip render choices the editor added (a look, speed, fades...) for the segment that plays this same clip.
 *  Where the clip plays from and for how long always comes from the checked clip, never from these extras. */
function segmentExtras(segment, clip) {
  if (!segment || typeof segment !== 'object' || Array.isArray(segment) || segment.source !== clip.identity) return {};
  const { kind: _kind, id: _id, source: _source, in: _in, out: _out, ...extras } = segment;
  return extras;
}

function validEdit(input) {
  return input && typeof input === 'object' && !Array.isArray(input)
    && typeof input.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(input.id)
    && typeof input.title === 'string' && input.title.length <= 200
    && (input.ratio === undefined || Object.hasOwn(FRAME_SIZES, input.ratio))
    && (input.panels === undefined || (input.panels && typeof input.panels === 'object' && !Array.isArray(input.panels) && JSON.stringify(input.panels).length <= 200000))
    && (input.edl === undefined || (input.edl && typeof input.edl === 'object' && !Array.isArray(input.edl) && JSON.stringify(input.edl).length <= 1500000 && layerSourcesAreFiles(input.edl)))
    && [input.captions, input.textOverlays].every(rows => rows === undefined || (Array.isArray(rows) && rows.length <= 1000 && rows.every(row => row && typeof row.text === 'string' && row.text.length <= 10000 && Number.isFinite(row.start) && row.start >= 0 && Number.isFinite(row.end) && row.end > row.start)))
    && Array.isArray(input.clips) && input.clips.length > 0 && input.clips.length <= 200
    && input.clips.every(clip => clip && typeof clip.identity === 'string' && /^1f:[0-9a-f]{64}$/.test(clip.identity)
      && Number.isFinite(clip.start) && clip.start >= 0 && Number.isFinite(clip.end) && clip.end > clip.start
      && (clip.look_stack === undefined || (typeof clip.look_stack === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(clip.look_stack)))
      && typeof clip.bytes === 'string' && clip.bytes.length <= 4096);
}

// ---------------------------------------------------------------------------------------------------------------------
// tool:answer-the-media-page: the Media page's routes as a @workshop-routes tool (input { path, method, query, body,
// browser, edit }, result { status, body, file_uses? }). It reads and keeps nothing itself:
//   - the edit a GET asks for is the request's `edit` (the caller read it from a store), and a POST answers the checked
//     edit as { edit } for the caller to store;
//   - each saved clip kept as edited on Recent, and each file a route records as used, is answered as file_uses ({ file, kind }),
//     for the caller to record;
//   - what needs the person's store, a shared project, a Workshop run or the Namespace's owners is not reachable from
//     this run: such a request answers 503 with words that name what it needs, never a made-up answer.
// The engine's door admits the page before this runs, so the origin the handler checks is the one it is given.
const ORIGIN = 'https://person.local';
export class Unreachable extends Error {
  constructor(what) { super(`${what} is not reachable from this page's route tool yet.`); this.status = 503; }
}

export async function answerTheMediaPage(input) {
  const { path = '', method = 'GET', query = {}, body, edit } = input !== null && typeof input === 'object' ? input : {};
  const search = new URLSearchParams(query !== null && typeof query === 'object' ? query : {}).toString();
  const url = new URL(`/work/api${path}${search ? `?${search}` : ''}`, ORIGIN);
  const request = new Request(url, { method, headers: { origin: ORIGIN, 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }) });
  const fileUses = [];
  try {
    const response = await handleWorkMedia(request, { fileUses, userId: 'this-account', origin: ORIGIN, url, edit,
      runTool: async () => { throw new Unreachable('Running another Workshop tool'); } });
    return { status: response.status, body: await response.json(), ...(fileUses.length ? { file_uses: fileUses } : {}) };
  } catch (error) {
    if (error instanceof Unreachable) return { status: 503, body: { error: error.message } };
    throw error;
  }
}
