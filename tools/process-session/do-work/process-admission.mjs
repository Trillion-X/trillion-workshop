// Reusable cross-process exclusive admission. Callers own fixed resource roots.
// The queue lives in the user's cache, not in a caller-selected workspace.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const GUARD = 'state.guard';
const GUARD_STALE_MS = 5000;
const POLL_MS = 180;
const PROBE_OPTIONS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, killSignal: 'SIGKILL' };
export const UNKNOWN_LIVE = 'unverified-live-process';
// This process's own start time cannot change while it runs, so it is asked of ps once: every acquire, guard entry and
// own-ticket check asked again, and each ps costs hundreds of milliseconds on a loaded computer.
let ownIdentity = null;
export const identityOf = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid && ownIdentity) return ownIdentity;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== 'EPERM') return null;
  }
  let started;
  try { started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], PROBE_OPTIONS).trim() || UNKNOWN_LIVE; }
  catch { started = UNKNOWN_LIVE; }
  if (pid === process.pid && started !== UNKNOWN_LIVE) ownIdentity = started;
  return started;
};

export const sameLiveProcess = (record, inspect = identityOf) => {
  if (!record || record.pid !== Number(record.pid)) return false;
  const started = inspect(record.pid);
  // A lease recorded while its metadata probe was unavailable can only be judged by liveness.
  if (record.process_started === UNKNOWN_LIVE) return started !== null;
  // An unavailable metadata probe cannot turn a still-live lease into a dead one.
  return started === UNKNOWN_LIVE || Boolean(started && started === record.process_started);
};

function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function observeOwner(path) {
  try {
    const bytes = readFileSync(path, 'utf8');
    return { bytes, record: JSON.parse(bytes) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function pause(ms, signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Local work admission was cancelled.', 'AbortError');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Local work admission was cancelled.', 'AbortError')); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function withStateGuard(root, work, { signal, deadline } = {}) {
  const guard = join(root, GUARD);
  const token = randomUUID();
  const processStarted = identityOf(process.pid);
  if (!processStarted) throw new Error('Could not verify this process for local work admission.');
  for (;;) {
    const staging = `${guard}.staging.${token}`;
    try {
      // Publish the guard already holding its owner record, so no other process can see it empty or ownerless.
      mkdirSync(staging);
      atomicJson(join(staging, 'owner.json'), { pid: process.pid, process_started: processStarted, token, created_at: Date.now() });
      renameSync(staging, guard);
      break;
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      const held = readJson(join(guard, 'owner.json'));
      let stale = held ? !sameLiveProcess(held) : false;
      if (!held) {
        try { stale = Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS; } catch { stale = true; }
      }
      if (stale) {
        // Move the judged guard aside first, then confirm it is still the one judged stale. A fresh owner that
        // published the path in the meantime is put back, never deleted.
        const retired = `${guard}.retired.${randomUUID()}`;
        try {
          renameSync(guard, retired);
          const moved = readJson(join(retired, 'owner.json'));
          if ((moved?.token ?? null) === (held?.token ?? null)) rmSync(retired, { recursive: true, force: true });
          else { try { renameSync(retired, guard); } catch (restoreError) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(restoreError.code)) throw restoreError; } }
        } catch (moveError) {
          if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(moveError.code)) throw moveError;
        }
        continue;
      }
      if (signal?.aborted) throw signal.reason ?? new DOMException('Local work admission was cancelled.', 'AbortError');
      const remaining = deadline === undefined ? POLL_MS : Math.min(POLL_MS, deadline - Date.now());
      if (remaining <= 0) throw new Error('Timed out coordinating local work admission.');
      await pause(remaining, signal);
    }
  }
  try { return await work(); }
  finally {
    const held = readJson(join(guard, 'owner.json'));
    if (held?.token === token) {
      // Remove this exact guard by moving it out of the shared path first. Recursive
      // deletion in place can race a queued process publishing its next owner at the
      // same path, making this release fail with ENOTEMPTY.
      // A prior failed restoration can retain a foreign guard from this attempt.
      // Each move needs its own destination so release never collides with it.
      const retired = `${guard}.retired.${randomUUID()}`;
      try {
        renameSync(guard, retired);
        const moved = readJson(join(retired, 'owner.json'));
        if (moved?.token === token) rmSync(retired, { recursive: true, force: true });
        else { try { renameSync(retired, guard); } catch (restoreError) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(restoreError.code)) throw restoreError; } }
      } catch (moveError) {
        if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(moveError.code)) throw moveError;
      }
    }
  }
}

function ticketOrder(a, b) { return b.priority - a.priority || a.created_at - b.created_at || a.id.localeCompare(b.id); }

/** Internal queue factory permits isolated filesystem tests; production callers use the fixed cache-backed wrapper. */
export function createProcessAdmissionQueue(root, { isBlocked = () => false, inspectProcess = identityOf, ownerIsLive = sameLiveProcess, resource = 'local work', maxPriorityOvertakeMs = 300000 } = {}) {
  if (!Number.isFinite(maxPriorityOvertakeMs) || maxPriorityOvertakeMs < 0) throw new Error('Local work needs a finite nonnegative priority overtaking window.');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tickets = join(root, 'tickets');
  mkdirSync(tickets, { recursive: true, mode: 0o700 });
  const ownerPath = join(root, 'owner.json');

  const bindProcessGroup = async (claim, groupId) => {
    const started = inspectProcess(groupId);
    if (!Number.isInteger(groupId) || groupId <= 0 || !started || started === UNKNOWN_LIVE) {
      throw new Error('Could not verify the admitted process group.');
    }
    await withStateGuard(root, () => {
      const owner = readJson(ownerPath);
      if (owner?.token !== claim.token || owner.pid !== claim.pid || owner.process_started !== claim.process_started) {
        throw new Error('The local work claim is no longer held.');
      }
      const groups = (owner.process_groups ?? []).filter(group => group.group_id !== groupId);
      groups.push({ group_id: groupId, group_started: started });
      atomicJson(ownerPath, { ...owner, group_id: owner.group_id ?? groupId,
        group_started: owner.group_started ?? started, process_groups: groups });
    });
  };

  const retireTicket = id => rmSync(join(tickets, `${id}.json`), { force: true });
  const inspectDeadTickets = (signal, deadline) => {
    const dead = [];
    for (const name of readdirSync(tickets)) {
      if (!name.endsWith('.json')) continue;
      const path = join(tickets, name);
      const observed = observeOwner(path);
      if (observed && !sameLiveProcess(observed.record, inspectProcess)) dead.push({ path, bytes: observed.bytes });
      if (signal?.aborted) throw signal.reason ?? new DOMException('Local work admission was cancelled.', 'AbortError');
      if (Date.now() >= deadline) break;
    }
    return dead;
  };
  const release = token => withStateGuard(root, () => {
    const owner = readJson(ownerPath);
    if (owner?.token === token) rmSync(ownerPath, { force: true });
  });

  return {
    readOwner: () => readJson(ownerPath),
    bindProcessGroup,
    async acquire({ priority = 0, signal, timeoutMs = 600000 } = {}) {
      if (!Number.isSafeInteger(priority)) throw new Error('Local work admission priority must be a safe integer.');
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Local work admission needs a positive bounded timeout.');
      if (signal?.aborted) throw signal.reason ?? new DOMException('Local work admission was cancelled.', 'AbortError');
      const id = randomUUID();
      const processStarted = inspectProcess(process.pid);
      if (!processStarted) throw new Error('Could not verify this process for local work admission.');
      const createdAt = Date.now();
      let admittedPriority = priority;
      // Bound how long newer urgent work may keep overtaking an existing waiter.
      // Normalize only the NEW ticket: the unchanged comparator is also used by
      // already-running queue clients, so changing its interpretation would make
      // mixed clients disagree about the winner. Old tickets and the live holder
      // remain untouched. A dead ticket can conservatively cap an arrival until
      // the existing exact-byte cleanup removes it before admission.
      for (const name of readdirSync(tickets)) {
        if (!name.endsWith('.json')) continue;
        const queued = readJson(join(tickets, name));
        if (Number.isSafeInteger(queued?.priority) && Number.isFinite(queued?.created_at)
          && createdAt - queued.created_at >= maxPriorityOvertakeMs) admittedPriority = Math.min(admittedPriority, queued.priority);
      }
      const ticket = { id, pid: process.pid, process_started: processStarted, priority: admittedPriority, created_at: createdAt,
        ...(admittedPriority === priority ? {} : { requested_priority: priority }) };
      const ticketPath = join(tickets, `${id}.json`);
      atomicJson(ticketPath, ticket);
      const deadline = Date.now() + timeoutMs;
      let acquired = false;
      try {
        while (Date.now() < deadline) {
          if (signal?.aborted) throw signal.reason ?? new DOMException('Local work admission was cancelled.', 'AbortError');
          // Process inspection can be slow on a busy Mac. Keep it outside the
          // file lock, and never apply its answer to a replacement owner.
          const observedOwner = observeOwner(ownerPath);
          const observedOwnerIsLive = observedOwner && ownerIsLive(observedOwner.record, inspectProcess);
          if (signal?.aborted) throw signal.reason ?? new DOMException('Local work admission was cancelled.', 'AbortError');
          if (Date.now() >= deadline) break;
          const latestOwner = observeOwner(ownerPath);
          const slotAvailable = !latestOwner || (latestOwner.bytes === observedOwner?.bytes && !observedOwnerIsLive);
          // Waiting cannot acquire or mutate anything while the observed owner
          // is live. Do not compete with its process-group registration for the
          // state lock; many queued callers can otherwise starve that handshake.
          if (!slotAvailable) {
            await pause(Math.min(1000, Math.max(1, deadline - Date.now())), signal);
            continue;
          }
          // Ticket and legacy-browser probes are slow too. Inspect without the
          // lock, then apply dead-ticket answers only to those exact bytes.
          const deadTickets = slotAvailable ? inspectDeadTickets(signal, deadline) : [];
          if (signal?.aborted) throw signal.reason ?? new DOMException('Local work admission was cancelled.', 'AbortError');
          if (Date.now() >= deadline) break;
          const blocked = slotAvailable ? isBlocked() : true;
          if (signal?.aborted) throw signal.reason ?? new DOMException('Local work admission was cancelled.', 'AbortError');
          if (Date.now() >= deadline) break;
          const result = await withStateGuard(root, () => {
            if (signal?.aborted) throw signal.reason ?? new DOMException('Local work admission was cancelled.', 'AbortError');
            if (Date.now() >= deadline) return false;
            const owner = observeOwner(ownerPath);
            if (owner) {
              if (owner.bytes !== observedOwner?.bytes || observedOwnerIsLive) return false;
              rmSync(ownerPath, { force: true });
            }
            for (const dead of deadTickets) {
              if (observeOwner(dead.path)?.bytes === dead.bytes) rmSync(dead.path, { force: true });
            }
            const queued = readdirSync(tickets).filter(name => name.endsWith('.json'))
              .map(name => readJson(join(tickets, name))).filter(Boolean).sort(ticketOrder);
            if (readJson(ownerPath) || queued[0]?.id !== id || blocked) return false;
            atomicJson(ownerPath, { ...ticket, token: id, acquired_at: Date.now() });
            return true;
          }, { signal, deadline });
          if (result) { acquired = true; break; }
          await pause(Math.min(POLL_MS, Math.max(1, deadline - Date.now())), signal);
        }
        if (!acquired) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${resource}.`);
        retireTicket(id);
        let released = false;
        const done = async () => {
          if (released) return;
          await release(id);
          released = true;
        };
        done.claim = { token: id, pid: ticket.pid, process_started: ticket.process_started };
        done.bindProcessGroup = async groupId => {
          if (released) throw new Error('The local work claim is no longer held.');
          await bindProcessGroup(done.claim, groupId);
        };
        return done;
      } catch (error) {
        retireTicket(id);
        throw error;
      }
    },
  };
}

