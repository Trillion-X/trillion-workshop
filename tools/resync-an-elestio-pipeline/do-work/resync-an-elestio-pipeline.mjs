#!/usr/bin/env node
// tools/resync-an-elestio-pipeline/do-work/resync-an-elestio-pipeline.mjs
//
// PURPOSE: tool:resync-an-elestio-pipeline, run in the tool container. Reads the request on stdin ({ email, project_id, vm_id,
// pipeline_id, commit, since?, wait_seconds?, poll_seconds? }) and redeploys one Elestio CI/CD pipeline from its branch:
// 1. trades the vault's Elestio API token (descriptor 4, elestio-api-key) for a session (auth/checkAPIToken);
// 2. reads the pipeline once (cicd/getPipelineDetails) for the commit it serves before;
// 3. asks for a resync (cicd/doActionOnPipeline, action reSyncPipeline): Elestio fetches the branch and builds it again;
// 4. reads the pipeline every poll_seconds until its deployedCommit is `commit` and its lastUpdate is after `since` (the
//    moment the resync was asked, by default) and after the stamp the ask itself writes, its status deployed and its build
//    success; a failed build ends it at once.
// The answer is ok, the commits before and after, the seconds it took and the pipeline's own status words. No answer or
// error carries the token or the session, and only the named fields of the pipeline are passed on (its details also hold the
// deploy key and the webhook secret).
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = 'https://api.elest.io/api';
const HELD_DESCRIPTOR = 4;
const ASK_STAMP_MS = 5000;

// The fields of a pipeline's details passed on; everything else stays here.
const pick = details => ({
  deployed_commit: details?.deployedCommit ?? null,
  status: details?.status ?? null,
  build_status: details?.buildStatus ?? null,
  last_update: details?.lastUpdate ?? null,
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

const matches = (deployed, commit) => typeof deployed === 'string' && commit.length >= 7 && deployed.startsWith(commit);
const after = (lastUpdate, since) => Number.isFinite(Date.parse(lastUpdate)) && Date.parse(lastUpdate) > since;

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

  const before = await details();
  const askedAt = now();
  await post('reSyncPipeline', 'cicd/doActionOnPipeline', { ...ids, action: 'reSyncPipeline' });
  // Elestio stamps lastUpdate in whole seconds, so the resync counts from the second it was asked in.
  const since = request.since ? Date.parse(request.since) : Math.floor(askedAt / 1000) * 1000 - 1000;
  if (!Number.isFinite(since)) throw new Error('since must be a date and time, like 2026-11-25T07:39:38Z');

  // Elestio stamps lastUpdate twice: when the resync is asked (status still deployed, the old build still serving) and when
  // it has run, which can be minutes later (school, 2:28:24 and 2:31:25 AM CST Nov 25 2026). A stamp within ASK_STAMP_MS of
  // the ask is the ask's own, so only a later one counts.
  let latest = before, reads = 0, settle = since;
  for (;;) {
    latest = await details();
    reads += 1;
    if (reads === 1 && Math.abs(Date.parse(latest.last_update) - askedAt) <= ASK_STAMP_MS) settle = Math.max(since, Date.parse(latest.last_update));
    const done = matches(latest.deployed_commit, commit) && after(latest.last_update, settle)
      && latest.status === 'deployed' && latest.build_status === 'success';
    const failed = after(latest.last_update, settle) && /fail|error/i.test(String(latest.build_status));
    if (done || failed || now() - askedAt >= waitMs) {
      const reason = done ? null
        : failed ? `the build ended ${latest.build_status}`
        : !matches(latest.deployed_commit, commit) ? `still serving ${latest.deployed_commit ?? 'nothing'} after ${Math.round(waitMs / 1000)} s`
        : `not redeployed after ${Math.round(waitMs / 1000)} s (status ${latest.status}, build ${latest.build_status}, last update ${latest.last_update})`;
      return {
        ok: done,
        pipeline_id: String(pipelineID),
        commit,
        before,
        after: latest,
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
