// src/work-media.mjs
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
//   1. The person's own page session is established by the Worker before this handler runs; each read uses that person's
//      store, never an id or account supplied by the page.
//   2. A write is accepted only from the service's own origin.
//   3. Library rows and search results are read-only; the only write is the store's next-edit action.
//   4. Saving or rendering an edit keeps each of its clips as edited on the Recent screen; a file use names only a file
//      the person keeps and a word, and the store stamps its time (src/recent-files.mjs).

const json = (value, status = 200) => Response.json(value, { status });
import { PERSON_APP } from './activity.mjs';
import { searchOptions } from './search.mjs';
import { mediaLibraryQuery } from './media-library.mjs';
import liveWords from './live-words.json' with { type: 'json' };
import { handleMediaEditor, isMediaEditorPath, startedRunAnswer } from './work-media-editor.mjs';
import { handleMediaSession, isMediaSessionPath } from './work-media-session.mjs';
import { layerSourcesAreFiles } from '../parts/media-composition/read-data/layers-to-edit.mjs';
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

// Every clip of an edit, once each, kept as edited on the person's Recent screen.
const markEdited = (person, clips) => Promise.all([...new Set(clips.map(clip => clip.identity))].map(file => person.recordFileUse({ file, kind: 'edited' }).catch(() => null)));

/** The Media screen's own routes, bound to the already-authenticated person's store. */
export async function handleWorkMedia(request, { person, userId, origin, url, env, startLiveWords, runTool }) {
  // Sending a saved edit to the person's own video editor and attaching what they exported (src/work-media-editor.mjs).
  if (isMediaEditorPath(url.pathname)) return handleMediaEditor(request, { person, userId, origin, url, runTool });
  // The edit's logged session, its published versions and its track check (src/work-media-session.mjs).
  if (isMediaSessionPath(url.pathname)) return handleMediaSession(request, { person, userId, origin, url });
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
  if (url.pathname === LIBRARY) {
    if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
    try {
      const { known, page } = mediaLibraryQuery(url.searchParams);
      return json(await person.mediaLibrary(known, page));
    } catch (error) { return json({ error: error.message, ...(typeof error.code === 'string' ? { code: error.code } : {}) }, Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 400); }
  }

  if (url.pathname === SEARCH) {
    if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
    return json(await person.search(url.searchParams.get('q') ?? '', searchOptions(url.searchParams)));
  }

  if (url.pathname === RECENT) {
    if (request.method === 'GET') return json(await person.recentFiles({ limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }));
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    if (request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
    try { return json(await person.recordFileUse(await request.json().catch(() => null))); }
    catch (error) { return json({ error: error.message }, 400); }
  }

  if (url.pathname === NEXT_EDIT) {
    if (request.method === 'GET') return json(await person.mediaNextEditRead());
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    if (request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
    const input = await request.json().catch(() => null);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: 'Send the Media action as an object.' }, 400);
    return json(await person.mediaNextEditAct(input));
  }

  if (url.pathname === EDIT) {
    const id = url.searchParams.get('id');
    if (request.method === 'GET') {
      if (!id || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) return json({ error: 'Choose an edit.' }, 400);
      const spaceId = url.searchParams.get('space_id');
      if (spaceId) {
        const answer = await person.fetch(new Request(`https://person/spaces/${encodeURIComponent(spaceId)}/records/${encodeURIComponent(`shared:media-edit:${id}`)}`));
        const record = await answer.json().catch(() => ({}));
        return new Response(JSON.stringify(record), { status: answer.status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } });
      }
      return json({ edit: (await person.fact(`media_edit:${id}`)) ?? null });
    }
    if (request.method === 'DELETE') {
      if (request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
      const spaceId = url.searchParams.get('space_id');
      const expectedRaw = url.searchParams.get('expected_revision');
      const expectedRevision = expectedRaw === null ? NaN : Number(expectedRaw);
      if (!id || !/^[a-zA-Z0-9-]{1,80}$/.test(id) || !spaceId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return json({ error: 'Choose a shared edit and its current revision.' }, 400);
      const answer = await person.fetch(new Request(`https://person/spaces/${encodeURIComponent(spaceId)}/records/${encodeURIComponent(`shared:media-edit:${id}`)}`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_revision: expectedRevision }),
      }));
      const result = await answer.json().catch(() => ({}));
      if (!answer.ok) return new Response(JSON.stringify(result), { status: answer.status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } });
      if (!result.swapped) return json({ error: 'A teammate changed this edit first. Load their version before removing it.', conflict: result }, 409);
      return json({ removed: true, revision: result.revision });
    }
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    if (request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
    const input = await request.json().catch(() => null);
    if (!validEdit(input)) return json({ error: 'The edit needs clips with a source and valid start and end times.' }, 400);
    if (typeof input.space_id === 'string' && input.space_id) {
      if (input.expected_revision !== null && (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0)) return json({ error: 'The shared edit revision is not valid.' }, 400);
      if (!Object.hasOwn(input, 'expected_revision')) return json({ error: 'Read the current shared edit revision before saving.' }, 400);
      const { space_id: spaceId, expected_revision: expectedRevision, ...value } = input;
      const checked = await resolveSharedFiles(person, spaceId, value.edl, value.shared_files,
        { metadataOnly: typeof person.sharedFileSource === 'function' });
      const clips = value.clips.map(clip => {
        const itemId = checked.itemIds.get(clip.identity);
        if (!itemId || (clip.shared_item_id !== undefined && clip.shared_item_id !== itemId)) throw new Error('A shared clip no longer matches the file shared with this project. Save the edit again.');
        return { ...clip, bytes: `/work/api/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}/bytes`, shared_item_id: itemId };
      });
      value.clips = clips;
      const answer = await person.fetch(new Request(`https://person/spaces/${encodeURIComponent(spaceId)}/records/${encodeURIComponent(`shared:media-edit:${input.id}`)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_revision: expectedRevision, value }),
      }));
      const result = await answer.json().catch(() => ({}));
      if (!answer.ok) return new Response(JSON.stringify(result), { status: answer.status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } });
      if (!result.swapped) return json({ error: 'A teammate saved this edit first. Load their version before saving again.', conflict: result }, 409);
      await markEdited(person, input.clips);
      return json({ saved: true, revision: result.revision });
    }
    // The store is reached over RPC: both the read above and this write answer promises, awaited so a saved edit restores.
    await person.setFact(`media_edit:${input.id}`, { title: input.title, clips: input.clips, ratio: input.ratio ?? null, file: input.file ?? null, ...(input.captions ? { captions: input.captions } : {}), ...(input.textOverlays ? { textOverlays: input.textOverlays } : {}), ...(input.edl ? { edl: input.edl } : {}), ...(input.panels ? { panels: input.panels } : {}), saved_at: new Date().toISOString() });
    await markEdited(person, input.clips);
    return json({ saved: true });
  }

  if (url.pathname === RENDER) {
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    if (request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
    if (typeof userId !== 'string' || !userId) return json({ error: 'Sign in to render this edit.' }, 401);
    const input = await request.json().catch(() => null);
    if (!validEdit(input)) return json({ error: 'The edit needs clips with a source and valid start and end times.' }, 400);
    const size = FRAME_SIZES[input.ratio];
    const sourceEdl = typeof input.space_id === 'string' && input.space_id
      ? await sharedSourcesForRender(person, input.space_id, input.edl, input.shared_files, input.clips)
      : input.edl ?? {};
    await markEdited(person, input.clips);
    const edl = { ...sourceEdl, ...(size ? { encode: { width: size[0], height: size[1] } } : {}), spine: { segments: input.clips.map((clip, index) => ({ ...segmentExtras(input.edl?.spine?.segments?.[index], clip), kind: 'clip', id: `clip-${index}`, source: typeof input.space_id === 'string' && input.space_id ? sourceEdl?.spine?.segments?.[index]?.source : clip.identity, in: clip.start, out: clip.end, ...(clip.look_stack ? { look_stack: clip.look_stack } : {}) })) } };
    return startedRunAnswer(runTool({ tool_id: 'tool:render-an-edit', input: { edl }, request_key: `media-render:${input.id}:${crypto.randomUUID()}`, wait_seconds: 0 }, { app: PERSON_APP, owner: userId }));
  }

  // The words said in one recording: the account's own transcription tool, run as the person's page, then read by task.
  if (url.pathname === TRANSCRIBE) {
    if (typeof userId !== 'string' || !userId) return json({ error: 'Sign in to transcribe recordings.' }, 401);
    const headers = { 'content-type': 'application/json', 'x-trillion-app': PERSON_APP, 'x-trillion-user': userId };
    if (request.method === 'GET') {
      // Whether the transcription a rule started by itself for this recording is still working or failed for good
      // (src/automations.mjs watchedRun): { run: { state, attempt, max_attempts } | null }.
      const recording = url.searchParams.get('identity');
      if (recording !== null) {
        if (!/^1f:[0-9a-f]{64}$/.test(recording)) return json({ error: 'Choose a recording that is uploaded.' }, 400);
        const asked = new URLSearchParams({ field: 'identity', value: recording });
        const answer = await person.fetch(new Request(`https://person/automations/watched-run?${asked}`, { headers }));
        const read = await answer.json().catch(() => ({}));
        if (!answer.ok) return json({ error: read.error ?? 'The transcription could not be read.' }, answer.status);
        const run = read.run ? { state: read.run.state, attempt: read.run.attempt, max_attempts: read.run.max_attempts } : null;
        return json({ run });
      }
      const task = url.searchParams.get('task') ?? '';
      if (!/^task_[0-9a-f]{1,64}$/.test(task)) return json({ error: 'Choose a transcription.' }, 400);
      const answer = await person.fetch(new Request(`https://person/tasks/${encodeURIComponent(task)}`, { headers }));
      return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } });
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

async function sharedSourcesForRender(person, spaceId, edl, sharedFiles, clips) {
  // An execution-owned shared-file host keeps the stable grant coordinates in
  // the queued task. Its Workshop preflight opens actual bytes only when run.
  const stable = typeof person.sharedFileSource === 'function';
  const { itemIds, urls } = await resolveSharedFiles(person, spaceId, edl, sharedFiles, { needUrls: !stable, metadataOnly: stable });
  for (const clip of clips) {
    const itemId = itemIds.get(clip.identity);
    if (!itemId || (clip.shared_item_id !== undefined && clip.shared_item_id !== itemId)) throw new Error('A shared clip no longer matches the file shared with this project. Save the edit again.');
  }
  const replace = value => {
    if (typeof value === 'string') return stable && itemIds.has(value)
      ? person.sharedFileSource(value, { space_id: spaceId, item_id: itemIds.get(value) })
      : urls.get(value) ?? value;
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, replace(part)]));
    return value;
  };
  return replace(edl);
}

/** Verify every saved identity/item pair through the Space file owner. Caller-supplied maps and bytes are only hints. */
async function resolveSharedFiles(person, spaceId, edl, sharedFiles, { needUrls = false, metadataOnly = false } = {}) {
  if (typeof spaceId !== 'string' || !spaceId || !edl || typeof edl !== 'object' || Array.isArray(edl) || !sharedFiles || typeof sharedFiles !== 'object' || Array.isArray(sharedFiles)) throw new Error('This shared edit has no valid Space file map. Save it again before rendering.');
  const entries = Object.entries(sharedFiles);
  if (!entries.length || entries.length > 200 || entries.some(([identity, itemId]) => !/^1f:[0-9a-f]{64}$/.test(identity) || typeof itemId !== 'string' || !itemId || itemId.length > 200)) throw new Error('This shared edit has an invalid Space file map. Save it again before rendering.');
  const itemIds = new Map(entries);
  const identities = [...new Set([...fileIdentities(edl), ...entries.map(([identity]) => identity)])];
  if (fileIdentities(edl).some(identity => !itemIds.has(identity))) throw new Error('A source in this edit is no longer shared with the project. Save the edit again.');
  const resolved = await Promise.all(identities.map(async identity => {
    const itemId = itemIds.get(identity);
    const answer = await person.fetch(new Request(`https://person/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}/file${metadataOnly ? '?metadata=only' : ''}`));
    const found = await answer.json().catch(() => ({}));
    if (!answer.ok || found.identity !== identity || (needUrls && (typeof found.url !== 'string' || !found.url.startsWith('https://')))) throw new Error(typeof found.error === 'string' ? found.error : 'A shared source could not be opened for rendering.');
    return [identity, { itemId, ...(needUrls ? { url: found.url } : {}) }];
  }));
  const files = new Map(resolved);
  return { itemIds: new Map([...files].map(([identity, file]) => [identity, file.itemId])), urls: new Map([...files].flatMap(([identity, file]) => file.url ? [[identity, file.url]] : [])) };
}

function fileIdentities(value) {
  if (typeof value === 'string') return /^1f:[0-9a-f]{64}$/.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(fileIdentities);
  if (value && typeof value === 'object') return Object.values(value).flatMap(fileIdentities);
  return [];
}
