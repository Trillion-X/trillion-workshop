#!/usr/bin/env node
// tools/composio-connection/do-work/wait-for-a-composio-container.mjs
//
// PURPOSE: tool:wait-for-a-composio-container, run in the tool container. A media container an app creates (an Instagram reel or
// carousel, for example) is processed in the background: it is IN_PROGRESS until the app says FINISHED, and publishing it before
// that fails. This asks the app, through the same account proxy as run-a-composio-action, for the container's status_code every
// few seconds, and answers FINISHED with the number of tries. It refuses with the last status when the app says ERROR or EXPIRED,
// or when the status has not reached FINISHED after maxTries asks. Nothing is published or changed here: it only reads.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeComposioProxy, Refused } from '../read-data/composio-call.mjs';

const DEFAULT_TRIES = 30;
const DEFAULT_SECONDS = 5;
const FAILED = ['ERROR', 'EXPIRED'];

/** Wait until the container reaches FINISHED. Answers {account_id, container_id, status_code, tries}. */
export async function waitForAComposioContainer(request = {}, {
  proxy = makeComposioProxy(),
  sleep = ms => new Promise(done => setTimeout(done, ms)),
} = {}) {
  const { account_id: accountId, user_id: userId, project_id: projectId, container_id: containerId } = request;
  const maxTries = request.max_tries ?? DEFAULT_TRIES;
  const everySeconds = request.every_seconds ?? DEFAULT_SECONDS;
  if (typeof containerId !== 'string' || !/^[0-9]+$/.test(containerId)) throw new Refused('Give container_id, the numeric id the app returned for the container.');
  if (!Number.isInteger(maxTries) || maxTries < 1 || maxTries > 120) throw new Refused('max_tries is a whole number from 1 to 120.');
  if (!Number.isFinite(everySeconds) || everySeconds < 1 || everySeconds > 60) throw new Refused('every_seconds is from 1 to 60.');
  let last = null;
  for (let tries = 1; tries <= maxTries; tries += 1) {
    const answer = await proxy({
      endpoint: `/${containerId}`,
      method: 'GET',
      parameters: [{ name: 'fields', type: 'query', value: 'id,status_code,status' }],
    }, accountId, userId, projectId);
    if (answer.status !== 200) throw new Refused(`The app answered ${answer.status} for container ${containerId}.`);
    last = answer.data?.status_code ?? answer.data?.status ?? null;
    if (last === 'FINISHED') return { account_id: accountId, container_id: containerId, status_code: last, tries };
    if (FAILED.includes(last)) throw new Refused(`Container ${containerId} is ${last}: it will not publish.`);
    if (tries < maxTries) await sleep(everySeconds * 1000);
  }
  throw new Refused(`Container ${containerId} is still ${last ?? 'unknown'} after ${maxTries} tries.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  waitForAComposioContainer(JSON.parse(readFileSync(0, 'utf8') || '{}'))
    .then(answer => process.stdout.write(`${JSON.stringify(answer)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
