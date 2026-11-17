// extension/src/page-tools.mjs
//
// PURPOSE
//   Runs a Workshop tool on the page the person is looking at, from a row in extension/page-tools.json: reading the
//   whole page (tool:read-public-web-page) or making a video of it (tool:record-a-web-demo). The tool runs on the
//   person's account through the door's Workshop operation (run_resource_operation at @tools, tools:run), on
//   Trillion's own compute; the extension never fetches the page itself. The door answers the Workshop's receipt
//   { exit_code, replayed, tool, result }, the tool's own answer in `result`; the old task view (state, output,
//   task_id) is still read when an older account answers with it.
//   Whatever the run keeps comes back as tray items (with each file's size), so the next Send carries it. The
//   background worker runs it (src/page-tool-runs.mjs), so closing the popup does not lose it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A tool is one DATA row: its tool id, its input with { "from": <fact> } where a page fact goes, how long to wait,
//      and its words. Adding a tool is one row; nothing here names a tool or a site.
//   2. Files a run keeps are already in the person's files (the tool's own outputs); they go in the tray by identity.
//      A run that returns only an answer has that answer kept as one file (the row's kept_as) and put in the tray.
//   3. A run still working after the row's wait is left running; its files reach the person's files when it ends.

/** Every { "from": fact } in `template` replaced by that fact; everything else kept as written. */
export function fillInput(template, facts) {
  if (Array.isArray(template)) return template.map(value => fillInput(value, facts));
  if (template && typeof template === 'object') {
    const keys = Object.keys(template);
    if (keys.length === 1 && keys[0] === 'from') return facts[template.from] ?? null;
    return Object.fromEntries(keys.map(key => [key, fillInput(template[key], facts)]));
  }
  return template;
}

/** Each kept file in a run's output ({ files: { name: file | file[] } }), in the order the tool listed them. */
export function keptFiles(output) {
  const files = output && typeof output === 'object' ? output.files : null;
  if (!files || typeof files !== 'object') return [];
  return Object.values(files).flatMap(value => (Array.isArray(value) ? value : [value])).filter(file => typeof file?.identity === 'string');
}

// A kept file as a tray item: its kind is the first part of its media type (video, image, audio, ...).
const itemOfFile = (file, page) => ({ kind: String(file.media_type ?? 'file').split('/')[0], file: file.identity, name: file.name, url: page.url, title: page.title ?? null, size: file.bytes ?? null });

/**
 * Runs one page tool. `call(name, args)` is the account's tool caller; `name(title, extension)` where a kept answer
 * is named. Returns { state: 'done', items } or { state: 'later', task_id }.
 */
export async function runPageTool({ row, page, call, name, requestKey = crypto.randomUUID() }) {
  const input = fillInput(row.input, { page_url: page.url, page_title: page.title ?? null });
  const answer = await call('run_resource_operation', {
    address: '@tools', method: 'tools:run', request_key: requestKey, input: { tool: row.tool_id, input },
  });
  const output = toolOutput(answer, row.tool_id);
  if (output.later) return { state: 'later', task_id: output.task_id };
  const files = keptFiles(output.value);
  if (files.length) return { state: 'done', items: files.map(file => itemOfFile(file, page)) };
  const kept = await call('write_file', { name: name(page.title ?? page.url, row.kept_as.extension), text: JSON.stringify(output.value, null, 2), media_type: row.kept_as.media_type });
  return { state: 'done', items: [{ kind: row.kept_as.kind, file: kept.identity, name: kept.name, url: page.url, title: output.value?.title || page.title || null, size: kept.byte_length ?? null }] };
}

const stopped = said => Object.assign(new Error(String(said || 'The tool stopped.')), { name: 'PageToolFailed' });

/**
 * The tool's own answer from what the door said: the Workshop receipt { exit_code, replayed, tool, result } (an
 * exit_code other than 0 is the tool stopping, in its words), or the older task view { state, output, task_id }.
 * Returns { value } or { later, task_id }; throws PageToolFailed when the tool stopped, and a plain Error when the
 * answer is neither shape (so the run can be retried with the same key).
 */
export function toolOutput(answer, toolId) {
  if (answer && typeof answer === 'object' && Number.isFinite(answer.exit_code)) {
    if (answer.exit_code !== 0 || answer.isError) throw stopped(answer.error ?? answer.result?.error ?? answer.result?.said);
    if (answer.tool !== toolId || !answer.result || typeof answer.result !== 'object' || Array.isArray(answer.result)) {
      throw new Error('Trillion did not return a complete Workshop tool run.');
    }
    return { value: answer.result };
  }
  if (answer?.state === 'failed') throw stopped(answer.error ?? answer.contract?.problems?.join(' '));
  if (answer?.state === 'completed') return { value: answer.output };
  if (typeof answer?.state === 'string') return { later: true, task_id: answer.task_id ?? null };
  throw new Error('Trillion did not return a complete Workshop tool run.');
}

/** The first recording format this browser can make, from the ordered DATA list ({ media_type, extension }). */
export const recordingFormat = (formats, canMake) => formats.find(format => canMake(format.media_type)) ?? null;
