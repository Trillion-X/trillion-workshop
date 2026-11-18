// packages/hosted-public-app/processes/prove-a-release-starts-before-it-goes-live.mjs
//
// Purpose: a release becomes what an app serves only after a copy of the app,
// started from that release on a copy of the app's own data, says it is fully
// ready. Otherwise the release is refused and the live app never changes.
//
// Why this exists: every way this app broke in one week was a release that
// became live first and was found out afterwards. A blank volume swapped in,
// a machine shrunk until it ran out of memory, a new runner that looked for
// its JavaScript runtime under the wrong name, an install that left a stored
// edge pointing at a slot that was not there. Each was a different cause and
// the provider reported every one of those releases as a success. The one
// thing they share is the app's own answer to "are you fully ready", so that
// answer is the test and no cause is ever listed here.
//
// Non-negotiable invariants:
// - The trial never touches live: it runs in its own machine, on a fork of the
//   live volume, with no public services, and never starts the public server
//   (which would drain queued checkouts and leads against the fork and send
//   them twice). Machine and fork are destroyed whatever happens.
// - A release requires a ready trial, even if live is already unavailable.
//   A failed trial cannot demonstrate that its new image repairs a broken app.
// - After a release, live is asked again. If it was ready before and is not
//   now, the previous image is released back and the deploy fails.
// - The provider is reached through its machines API with the credential this
//   package already resolves; no provider command is composed here.

import { verifyReleaseViewportPaint } from '../../write-a-sales-page/packages/hosted-public-app/processes/verify-release-viewport-paint.mjs';

const FLY_MACHINES_API = 'https://api.machines.dev/v1';

/** The deployment owner supplies the equivalent read path when Fly exec refuses. */
export async function execMachineCommand(api, application, machineId, command, fallback = null, timeoutSeconds = 20) {
  try {
    return await api('POST', `/apps/${application}/machines/${machineId}/exec`, { command, timeout: timeoutSeconds });
  } catch (error) {
    if (!fallback) throw error;
    return fallback({ application, machineId, command });
  }
}

// How the trial is asked. These are the hosted launcher's own defaults
// (`packages/native-artifact/do-work/hosted-launcher.sh`), read through the
// same environment names, so an image that moves them keeps working.
export const READINESS_COMMAND = ['/opt/bitfield/bin/node', '-e',
  'fetch("http://"+(process.env.BITFIELD_HOSTED_SHELL_INTERNAL_ADDRESS||"127.0.0.1:8081")+"/boot")'
    + '.then(async r=>{const b=await r.json();const t=Array.isArray(b)?b:Array.isArray(b?.targets)?b.targets:[];'
    + 'process.stdout.write(JSON.stringify({status:r.status,summary:{target_count:t.length,code:b?.code,boot_status:b?.status,message:b?.message,recovery_cause:b?.recovery_receipt?.cause}}))})'
    + '.catch(e=>process.stdout.write(JSON.stringify({status:"unreachable",summary:{message:String(e)}})))'];

// The trial deliberately leaves the public server off, so /boot alone cannot
// catch a page description whose recovery body is absent from the new image.
// Check the new image's own public files before it can replace a serving image.
export const PUBLIC_FALLBACK_COMMAND = [
  '/bin/sh', '-c',
  '"${BITFIELD_RUNTIME_KIT_HOME:-/opt/bitfield}/bin/node" -e '
    + '\'const fs=require("node:fs"),path=require("node:path");'
    + 'const named=process.env.BITFIELD_PUBLIC_PAGE_DESCRIPTION_FILE;'
    + 'if(!named){process.stdout.write(JSON.stringify({ready:true,reason:"no public page description"}));process.exit(0)}'
    + 'try{const description=JSON.parse(fs.readFileSync(named,"utf8"));'
    + 'const pages=Array.isArray(description.pages)?description.pages:[];'
    + 'if(!pages.length)throw Error("page description has no pages");'
    + 'for(const page of pages){const relative=page.fallback_body_file;'
    + 'if(typeof relative!=="string"||!relative.trim())throw Error("page has no fallback_body_file");'
    + 'const file=path.resolve(path.dirname(named),relative);'
    + 'if(!fs.readFileSync(file,"utf8").trim())throw Error("fallback body is blank: "+relative);'
    + 'if(page.fallback_pages_file){const archive=path.resolve(path.dirname(named),page.fallback_pages_file);'
    + 'const rows=JSON.parse(fs.readFileSync(archive,"utf8"));'
    + 'if(!Array.isArray(rows.rows))throw Error("fallback page archive has no rows")}}'
    + 'process.stdout.write(JSON.stringify({ready:true,reason:"public recovery files present"}))}'
    + 'catch(error){process.stdout.write(JSON.stringify({ready:false,reason:String(error.message||error).slice(0,300)}))}\'',
];

// The serving image carries the app's current source in place, and a release
// replaces it at the same path. Before that happens the live machine keeps one
// stored copy of it (the opener's `--retain-current-source`, every app on the
// machine), so the outgoing source survives the swap as the previous one.
export const RETAIN_OUTGOING_SOURCE_COMMAND = [
  '/bin/sh', '-c',
  'BITFIELD_MACHINE_WIDE_HOME="${BITFIELD_INSTALL_ROOT:-/var/lib/bitfield}" '
    + '"${BITFIELD_HOSTED_OPENER:-${BITFIELD_RUNTIME_KIT_HOME:-/opt/bitfield}/bin/open-bitfield-app}" --retain-current-source',
];

/** The kept copies the live machine reported, or why none could be kept. */
export function retainedSourceFromAnswer(answer) {
  let parsed;
  try { parsed = JSON.parse(String(answer ?? '').trim()); } catch { parsed = null; }
  if (!Array.isArray(parsed)) {
    return { kept: false, reason: `the live machine did not keep its current source: ${String(answer ?? '').trim().slice(0, 300) || 'no answer'}` };
  }
  return { kept: true, sources: parsed.map((row) => ({ app_id: row?.app_id ?? null, kept: row?.kept ?? null })) };
}

async function keepOutgoingSource(api, application, machineId, machineCommand) {
  try {
    const reply = await execMachineCommand(api, application, machineId, RETAIN_OUTGOING_SOURCE_COMMAND, machineCommand, 600);
    return retainedSourceFromAnswer(reply?.stdout);
  } catch (error) {
    return { kept: false, reason: `the live machine could not be asked to keep its current source: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// What the new version holds once it is ready: the footprint record its opener
// writes after the shell reports ready (every folder entry judged against its
// owner's DATA row), and the memory the machine has in use. Read from the trial
// with the image's own JavaScript runtime, so no provider command is composed.
export const FOOTPRINT_COMMAND = [
  '/bin/sh', '-c',
  'install="${BITFIELD_INSTALL_ROOT:-/var/lib/bitfield}"; '
    + 'set -- "$install"/runtime-kit/app-log-storage-folders/*/runtime-kit/running-now/open-this-bitfield-app/runtime-app-footprint.json '
    + '"$install"/.bitfield/runtime-kit/app-log-storage-folders/*/runtime-kit/running-now/open-this-bitfield-app/runtime-app-footprint.json; '
    + '"${BITFIELD_RUNTIME_KIT_HOME:-/opt/bitfield}/bin/node" -e '
    + '\'const fs=require("node:fs");const records=[];'
    + 'for(const file of process.argv.slice(1)){try{records.push(JSON.parse(fs.readFileSync(file,"utf8")))}catch{}}'
    + 'const info=Object.fromEntries(fs.readFileSync("/proc/meminfo","utf8").split("\\n").filter(Boolean).map((l)=>{const[k,v]=l.split(":");return[k,parseInt(v,10)*1024]}));'
    + 'process.stdout.write(JSON.stringify({records,memory_in_use_bytes:info.MemTotal-info.MemAvailable}))\' "$@"',
];

/** The trial's footprint: refused when no record was written or any says `over`. */
export function footprintFromAnswer(answer) {
  let parsed;
  try { parsed = JSON.parse(String(answer ?? '').trim()); } catch { parsed = null; }
  const records = Array.isArray(parsed?.records) ? parsed.records : [];
  if (records.length === 0) {
    return { ready: false, reason: 'the new version wrote no footprint record, so its size was never checked' };
  }
  const over = records.filter((record) => record?.footprint !== 'within');
  if (over.length > 0) {
    const named = over.flatMap((record) => [
      ...(record.entries ?? []).filter((entry) => entry?.over).map((entry) => (
        `${entry.path} ${entry.allocated_bytes} bytes${entry.owner ? ` (bound ${entry.max_allocated_bytes})` : ' (no owner declares it)'}`)),
      ...(record.duplicates ?? []).map((duplicate) => `${duplicate.fingerprint} held twice: ${(duplicate.paths ?? []).join(', ')}`),
      ...(record.memory && record.memory.opener_peak_bytes > record.memory.max_opener_peak_bytes
        ? [`opener peak ${record.memory.opener_peak_bytes} bytes (bound ${record.memory.max_opener_peak_bytes})`] : []),
      ...(record.memory && record.memory.engine_own_bytes > record.memory.max_engine_own_bytes
        ? [`engine ${record.memory.engine_own_bytes} bytes (bound ${record.memory.max_engine_own_bytes})`] : []),
    ]);
    return { ready: false, reason: `the new version is over its footprint: ${named.join('; ').slice(0, 600)}` };
  }
  const inUse = Number(parsed?.memory_in_use_bytes);
  const openerPeak = Math.max(0, ...records.map((record) => Number(record?.memory?.opener_peak_bytes) || 0));
  return {
    ready: true,
    reason: 'within its footprint',
    measured: {
      memory_in_use_bytes: Number.isFinite(inUse) && inUse > 0 ? inUse : null,
      opener_peak_bytes: openerPeak,
      allocated_bytes: records.reduce((sum, record) => sum + (Number(record?.allocated_bytes) || 0), 0),
    },
  };
}

/**
 * The memory a machine is given from what a release measurably needed.
 * `settings` is the package's release-machine-settings DATA. Returns null when
 * the need was not measured, so the caller keeps the size it has.
 */
export function memoryMegabytesForMeasuredNeed({ measured, cpuKind, cpus }, settings) {
  if (!measured || !Number.isFinite(measured.memory_in_use_bytes)) return null;
  const perCpu = settings?.minimum_megabytes_per_cpu?.[cpuKind];
  if (!Number.isInteger(perCpu) || !Number.isInteger(cpus) || cpus <= 0) return null;
  const needBytes = measured.memory_in_use_bytes + (measured.opener_peak_bytes ?? 0);
  const wanted = (needBytes * settings.headroom_factor) / (1024 * 1024);
  const step = settings.step_megabytes;
  return Math.max(perCpu * cpus, Math.ceil(wanted / step) * step);
}

async function askFootprint(api, application, machineId, machineCommand) {
  try {
    const reply = await execMachineCommand(api, application, machineId, FOOTPRINT_COMMAND, machineCommand);
    return footprintFromAnswer(reply?.stdout);
  } catch (error) {
    return { ready: false, reason: `the footprint check could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function publicFallbackReadinessFromAnswer(answer) {
  let parsed;
  try { parsed = JSON.parse(String(answer ?? '').trim()); } catch { parsed = null; }
  return parsed?.ready === true
    ? { ready: true, reason: String(parsed.reason ?? 'public recovery files present') }
    : { ready: false, reason: String(parsed?.reason ?? 'public recovery check gave no answer') };
}

/** The app's own answer, reduced to ready or not and the words it gave. */
export function readinessFromBootAnswer(status, bodyText) {
  let body = null;
  try { body = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText; } catch { body = null; }
  const targets = Array.isArray(body) ? body : Array.isArray(body?.targets) ? body.targets : [];
  const targetCount = Number.isSafeInteger(body?.target_count) ? body.target_count : targets.length;
  const ready = Number(status) === 200 && targetCount > 0;
  const reason = ready
    ? `ready with ${targetCount} targets`
    : String(body?.recovery_cause ?? body?.recovery_receipt?.cause ?? body?.message ?? body?.code ?? bodyText ?? status).slice(0, 400);
  // A restricted recovery answer is final. Ordinary "recovering" and
  // "warming up" answers can become ready during the same trial start.
  const final = ready || body?.code === 'BITFIELD_BOOT_RESTRICTED_RECOVERY';
  return { ready, status, reason, final };
}

function providerApi(credential, fetchImplementation) {
  return async (method, path, body) => {
    const response = await fetchImplementation(`${FLY_MACHINES_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'cache-control': 'no-store' },
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!response.ok) {
      throw new Error(`provider ${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`);
    }
    return json;
  };
}

async function askReadiness(api, application, machineId, machineCommand) {
  try {
    const reply = await execMachineCommand(api, application, machineId, READINESS_COMMAND, machineCommand);
    const answer = JSON.parse(String(reply?.stdout ?? '').trim() || '{}');
    return readinessFromBootAnswer(answer.status, answer.summary ?? answer.body ?? '');
  } catch (error) {
    return { ready: false, status: 'unreachable', reason: error instanceof Error ? error.message : String(error), final: false };
  }
}

async function askPublicFallbackReadiness(api, application, machineId, machineCommand) {
  try {
    const reply = await execMachineCommand(api, application, machineId, PUBLIC_FALLBACK_COMMAND, machineCommand);
    return publicFallbackReadinessFromAnswer(reply?.stdout);
  } catch (error) {
    return { ready: false, reason: `public recovery check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function appHostFor(config, application) {
  const named = String(config?.env?.BITFIELD_APP_ENTRY_SCENE_HOSTS
    ?? config?.env?.BITFIELD_HOST_ENTRY_SCENE_HOSTS ?? '').split(',')[0].trim();
  if (named) return named;
  try { return new URL(config?.env?.ACCOUNT_PUBLIC_URL).hostname; } catch {
    return /^[a-z][a-z0-9-]*$/.test(application) ? `${application}.fly.dev` : '';
  }
}

/** The machines that serve the app, meaning the ones a release replaces. */
function servingMachines(machines) {
  return machines.filter((machine) => machine?.config?.metadata?.fly_process_group
    && machine?.config?.metadata?.purpose !== TRIAL_PURPOSE);
}

const TRIAL_PURPOSE = 'trial-start-of-a-release';

async function waitUntilFinal({ api, application, machineId, wait, attempts, intervalMs, machineCommand = null, isInterrupted = () => false }) {
  let last = { ready: false, status: 'not started', reason: 'the trial never answered', final: false };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (isInterrupted()) throw new Error('release trial interrupted; cleaning up its machine and volume');
    let machine = await api('GET', `/apps/${application}/machines/${machineId}`).catch(() => null);
    // Fly's exact-machine read can lag behind the list after a newly created
    // trial starts. The list is already the source used to select the serving
    // machine; use its current state before declaring a started trial silent.
    const listed = await api('GET', `/apps/${application}/machines`).catch(() => null);
    const listedMachine = Array.isArray(listed)
      ? listed.find((candidate) => candidate?.id === machineId)
      : null;
    // The exact-machine answer can stay at "started" after the VM has exited.
    // Prefer a terminal state from either provider view so a failed trial is
    // reported promptly instead of polling a dead machine until the deadline.
    if (listedMachine && ['stopped', 'destroyed', 'failed'].includes(listedMachine.state)) {
      machine = listedMachine;
    } else if (!machine || !['started', 'stopped', 'destroyed', 'failed'].includes(machine.state)) {
      machine = listedMachine ?? machine;
    }
    if (machine && ['stopped', 'destroyed', 'failed'].includes(machine.state)) {
      const exit = (machine.events ?? []).find((event) => event?.type === 'exit');
      const request = exit?.request?.exit_event ?? {};
      const cause = request.oom_killed ? 'it ran out of memory' : `it exited with code ${request.exit_code ?? 'unknown'}`;
      return { ready: false, status: machine.state, reason: `the trial machine stopped: ${cause}`, final: true };
    }
    // The provider can keep reporting `created` after flyd has started the
    // machine. The machine's own boot answer is the release predicate; try its
    // exec door even while the provider's state read is stale. A not-yet-started
    // machine simply refuses exec and remains eligible for the next attempt.
    if (machine) {
      last = await askReadiness(api, application, machineId, machineCommand);
      if (attempt === 0 || attempt % 12 === 0 || last.final) {
        process.stderr.write(`[release] readiness ${machineId}: ${last.status}; ${last.reason}\n`);
      }
      if (last.final) return last;
    }
    if (attempt + 1 < attempts) await wait(intervalMs);
  }
  return { ...last, final: true, reason: `no full-ready answer within the wait: ${last.reason}` };
}

/**
 * Start `image` on a fork of the live data and report whether it is at least
 * as ready as live. Returns what the release needs to know; throws only when
 * the release must be refused.
 */
export async function proveTheReleaseStarts({
  application,
  image,
  credential,
  fetchImplementation = fetch,
  verifyPaint = verifyReleaseViewportPaint,
  memberReadiness = null,
  openTrialTunnel,
  machineCommand = null,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signalSource = process,
  // A copied Gardening log can take more than five minutes before Fly accepts
  // container exec, even while the machine reports started. Keep the trial
  // bounded, but let the app answer its own readiness question after replay.
  attempts = 180,
  intervalMs = 5_000,
}) {
  const api = providerApi(credential, fetchImplementation);
  const serving = servingMachines(await api('GET', `/apps/${application}/machines`));
  if (serving.length === 0) throw new Error(`${application} has no machine serving it, so there is nothing to compare a release against`);
  const live = serving[0];
  const liveAnswer = live.state === 'started'
    ? await askReadiness(api, application, live.id, machineCommand)
    : { ready: false, status: live.state, reason: `the live machine is ${live.state}`, final: true };

  const mount = (live.config?.mounts ?? [])[0] ?? null;
  let fork = null;
  let trial = null;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  signalSource.on('SIGINT', interrupt);
  signalSource.on('SIGTERM', interrupt);
  try {
    if (mount?.volume) {
      // The fork reads persisted blocks. Flush the serving filesystem before
      // taking it so a log pointer cannot outrun the CAS piece it names.
      await execMachineCommand(api, application, live.id,
        ['sync', '-f', '/var/lib/bitfield'], machineCommand);
      fork = await api('POST', `/apps/${application}/volumes`, {
        name: mount.name ?? live.config?.mounts?.[0]?.name ?? 'trial',
        region: live.region,
        source_volume_id: mount.volume,
      });
      for (let attempt = 0; attempt < attempts && fork.state !== 'created'; attempt += 1) {
        await wait(intervalMs);
        fork = await api('GET', `/apps/${application}/volumes/${fork.id}`);
      }
      if (fork.state !== 'created') throw new Error(`the copy of ${application}'s data never became usable (${fork.state})`);
    }
    if (interrupted) throw new Error('release trial interrupted; cleaning up its machine and volume');
    const { services: _services, metadata, ...config } = live.config ?? {};
    trial = await api('POST', `/apps/${application}/machines`, {
      region: live.region,
      config: {
        ...config,
        image,
        services: [],
        restart: { policy: 'no' },
        metadata: { purpose: TRIAL_PURPOSE },
        env: {
          ...(config.env ?? {}),
          BITFIELD_START_WITHOUT_THE_PUBLIC_SERVER: '1',
          BITFIELD_RELEASE_TRIAL_NO_EXTERNAL_EFFECTS: '1',
        },
        ...(fork ? { mounts: [{ ...mount, volume: fork.id }] } : {}),
      },
    });
    let trialAnswer = await waitUntilFinal({ api, application, machineId: trial.id, wait, attempts, intervalMs, machineCommand, isInterrupted: () => interrupted });
    if (interrupted) throw new Error('release trial interrupted; cleaning up its machine and volume');
    if (trialAnswer.ready) {
      const publicFallback = await askPublicFallbackReadiness(api, application, trial.id, machineCommand);
      if (!publicFallback.ready) {
        trialAnswer = { ready: false, status: 'public recovery invalid', reason: publicFallback.reason, final: true };
      }
    }
    let footprint = null;
    if (trialAnswer.ready) {
      footprint = await askFootprint(api, application, trial.id, machineCommand);
      if (!footprint.ready) {
        trialAnswer = { ready: false, status: 'footprint over', reason: footprint.reason, final: true };
      }
    }
    if (trialAnswer.ready) {
      try {
        const trialMachine = await api('GET', `/apps/${application}/machines/${trial.id}`);
        const paint = await verifyPaint({
          application, privateIp: trialMachine?.private_ip ?? trial.private_ip,
          host: appHostFor(config, application),
          openTunnel: openTrialTunnel,
          memberReadiness,
        });
        if (!paint.ready) trialAnswer = { ready: false, status: 'blank trial page', reason: paint.reason, final: true };
      } catch (error) {
        trialAnswer = {
          ready: false, status: 'browser trial failed',
          reason: String(error instanceof Error ? error.message : error).slice(0, 300), final: true,
        };
      }
    }
    if (interrupted) throw new Error('release trial interrupted; cleaning up its machine and volume');
    let retained = null;
    if (trialAnswer.ready && live.state === 'started' && live.config?.image !== image) {
      retained = await keepOutgoingSource(api, application, live.id, machineCommand);
      if (!retained.kept) {
        trialAnswer = { ready: false, status: 'outgoing source not kept', reason: retained.reason, final: true };
      }
    }
    const result = {
      application, image, previous_image: live.config?.image ?? null, live: liveAnswer, trial: trialAnswer,
      measured: footprint?.measured ?? null,
      retained: retained?.sources ?? null,
    };
    if (!trialAnswer.ready) {
      const refusal = new Error(`release refused, ${application} is still serving its current version: the new version did not fully start on a copy of the app's data (${trialAnswer.reason})`);
      refusal.result = result;
      throw refusal;
    }
    return result;
  } finally {
    try {
      if (trial?.id) {
        await api('DELETE', `/apps/${application}/machines/${trial.id}?force=true`).catch(() => {});
        // Deletion can be accepted before Fly detaches the fork. Wait for the
        // machine to disappear so volume cleanup is not attempted too early.
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const listed = await api('GET', `/apps/${application}/machines`).catch(() => null);
          if (Array.isArray(listed) && !listed.some((machine) => machine?.id === trial.id)) break;
          await wait(intervalMs);
        }
      }
      if (fork?.id) {
        // A volume cannot be destroyed while the machine that held it is still
        // going away. A rejected delete must never be reported as a clean trial.
        let deleted = false;
        let lastError = null;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          try {
            await api('DELETE', `/apps/${application}/volumes/${fork.id}`);
            deleted = true;
            break;
          } catch (error) {
            lastError = error;
            // Fly may have accepted an earlier deletion even if its response
            // failed. Its no-longer-billable state is enough to close cleanup.
            try {
              const current = await api('GET', `/apps/${application}/volumes/${fork.id}`);
              if (current?.state === 'pending_destroy' || current?.state === 'destroyed') {
                deleted = true;
                break;
              }
            } catch (readError) {
              if (/answered 404:/.test(String(readError))) {
                deleted = true;
                break;
              }
            }
            if (attempt < 11) await wait(intervalMs);
          }
        }
        if (!deleted) {
          throw new Error(`release trial left volume ${fork.id} for ${application} in a billable state; provider deletion failed: ${String(lastError)}`);
        }
      }
    } finally {
      signalSource.off('SIGINT', interrupt);
      signalSource.off('SIGTERM', interrupt);
    }
  }
}

/**
 * After a release: if live was ready before and is not ready now, hand back
 * the image that was serving and report the failure in the app's own words.
 */
export async function confirmLiveOrRestore({
  proof,
  credential,
  restore,
  machineCommand = null,
  fetchImplementation = fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 180,
  intervalMs = 5_000,
}) {
  if (!proof?.live?.ready) return { restored: false, live: proof?.live ?? null };
  const api = providerApi(credential, fetchImplementation);
  const serving = servingMachines(await api('GET', `/apps/${proof.application}/machines`));
  const answer = serving[0]
    ? await waitUntilFinal({ api, application: proof.application, machineId: serving[0].id, wait, attempts, intervalMs, machineCommand })
    : { ready: false, reason: 'no machine is serving the app after the release' };
  if (answer.ready) return { restored: false, live: answer };
  if (proof.previous_image) await restore(proof.previous_image);
  throw new Error(`the release reached ${proof.application} but it did not fully start there (${answer.reason}); the previous version ${proof.previous_image} was released back`);
}
