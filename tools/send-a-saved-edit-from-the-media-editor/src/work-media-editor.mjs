// src/work-media-editor.mjs
//
// PURPOSE
//   The media editor's Send to editor panel (src/workspace/media-edit/send-to-editor.tsx) sends a saved edit to the
//   person's own video editor and attaches the video they exported there, through this page's own session. Each write
//   runs the same account tool every AI runs (src/editor-handoff.mjs through records/workshop-account-tool-records.json),
//   so the page and the AIs cannot drift apart.
//
//   POST /work/api/media/send-to-editor  { edit, editor, files_folder, frame_rate? }  runs tool:send-edit-to-editor
//   GET  /work/api/media/finished?edit=<id>                                           the edit's finished version
//   POST /work/api/media/finished        { edit, file }                               runs tool:attach-finished-video
//
// NON-NEGOTIABLE INVARIANTS
//   1. The Worker has already established the person's page session; every read and run uses that person's store.
//   2. A write is accepted only from the service's own origin, and runs as the person's page (PERSON_APP).
//   3. The run's answer is passed on whole, with its status, so the panel shows the tool's own words.
import { PERSON_APP } from '../../see-what-my-ais-did/activity.mjs';
import { editIdOf } from './editor-handoff.mjs';

const json = (value, status = 200) => Response.json(value, { status });

/** The answer of one run started for this page: its task view, or the refusal (a sign-in or plan refusal says why). */
export async function startedRunAnswer(start) {
  try { return json(await start); }
  catch (error) {
    const refused = [401, 402, 403].includes(error.status);
    return json({ error: refused ? error.message : 'That could not be started. Try again.' }, refused ? error.status : 400);
  }
}
const SEND = '/work/api/media/send-to-editor';
const FINISHED = '/work/api/media/finished';
const TOOLS = { [SEND]: 'tool:send-edit-to-editor', [FINISHED]: 'tool:attach-finished-video' };

export const isMediaEditorPath = path => Object.hasOwn(TOOLS, path);

export async function handleMediaEditor(request, { person, userId, origin, url, runTool }) {
  if (url.pathname === SEND && request.method === 'GET') {
    try { return json({ sent: await person.editorHandoffStatus(editIdOf(url.searchParams.get('edit'))) }); }
    catch (error) { return json({ error: error.message }, 400); }
  }
  if (url.pathname === FINISHED && request.method === 'GET') {
    try { return json({ finished: (await person.fact(`media_edit_finished:${editIdOf(url.searchParams.get('edit'))}`)) ?? null }); }
    catch (error) { return json({ error: error.message }, 400); }
  }
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
  if (request.headers.get('origin') !== origin) return json({ error: 'Not allowed.' }, 403);
  if (typeof userId !== 'string' || !userId) return json({ error: 'Sign in to send this edit.' }, 401);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Send the choices as an object.' }, 400);
  const { request_key, ...input } = body;
  if (request_key !== undefined && (typeof request_key !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(request_key))) return json({ error: 'This send could not be identified. Try again.' }, 400);
  return startedRunAnswer(runTool({ tool_id: TOOLS[url.pathname], input, request_key: `media-editor:${request_key ?? crypto.randomUUID()}`, wait_seconds: 30 }, { app: PERSON_APP, owner: userId }));
}
