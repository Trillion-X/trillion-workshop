#!/usr/bin/env node
// tools/resync-an-elestio-pipeline/do-work/resync-an-elestio-pipeline.mjs
//
// PURPOSE: tool:resync-an-elestio-pipeline, run in the tool container. Reads the request on stdin ({ email, project_id, vm_id,
// pipeline_id, commit, wait_seconds?, poll_seconds? }) and redeploys one Elestio CI/CD pipeline from its branch:
// 1. trades the vault's Elestio API token (descriptor 4, elestio-api-key) for a session (auth/checkAPIToken);
// 2. reads the pipeline's run history (cicd/doActionOnPipeline, action getHistory: one row per run, each with its own id) and
//    the commit it serves (cicd/getPipelineDetails);
// 3. asks for a resync (cicd/doActionOnPipeline, action reSyncPipeline): Elestio queues a run that fetches the branch and
//    builds it again;
// 4. reads the history every poll_seconds until the first Resync run with an id above every id read in 2 has ended: Success
//    on `commit` is ok; Failed, Canceled, or Success on another commit is not. Queue, Stuck and the running words wait.
// Done is that run's own record, never a clock: Elestio stamps the pipeline's lastUpdate both when a resync is asked and
// when it has run, minutes apart (school, 2:28:24 and 2:31:25 AM CST Nov 25 2026), so a time says nothing about which.
// The answer is ok, the run (id, status, times, seconds), the commits before and after and the seconds waited. No answer
// or error carries the token or the session, and only the named fields are passed on (the pipeline's details also hold the
// deploy key and the webhook secret).
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = 'https://api.elest.io/api';
const HELD_DESCRIPTOR = 4;
// The run statuses that end a run; every other word (Queue, Stuck, a running step) means wait.
const ENDED = new Set(['Success', 'Failed', 'Canceled']);

// The fields of a pipeline's details passed on; everything else stays here.
const pick = details => ({
  deployed_commit: details?.deployedCommit ?? null,
  status: details?.status ?? null,
  build_status: details?.buildStatus ?? null,
});

// The fields of one history run passed on.
const runOf = run => ({
  id: run.id,
  action: run.action ?? null,
  status: run.status ?? null,
  commit: run.commitID && run.commitID !== 'NULL' ? run.commitID : null,
  created: run.creationDate ?? null,
  started: run.startTime ?? null,
  ended: run.endTime ?? null,
  seconds: Number.isFinite(run.duration) ? run.duration : null,
  log: run.logID ?? null,
  ...(run.errorMessage ? { error: String(run.errorMessage).slice(0, 300) } : {}),
});

// Elestio answers some reads as { data }, some as a list and some bare: the one object either way.
const one = json => {
  const data = json?.data ?? json;
  return Array.isArray(data) ? data[0] : data;
};

// The service's own refusal words, with anything long and key-like masked.
const refusal = (step, status, json, text) => {
  const said = json?.message ?? json?.error ?? text;
  return new Error(`${step} answered ${status}: ${String(said ?? '').slice(0, 300).replace(/[A-Za-z0-9_\-.]{24,}/g, '<masked>')}`);
};

/** Sends one JSON POST to the Elestio API and returns its JSON; refuses a non-2xx answer or an answer with status KO. */
export function makeElestio({ send = fetch } = {}) {
  return async (step, path, body) => {
    const answer = await send(`${API}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await answer.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!answer.ok || json === null || json.status === 'KO') throw refusal(step, answer.status, json, text);
    return json;
  };
}

const matches = (deployed, commit) => typeof deployed === 'string' && deployed.toLowerCase().startsWith(commit);

/** The resync answer for one request. `read` gives the held token, `post` sends one API call, `wait` waits ms, `now` is ms. */
export async function resyncAnElestioPipeline(request, {
  read = () => readFileSync(HELD_DESCRIPTOR, 'utf8'),
  post = makeElestio(),
  wait = ms => new Promise(done => setTimeout(done, ms)),
  now = () => Date.now(),
} = {}) {
  const { email, project_id: projectID, vm_id: vmID, pipeline_id: pipelineID } = request;
  const commit = String(request.commit ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error('commit must be the pushed commit: 7 to 40 hex characters');
  const waitMs = (request.wait_seconds ?? 900) * 1000;
  const pollMs = (request.poll_seconds ?? 5) * 1000;

  const token = read().trim();
  if (!token) throw new Error('the held Elestio token is empty: put elestio-api-key in the vault of the computer that runs this');
  const { jwt } = await post('auth/checkAPIToken', 'auth/checkAPIToken', { email, token });
  if (typeof jwt !== 'string' || !jwt) throw new Error('auth/checkAPIToken answered no session');
  const ids = { jwt, projectID: String(projectID), vmID: String(vmID), pipelineID: String(pipelineID) };
  const details = async () => pick(one(await post('getPipelineDetails', 'cicd/getPipelineDetails', ids)));
  const history = async () => {
    const runs = (await post('getHistory', 'cicd/doActionOnPipeline', { ...ids, action: 'getHistory' })).data;
    if (!Array.isArray(runs)) throw new Error('getHistory answered no list of runs');
    return runs.filter(run => Number.isInteger(run?.id));
  };

  const before = await details();
  const known = Math.max(0, ...(await history()).map(run => run.id));
  const askedAt = now();
  await post('reSyncPipeline', 'cicd/doActionOnPipeline', { ...ids, action: 'reSyncPipeline' });

  let run = null, reads = 0;
  for (;;) {
    const ours = (await history()).filter(row => row.id > known && row.action === 'Resync').sort((a, b) => a.id - b.id)[0];
    reads += 1;
    if (ours) run = runOf(ours);
    const ended = run && ENDED.has(run.status);
    if (ended || now() - askedAt >= waitMs) {
      const after = await details();
      const ok = Boolean(ended && run.status === 'Success' && (matches(run.commit, commit) || (!run.commit && matches(after.deployed_commit, commit))));
      const reason = ok ? null
        : !run ? `no new Resync run appeared in ${Math.round(waitMs / 1000)} s`
        : !ended ? `run ${run.id} is still ${run.status} after ${Math.round(waitMs / 1000)} s`
        : run.status !== 'Success' ? `run ${run.id} ended ${run.status}${run.error ? `: ${run.error}` : ''}`
        : `run ${run.id} deployed ${run.commit ?? after.deployed_commit}, not ${commit}`;
      return {
        ok,
        pipeline_id: String(pipelineID),
        commit,
        run,
        before,
        after,
        asked_at: new Date(askedAt).toISOString(),
        seconds: Math.round((now() - askedAt) / 1000),
        reads,
        ...(reason ? { reason } : {}),
      };
    }
    await wait(pollMs);
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  resyncAnElestioPipeline(JSON.parse(readFileSync(0, 'utf8') || '{}'))
    .then(answer => process.stdout.write(`${JSON.stringify(answer)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
