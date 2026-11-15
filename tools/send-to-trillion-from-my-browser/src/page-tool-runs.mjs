// extension/src/page-tool-runs.mjs
//
// PURPOSE
//   The background worker runs the page tools (extension/page-tools.json `tools`: the whole page read on Trillion, a
//   video of the page made in the cloud) so a run keeps going when the popup closes, and keeps each run where every
//   view can read it (session storage `page_runs`). The popup shows a working run as a row in what is being sent
//   (the page's title and "Reading the whole page…"), then the kept file in its place, or the run's own words when it
//   could not finish.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A run is { id, row_id, page, state: 'working' | 'later' | 'failed', said? }; a finished run leaves the list and
//      its files are in the tray (with made_by: the row's id, so the popup can say what each file is).
//   2. The same tool on the same page runs once at a time; starting it again while it works does nothing.
//   3. A plan that does not include the tool shows the plan cards (session `plan_needed`); its row says only the one
//      short PlanNeeded line pointing at them.

import pageTools from '../page-tools.json' with { type: 'json' };
import { runPageTool } from './page-tools.mjs';
import { sentFileName, signedInAccount, tool } from './trillion.mjs';
import { addToTrayOwned } from './tray.mjs';
import { keepAwake } from './keep-awake.mjs';

const read = async () => (await chrome.storage.session.get('page_runs')).page_runs ?? [];
const write = runs => chrome.storage.session.set({ page_runs: runs });
// One worker owns this list. Serialize admission and every update so overlapping starts and completions
// cannot publish stale snapshots over one another. A rejected operation does not poison later mutations.
let mutation = Promise.resolve();
const mutate = operation => {
  const answer = mutation.then(operation, operation);
  mutation = answer.catch(() => {});
  return answer;
};
const change = (id, next) => mutate(async () => write((await read()).flatMap(run => (run.id !== id ? [run] : next ? [{ ...run, ...next }] : []))));
const active = new Set();

async function run(row, page, record) {
  const awake = keepAwake();
  try {
    const call = async (name, args) => {
      if (await signedInAccount() !== record.account) throw new Error('The signed-in account changed. Sign in to the account that started this run, then retry it.');
      return tool(name, args, record.account);
    };
    const name = (title, extension) => sentFileName(title, extension, new Date(record.started_at));
    const done = await runPageTool({ row, page, call, name, requestKey: record.request_key });
    if (await signedInAccount() !== record.account) throw new Error('The signed-in account changed. Sign in to the account that started this run, then retry it.');
    if (done.state === 'later') { await change(record.id, { state: 'later', task_id: done.task_id }); return; }
    for (const item of done.items) {
      if (await signedInAccount() !== record.account) throw new Error('The signed-in account changed. Sign in to the account that started this run, then retry it.');
      await addToTrayOwned({ ...item, made_by: row.id, account: record.account });
    }
    await change(record.id, null);
  } catch (error) {
    const retryable = error?.name !== 'PageToolFailed';
    await change(record.id, { state: 'failed', retryable, said: String(error?.message ?? error) });
  } finally {
    awake();
    active.delete(record.id);
  }
}

function launch(record) {
  if (active.has(record.id)) return;
  const row = pageTools.tools.find(item => item.id === record.row_id);
  if (!row) return;
  active.add(record.id);
  void run(row, record.page, record);
}

const handlers = {
  async start({ row_id: rowId, page }) {
    const row = pageTools.tools.find(item => item.id === rowId);
    if (!row || !page?.url) throw new Error('That cannot run on this page.');
    const account = await signedInAccount();
    if (!account) throw new Error('Sign in to Trillion before starting a page tool.');
    const record = await mutate(async () => {
      const runs = await read();
      const existing = [...runs].reverse().find(item => item.account === account && item.row_id === rowId && item.page.url === page.url);
      if (existing?.state === 'working' && typeof existing.request_key === 'string' && existing.request_key) return { record: existing, admitted: !active.has(existing.id) };
      // Ambiguous transport failures and still-running jobs reuse their key. A definitive tool refusal gets a
      // fresh identity on deliberate retry, while separate tools and accounts always retain separate rows.
      const retry = existing && (existing.state === 'later' || existing.retryable === true);
      const next = retry
        ? { ...existing, page, state: 'working', said: undefined, task_id: undefined }
        : { id: crypto.randomUUID(), request_key: crypto.randomUUID(), account, row_id: rowId, page, state: 'working', started_at: Date.now() };
      await write(retry ? runs.map(item => item.id === existing.id ? next : item) : [...runs, next]);
      return { record: next, admitted: true };
    });
    if (record.admitted) launch(record.record);
    return { id: record.record.id };
  },
  async dismiss({ id }) {
    await change(id, null);
    return {};
  },
};

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  const said = message?.page_run;
  if (!said || typeof said !== 'object') return false;
  const [verb] = Object.keys(said).filter(key => key in handlers);
  if (!verb) return false;
  handlers[verb](said[verb]).then(answer => reply(answer ?? {}), error => reply({ error: String(error?.message ?? error) }));
  return true;
});

// A worker can stop after persisting a claim but before receiving the service reply. Replaying the same
// request_key lets the account recover that accepted run without creating a second task.
void mutate(read).then(runs => signedInAccount().then(account => {
  for (const record of runs) if (record.state === 'working' && record.account === account && typeof record.request_key === 'string' && record.request_key) launch(record);
})).catch(() => {});
