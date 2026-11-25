#!/usr/bin/env node
// tools/keep-an-elestio-update-schedule/do-work/keep-an-elestio-update-schedule.mjs
//
// PURPOSE: tool:keep-an-elestio-update-schedule, run in the tool container. Reads the request on stdin ({ email, project_id,
// vm_id, system?, app?, apply?, wait_seconds?, poll_seconds? }) and makes one Elestio service's two update schedules equal
// what it is given:
// - system ({ enabled, security_only, day, hour, minute }): Elestio's OS updates, its Sunday-style cron run of
//   unattended-upgrades (systemAutoUpdateEnable / systemAutoUpdateDisable). Elestio calls its time "RebootDayOfWeek" and
//   "RebootHour", but it is the time the updates run: whether a run reboots is the computer's own apt setting
//   (Unattended-Upgrade::Automatic-Reboot), which a computer row keeps (Nov 25 2026: 99-no-automatic-reboot, false).
// - app ({ enabled, day, hour, minute }): Elestio's software updates, its weekly watchtower run (appAutoUpdateEnable /
//   appAutoUpdateDisable). A container that must keep its pinned image says so itself (com.centurylinklabs.watchtower.enable
//   false), so this schedule can stay on for Elestio's own containers.
// 1. trades the vault's Elestio API token (descriptor 4, elestio-api-key) for a session (tool:keep-an-elestio-firewall's signIn);
// 2. reads the service (servers/getServerDetails: system_AutoUpdate_* and app_AutoUpdate_*);
// 3. when apply is not false and a schedule differs, sends that schedule's enable (with its fields) or disable;
// 4. reads back every poll_seconds until both are equal, or wait_seconds pass.
// A schedule the request does not name is only read. The schedules are the caller's DATA (each computer's row); this file holds
// none of them. Hours and minutes are UTC, as Elestio keeps them. No answer or error carries the token or the session.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeElestio, signIn } from '../../keep-an-elestio-firewall/do-work/keep-an-elestio-firewall.mjs';

const HELD_DESCRIPTOR = 4;
const whole = (value, low, high, what) => {
  if (!Number.isInteger(value) || value < low || value > high) throw new Error(`${what} takes a whole number from ${low} to ${high}`);
  return value;
};

/** One schedule as given, checked, in one spelling: { enabled, day, hour, minute } (and security_only for the system one). */
export function checkedSchedule(given, kind) {
  if (given === undefined) return undefined;
  if (!given || typeof given !== 'object' || typeof given.enabled !== 'boolean') throw new Error(`${kind} takes { enabled: true or false, ... }`);
  if (!given.enabled) return { enabled: false };
  return {
    enabled: true,
    ...(kind === 'system' ? { security_only: given.security_only !== false } : {}),
    day: whole(given.day, 0, 6, `${kind}.day (0 Sunday to 6 Saturday)`),
    hour: whole(given.hour, 0, 23, `${kind}.hour (UTC)`),
    minute: whole(given.minute ?? 0, 0, 59, `${kind}.minute`),
  };
}

/** The two schedules a service's details say. */
export function schedulesIn(service) {
  const system = Number(service.system_AutoUpdate_Enabled) === 1
    ? { enabled: true, security_only: Number(service.system_AutoUpdate_SecurityPatchesOnly) === 1, day: Number(service.system_AutoUpdate_RebootDayOfWeek),
      hour: Number(service.system_AutoUpdate_RebootHour), minute: Number(service.system_AutoUpdate_RebootMinute ?? 0) }
    : { enabled: false };
  const app = Number(service.app_AutoUpdate_Enabled) === 1
    ? { enabled: true, day: Number(service.app_AutoUpdate_DayOfWeek), hour: Number(service.app_AutoUpdate_Hour), minute: Number(service.app_AutoUpdate_Minute ?? 0) }
    : { enabled: false };
  return { system, app };
}

const same = (have, want) => want === undefined || JSON.stringify(have) === JSON.stringify(want);
const pad = n => String(n).padStart(2, '0');

/** The call that makes one schedule equal `want`. */
export function callFor(kind, want) {
  if (kind === 'system') return want.enabled
    ? { action: 'systemAutoUpdateEnable', systemAutoUpdateSecurityPatchesOnly: want.security_only, systemAutoUpdateRebootDayOfWeek: String(want.day),
      systemAutoUpdateRebootHour: String(want.hour), systemAutoUpdateRebootMinute: pad(want.minute) }
    : { action: 'systemAutoUpdateDisable' };
  return want.enabled
    ? { action: 'appAutoUpdateEnable', appAutoUpdateDayOfWeek: want.day, appAutoUpdateHour: want.hour, appAutoUpdateMinute: want.minute }
    : { action: 'appAutoUpdateDisable' };
}

/** The answer for one request. `read` gives the held token, `post` sends one API call, `wait` waits ms, `now` is ms; `jwt`,
 *  when given, is a session already signed in. */
export async function keepAnElestioUpdateSchedule(request, {
  read = () => readFileSync(HELD_DESCRIPTOR, 'utf8'),
  post = makeElestio(),
  wait = ms => new Promise(done => setTimeout(done, ms)),
  now = () => Date.now(),
  jwt: signedIn = null,
} = {}) {
  const { email, project_id: projectID, vm_id: vmID } = request;
  const want = { system: checkedSchedule(request.system, 'system'), app: checkedSchedule(request.app, 'app') };
  const apply = request.apply !== false;
  const waitMs = (request.wait_seconds ?? 120) * 1000;
  const pollMs = (request.poll_seconds ?? 5) * 1000;

  const jwt = signedIn ?? await signIn(email, { read, post });
  const ids = { jwt, vmID: String(vmID) };
  const state = async () => {
    const details = await post('getServerDetails', 'servers/getServerDetails', { ...ids, projectID: String(projectID) });
    const service = (details.serviceInfos ?? [details.data ?? details]).flat()[0];
    if (!service || String(service.vmID ?? vmID) !== String(vmID)) throw new Error(`getServerDetails answered no service ${vmID}`);
    return schedulesIn(service);
  };
  const owed = have => ['system', 'app'].filter(kind => !same(have[kind], want[kind]));

  const before = await state();
  const sent = [];
  const askedAt = now();
  if (apply) for (const kind of owed(before)) {
    const call = callFor(kind, want[kind]);
    await post(call.action, 'servers/DoActionOnServer', { ...ids, ...call });
    sent.push(call.action);
  }
  let after = before, reads = 0;
  if (sent.length) {
    for (;;) {
      after = await state();
      reads += 1;
      if (!owed(after).length || now() - askedAt >= waitMs) break;
      await wait(pollMs);
    }
  }
  const left = owed(after);
  const ok = left.length === 0;
  const reason = ok ? null : !apply ? 'apply was false: nothing was sent' : `${left.join(' and ')} still differ${left.length === 1 ? 's' : ''} after ${Math.round(waitMs / 1000)} s`;
  return {
    ok,
    vm_id: String(vmID),
    sent,
    before,
    after,
    ...(ok ? {} : { still_differs: Object.fromEntries(left.map(kind => [kind, { have: after[kind], want: want[kind] }])) }),
    asked_at: sent.length ? new Date(askedAt).toISOString() : null,
    reads,
    ...(reason ? { reason } : {}),
  };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  keepAnElestioUpdateSchedule(JSON.parse(readFileSync(0, 'utf8') || '{}'))
    .then(answer => process.stdout.write(`${JSON.stringify(answer)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
