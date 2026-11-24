// tools/models-on-this-computer/read-data/check-the-model-server.mjs
//
// Purpose
//   Checks that this computer's model server still loads models, and restarts it when it does not
//   (tool:check-the-model-server-and-restart-it-if-stuck). A server can keep answering the model it already holds while
//   it never loads another: on Nov 22 2026 the server logged two "predicted to exceed available memory, evicting" lines
//   at 01:18 and then made no load attempt for any other model for over an hour, while every job naming another model
//   failed. A reply from a model already loaded is not proof of a load. Check residency first and use an installed,
//   unloaded standby when the primary is already resident.
//
// Non-negotiable invariants
//   1. What is probed, how long a load may take, how the server is restarted and how long it may take to come back are
//      DATA (models-on-this-computer.json server.health); this file names no model, program or service.
//   2. The server is reached by its local door, as every row is (`placed`); a door the computer does not report is
//      said in words, never guessed.
//   3. A restart is only ever the declared one, run with its argv (no shell), after a probe failed; a request can lower
//      the probe's limit (to prove the restart path) or ask for a report only, never name what is run.
//   4. The answer says what was seen before and after: the models loaded, how long each probe took, how the restart
//      ended and how long the server took to answer again.
//
// Usage
//   node /opt/workflows/do-work/run-a-function.mjs /opt/models-on-this-computer/read-data/check-the-model-server.mjs check
//
import { execFile } from 'node:child_process';
import { localModelSettings, placed } from './models-on-this-computer.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getJson(url, seconds) {
  const answer = await fetch(url, { signal: AbortSignal.timeout(seconds * 1000) });
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
  return answer.json();
}

/** One small load: answers { loads, ms } and, when it did not, why. */
async function probe(health, at, seconds) {
  const started = Date.now();
  try {
    const answer = await fetch(at(health.chat), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(seconds * 1000),
      body: JSON.stringify({ model: health.probe_model, stream: false, keep_alive: health.probe_keep_alive,
        messages: [{ role: 'user', content: health.probe_words }], options: { num_predict: health.probe_tokens } }),
    });
    const body = await answer.json().catch(() => ({}));
    if (!answer.ok || typeof body?.message?.content !== 'string') {
      return { loads: false, ms: Date.now() - started, why: `answered ${answer.status}${body?.error ? `: ${String(body.error).slice(0, 300)}` : ''}` };
    }
    return { loads: true, ms: Date.now() - started };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { loads: false, ms: Date.now() - started, why: timedOut ? `no answer in ${seconds} s` : String(error?.message ?? error) };
  }
}

async function modelNames(url) {
  try {
    const { models } = await getJson(url, 5);
    if (!Array.isArray(models)) return null;
    const names = models.map(row => row?.name ?? row?.model);
    return names.every(name => typeof name === 'string' && name.length) ? names : null;
  } catch { return null; }
}

const modelKey = name => {
  const key = name.toLowerCase();
  return key.slice(key.lastIndexOf('/') + 1).includes(':') ? key : `${key}:latest`;
};

async function loadToCheck(health, at, modelsUrl) {
  const resident = await modelNames(at(health.loaded));
  if (!resident) return { resident, cold: null, health };
  const warm = new Set(resident.map(modelKey));
  if (!warm.has(modelKey(health.probe_model))) return { resident, cold: true, health };
  if (typeof health.standby_model === 'string' && health.standby_model.length && !warm.has(modelKey(health.standby_model))) {
    const installed = await modelNames(modelsUrl);
    if (installed?.some(name => modelKey(name) === modelKey(health.standby_model))) {
      return { resident, cold: true, health: { ...health, probe_model: health.standby_model } };
    }
  }
  return { resident, cold: false, health };
}

function run(argv, seconds) {
  return new Promise(resolve => {
    const started = Date.now();
    execFile(argv[0], argv.slice(1), { timeout: seconds * 1000 }, (error, stdout, stderr) => resolve({
      argv, ms: Date.now() - started, exit: error ? (error.code ?? 'failed') : 0,
      ...(error ? { said: String(stderr || error.message).slice(0, 300) } : {}),
    }));
  });
}

/**
 * healthy is true only when a model not seen loaded at the start answers. A warm-only answer, or an answer without
 * reliable residency evidence, is inconclusive (healthy: null). A failed request still reports the attempted recovery.
 * input.limit_seconds lowers the first probe's limit (never raises it); input.restart false reports without restarting.
 */
export async function checkTheServer(input, settings, { uid = process.getuid?.() } = {}) {
  const health = settings.server?.health;
  if (!health || typeof health.probe_model !== 'string' || !Array.isArray(health.restart?.argv)) {
    throw new Error('the model server has no health settings: server.health needs probe_model and restart.argv');
  }
  const door = settings.server.door;
  const base = settings.server.models?.replace(/\/api\/tags$/, '') ?? null;
  if (!base) throw new Error(String(settings.words?.not_reported ?? 'the computer does not report door {door}').replaceAll('{door}', door));
  const at = path => `${base}${path}`;
  const limit = Math.min(Number(input.limit_seconds) > 0 ? Number(input.limit_seconds) : health.limit_seconds, health.limit_seconds);
  const at_start = new Date().toISOString();
  const target = await loadToCheck(health, at, settings.server.models);
  const first = await probe(target.health, at, limit);
  const checked = { checked_at: at_start, probe: {
    model: target.health.probe_model, limit_seconds: limit, cold_before: target.cold, ...first,
  } };
  const before = { loaded: target.resident };
  if (first.loads) {
    if (target.cold === true) return { healthy: true, ...checked, before };
    return { healthy: null, ...checked, before, said: target.cold === false
      ? 'The resident model answered, but no installed standby was available to check a fresh load.'
      : 'The model answered, but the server did not say which models were already loaded.' };
  }
  const result = { healthy: false, ...checked, before, signature: health.signature };
  if (input.restart === false) return { ...result, restart: null, said: 'report only: the request asked for no restart' };
  const argv = health.restart.argv.map(part => String(part).replaceAll('{uid}', String(uid)));
  result.restart = await run(argv, health.restart.run_seconds);
  const waiting = Date.now();
  let back = null;
  while (Date.now() - waiting < health.restart.back_within_seconds * 1000) {
    try { await getJson(at(health.alive), 2); back = Date.now() - waiting; break; } catch { await sleep(1000); }
  }
  result.back_after_ms = back;
  result.after = back === null
    ? { probe: { loads: false, why: `the server did not answer within ${health.restart.back_within_seconds} s of the restart` }, loaded: null }
    : { probe: { model: target.health.probe_model, limit_seconds: health.limit_seconds, ...(await probe(target.health, at, health.limit_seconds)) }, loaded: await modelNames(at(health.loaded)) };
  return result;
}

/** tool:check-the-model-server-and-restart-it-if-stuck: handed { input, local_ports } like every row of this tool. */
export const check = (handed = {}) => {
  const given = handed && typeof handed === 'object' && 'local_ports' in handed ? handed : { input: handed, local_ports: {} };
  return checkTheServer(given.input ?? {}, placed(localModelSettings(), given.local_ports ?? {}));
};
