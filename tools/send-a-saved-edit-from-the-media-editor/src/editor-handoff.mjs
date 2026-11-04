// src/editor-handoff.mjs
//
// PURPOSE
//   A person's saved edit goes to their own video editor, and the video they export there comes back to the edit.
//     send            the saved edit (media_edit:<id>, written by /work/api/media/edit) runs through the existing
//                     installed-app owner with admitted mounted Namespace inputs and a saved Filmcraft project.
//     status          follows that exact account-owned job; queued does not mean a saved project exists.
//     attachFinished  a video in their Files becomes the edit's finished version (media_edit_finished:<id>).
//   Both are account tools (records/workshop-account-tool-records.json, run by src/person-store.mjs accountActions),
//   so the editor's Send to editor panel and every AI do the same thing.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Filmcraft writes its own project through declared commands; nothing here builds or relabels XML.
//   2. A clip is named by a name it has in the person's Files, under the folder the person says their files appear
//      in; a clip with no name there is refused in words, never guessed or left out.
//   3. Unsupported composition changes are refused in words before an app job starts; saved edits stay intact.
//   4. Editor and speed choices are DATA (editor-handoff.json); the app-job adapter owns composition translation.
//   5. Only the named edit is read or changed, and only through the injected store reads and writes.
import settings from './editor-handoff.json' with { type: 'json' };
import { filmcraftEditJob } from '../parts/media-composition/do-work/filmcraft-edit-job.mjs';
import { sharedReference } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/live-namespace/do-work/shared-file-reference.mjs';

const IDENTITY = /^(1f|12):[0-9a-f]{64}$/;
const EDIT_ID = /^[a-zA-Z0-9-]{1,80}$/;

export const editorHandoffSettings = settings;

/** The edit id an input names: the id itself, or the name of its saved file (/edits/<id>.json). */
export function editIdOf(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const fromName = /^\/edits\/([a-zA-Z0-9-]{1,80})\.json$/.exec(text)?.[1];
  const id = fromName ?? text;
  if (!EDIT_ID.test(id)) throw new Error('Name the edit: its id, or the name of its saved file such as /edits/<id>.json.');
  return id;
}

/**
 * store: { readFact(name), writeFact(name, value), locate(identity) → file row with names, byName(name) → file row,
 *          runJob(request) → task, readJob(task_id) → that account's current task }
 */
export function editorHandoff(store, { now = () => new Date() } = {}) {
  const savedEdit = id => {
    const edit = store.readFact(`media_edit:${id}`);
    if (!edit) throw new Error('This edit is not saved yet. Save it, then send it again.');
    return edit;
  };

  async function status(input) {
    const id = editIdOf(input);
    const sent = store.readFact(`media_edit_handoff:${id}`);
    if (!sent) return null;
    const task = await store.readJob(sent.task_id);
    if (!task || task.task_id !== sent.task_id || task.tool_id !== 'tool:run-an-app-job') throw new Error('The Filmcraft job could not be read.');
    if (task.state === 'failed' || task.state === 'canceled') return { ...sent, state: task.state, said: task.error ?? 'Filmcraft did not finish this edit.' };
    if (task.state !== 'completed') return { ...sent, state: task.state, said: task.state === 'running' ? 'Filmcraft is preparing this project on your computer.' : 'Your Filmcraft project is waiting to run on your computer.' };
    const project = task.output?.files?.find(file => file.key === 'project');
    if (task.output?.ok !== true || task.output.app !== 'filmcraft' || !project || !IDENTITY.test(project.identity ?? '') || typeof project.name !== 'string' || !project.name.endsWith('.fcproj')) throw new Error(task.output?.said ?? 'Filmcraft did not save a project for this edit.');
    return { ...sent, state: 'completed', file: { identity: project.identity, name: project.name, bytes: project.bytes }, said: 'Your Filmcraft project is saved in Files. Open it in Filmcraft to continue editing.' };
  }

  async function send(input = {}, { requestKey } = {}) {
    const id = editIdOf(input.edit);
    const editor = settings.editors.find(row => row.id === (input.editor ?? settings.editors[0].id));
    if (!editor) throw new Error(`Choose an editor: ${settings.editors.map(row => row.id).join(' or ')}.`);
    const rate = settings.frame_rates.find(row => row.value === Number(input.frame_rate ?? settings.frame_rates.find(item => item.default)?.value));
    if (!rate) throw new Error(`Choose a timeline speed: ${settings.frame_rates.map(row => row.value).join(', ')} frames a second.`);
    const edit = savedEdit(id);
    const prepared = filmcraftEditJob({ title: edit.title, edl: edit.edl, captions: edit.captions, textOverlays: edit.textOverlays, frameRate: rate.value });
    for (const file of prepared.job.files.inputs) {
      const identity = file.identity;
      const reference = sharedReference(file);
      if (reference) {
        if (typeof store.sharedFile !== 'function') throw new Error('This shared clip could not be opened with your current company access.');
        const row = await store.sharedFile(reference);
        if (!row || row.error || row.identity !== identity || !Number.isSafeInteger(row.byte_length) || row.byte_length < 0) throw new Error('This shared clip is missing or has changed.');
        file.byte_length = row.byte_length;
        continue;
      }
      const row = await store.locate(identity);
      const name = row?.names?.[0];
      if (!name) throw new Error('A clip in this edit has no name in your Files, so your editor could not find it. Give it a name in Files, then send again.');
      if (row.identity !== identity) throw new Error('A clip in this edit is missing or has changed.');
      file.name = name;
      if (Number.isSafeInteger(row.byte_length) && row.byte_length >= 0) file.byte_length = row.byte_length;
    }
    if (typeof requestKey !== 'string' || !requestKey) throw new Error('Send this edit with a request key so retries keep the same job.');
    const task = await store.runJob({ tool_id: 'tool:run-an-app-job', input: prepared.job, request_key: `filmcraft-edit:${requestKey}`, wait_seconds: 0 });
    if (!task?.task_id) throw new Error('Filmcraft did not accept this job.');
    store.writeFact(`media_edit_handoff:${id}`, { edit: id, editor: editor.label, task_id: task.task_id, open_steps: editor.open_steps, left_out: [], clips: prepared.clips, seconds: prepared.seconds });
    return status(id);
  }

  async function attachFinished(input = {}) {
    const id = editIdOf(input.edit);
    savedEdit(id);
    const asked = typeof input.file === 'string' ? input.file.trim() : '';
    const row = asked.startsWith('/') ? await store.byName(asked) : IDENTITY.test(asked) ? await store.locate(asked) : null;
    if (!row) throw new Error('Choose the finished video by its name in your Files or its identity.');
    if (!/^video\//i.test(row.media_type ?? '')) throw new Error('The finished version must be a video.');
    const finished = {
      identity: row.identity,
      name: asked.startsWith('/') ? asked : row.names?.[0] ?? null,
      media_type: row.media_type,
      byte_length: row.byte_length ?? null,
      attached_at: now().toISOString(),
    };
    store.writeFact(`media_edit_finished:${id}`, finished);
    return { edit: id, finished, said: `${finished.name ?? 'The video'} is now this edit's finished version.` };
  }

  /** The edit's finished version, or null. */
  const finishedOf = input => store.readFact(`media_edit_finished:${editIdOf(input)}`) ?? null;

  return { send, status, attachFinished, finishedOf };
}
