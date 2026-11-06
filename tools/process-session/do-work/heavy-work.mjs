// One build/test slot per computer, independent of browser admission and deploy leases.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { computerCacheFolder } from './computer-cache-folder.mjs';
import { createProcessAdmissionQueue, identityOf, sameLiveProcess, UNKNOWN_LIVE } from './process-admission.mjs';
import { groupCleanupError, runOwnedProcess } from './run-owned-process.mjs';

export const HEAVY_WORK_CLAIM = 'TRILLION_HEAVY_WORK_CLAIM';
const ROOT = join(computerCacheFolder(), 'heavy-work-admission');
const PROBE_OPTIONS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, killSignal: 'SIGKILL' };
const groupsOf = owner => owner?.process_groups ?? (owner?.group_id ? [{ group_id: owner.group_id, group_started: owner.group_started }] : []);

export function heavyWorkOwnerIsLive(owner, inspect = identityOf) {
  if (sameLiveProcess(owner, inspect)) return true;
  // Parent death cannot open admission while a bound lifetime supervisor remains.
  return groupsOf(owner).some(group => sameLiveProcess({ pid: group.group_id, process_started: group.group_started }, inspect));
}

export function inspectProcessRelation(pid, run = execFileSync) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const [parent, group] = run('ps', ['-p', String(pid), '-o', 'ppid=,pgid='], PROBE_OPTIONS).trim().split(/\s+/).map(Number);
    return Number.isSafeInteger(parent) && parent >= 0 && Number.isSafeInteger(group) && group > 0 ? { parent, group } : null;
  } catch { return null; }
}

function readClaim(env) {
  try {
    const claim = JSON.parse(env[HEAVY_WORK_CLAIM]);
    return claim && typeof claim.token === 'string' && claim.token.length > 0
      && Number.isSafeInteger(claim.pid) && claim.pid > 0
      && typeof claim.process_started === 'string' && claim.process_started !== UNKNOWN_LIVE ? claim : null;
  } catch { return null; }
}

/** A copied environment is not admission: prove current group and ancestry against the live claim. */
export function verifiedHeavyWorkClaim(owner, { env = process.env, pid = process.pid, inspect = identityOf, relation = inspectProcessRelation } = {}) {
  const claim = readClaim(env);
  if (!claim || !owner || owner.token !== claim.token || owner.pid !== claim.pid || owner.process_started !== claim.process_started) return null;
  const ownerStarted = inspect(owner.pid);
  if (!ownerStarted || ownerStarted === UNKNOWN_LIVE || ownerStarted !== owner.process_started) return null;
  const current = relation(pid);
  if (!current) return null;
  const group = groupsOf(owner).find(value => value.group_id === current.group);
  if (!group) return null;
  const started = inspect(group.group_id);
  if (!started || started === UNKNOWN_LIVE || started !== group.group_started) return null;
  const seen = new Set();
  let at = pid;
  // Process ancestry is bounded; ambiguous probes or cycles never grant access.
  for (let depth = 0; depth < 256 && at > 0 && !seen.has(at); depth += 1) {
    if (at === group.group_id) return claim;
    seen.add(at);
    const row = relation(at);
    if (!row || row.group !== group.group_id) return null;
    at = row.parent;
  }
  return null;
}

/** Isolated fixture factory only. Production uses the fixed cache root below. */
export function createHeavyWorkOwner(root, { inspect = identityOf, relation = inspectProcessRelation } = {}) {
  const queue = createProcessAdmissionQueue(root, { inspectProcess: inspect, ownerIsLive: heavyWorkOwnerIsLive, resource: 'the build/test slot of this place' });
  const inherited = env => verifiedHeavyWorkClaim(queue.readOwner(), { env, inspect, relation });
  return {
    inherited,
    async run(command, args, { env = process.env, onStart, onTermination, admissionTimeoutMs = 3600000, priority = 0, ...options } = {}) {
      let claim = inherited(env);
      const release = claim ? null : await queue.acquire({ signal: options.signal, priority, timeoutMs: admissionTimeoutMs });
      claim ??= release.claim;
      if (claim.process_started === UNKNOWN_LIVE) {
        await release?.();
        throw new Error('Could not verify the heavy-work owner incarnation.');
      }
      let started = false, stopped = false;
      try {
        return await runOwnedProcess(command, args, { timeoutMs: 14400000, maxBytes: 64 * 1024 * 1024, ...options,
          env: { ...env, [HEAVY_WORK_CLAIM]: JSON.stringify(claim) },
          onStart: async descriptor => {
            started = true;
            // A nested owned supervisor receives its own registered group. An
            // arbitrary detached child cannot grant itself this registration.
            if (!release && !inherited(env)) throw new Error('The inherited heavy-work claim is no longer valid.');
            await queue.bindProcessGroup(claim, descriptor.groupId);
            await onStart?.(descriptor);
          },
          onTermination: (termination, detail) => {
            stopped = detail.processGroupStopped;
            onTermination?.(termination, detail);
          },
        });
      } finally {
        // Inconclusive group cleanup retains the lease, rather than admitting a
        // competing job based on the direct child's exit alone.
        if (release && (!started || stopped)) {
          const waitingAt = Date.now();
          let liveGroup;
          do {
            liveGroup = groupsOf(queue.readOwner()).find(group => sameLiveProcess({ pid: group.group_id, process_started: group.group_started }, inspect));
            if (!liveGroup) break;
            await new Promise(resolve => setTimeout(resolve, 20));
          } while (Date.now() - waitingAt < 2000);
          if (liveGroup) throw groupCleanupError('exhausted-wait', liveGroup.group_id, Date.now(), waitingAt);
          await release();
        }
      }
    },
  };
}

let localOwner;
const currentOwner = () => localOwner ??= createHeavyWorkOwner(ROOT);
export const hasHeavyWorkClaim = () => Boolean(currentOwner().inherited(process.env));

export async function runHeavyProcess(command, args, options = {}) {
  return currentOwner().run(command, args, options);
}

/** Guard a canonical CLI before it touches build output. Hosted CI retains its existing lane. */
export async function enterHeavyWork({ hosted = false, force = false } = {}) {
  if (hosted || (!force && hasHeavyWorkClaim())) return;
  const controller = new AbortController();
  const stop = signal => controller.abort(Object.assign(new Error(`Local heavy work was cancelled by ${signal}.`), { code: 'ABORT_ERR' }));
  const terminate = () => stop('SIGTERM'), interrupt = () => stop('SIGINT');
  process.once('SIGTERM', terminate); process.once('SIGINT', interrupt);
  let code = 0;
  try {
    await runHeavyProcess(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      cwd: process.cwd(), signal: controller.signal, input: process.stdin,
      onStdout: chunk => process.stdout.write(chunk), onStderr: chunk => process.stderr.write(chunk),
    });
  } catch (error) {
    code = error.ownerTermination?.worker_exit_code || 1;
    process.stderr.write(`${error.message}\n`);
  } finally {
    process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', interrupt);
  }
  process.exit(code);
}
