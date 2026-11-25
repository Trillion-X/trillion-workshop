// tools/keep-an-elestio-update-schedule/test/keep-an-elestio-update-schedule.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callFor, checkedSchedule, keepAnElestioUpdateSchedule, schedulesIn } from '../do-work/keep-an-elestio-update-schedule.mjs';

const request = { email: 'owner@example.test', project_id: '90000', vm_id: '170000000', poll_seconds: 1 };
const SYSTEM = { enabled: true, security_only: true, day: 0, hour: 5, minute: 0 };
const APP = { enabled: true, day: 0, hour: 1, minute: 0 };

// A stand-in Elestio service: `details` are its getServerDetails fields; a call takes effect after `lag` reads.
function standIn(details, { lag = 0, never = false } = {}) {
  const asked = [];
  let pending = [], reads = 0;
  const post = async (step, path, body) => {
    asked.push({ step, body });
    if (path === 'auth/checkAPIToken') return { status: 'OK', jwt: 'made-up-session' };
    if (path === 'servers/getServerDetails') {
      reads += 1;
      for (const change of pending.filter(item => reads > item.at)) Object.assign(details, change.fields);
      pending = pending.filter(item => reads <= item.at);
      return { status: 'OK', serviceInfos: [{ vmID: body.vmID, token: 'made-up-service-token', ...details }] };
    }
    if (never) return { status: 'OK' };
    const fields = {
      systemAutoUpdateEnable: { system_AutoUpdate_Enabled: 1, system_AutoUpdate_SecurityPatchesOnly: body.systemAutoUpdateSecurityPatchesOnly ? 1 : 0,
        system_AutoUpdate_RebootDayOfWeek: Number(body.systemAutoUpdateRebootDayOfWeek), system_AutoUpdate_RebootHour: Number(body.systemAutoUpdateRebootHour),
        system_AutoUpdate_RebootMinute: Number(body.systemAutoUpdateRebootMinute) },
      systemAutoUpdateDisable: { system_AutoUpdate_Enabled: 0 },
      appAutoUpdateEnable: { app_AutoUpdate_Enabled: 1, app_AutoUpdate_DayOfWeek: body.appAutoUpdateDayOfWeek, app_AutoUpdate_Hour: body.appAutoUpdateHour, app_AutoUpdate_Minute: body.appAutoUpdateMinute },
      appAutoUpdateDisable: { app_AutoUpdate_Enabled: 0 },
    }[body.action];
    if (!fields) throw new Error(`unexpected ${path} ${body.action}`);
    pending.push({ fields, at: reads + lag });
    return { status: 'OK' };
  };
  return { asked, post };
}
const live = () => ({ system_AutoUpdate_Enabled: 1, system_AutoUpdate_SecurityPatchesOnly: 1, system_AutoUpdate_RebootDayOfWeek: 0, system_AutoUpdate_RebootHour: 5,
  system_AutoUpdate_RebootMinute: 0, app_AutoUpdate_Enabled: 1, app_AutoUpdate_DayOfWeek: 0, app_AutoUpdate_Hour: 1, app_AutoUpdate_Minute: 0 });
function clock(start = Date.parse('2026-11-25T15:30:00Z')) {
  let at = start;
  return { now: () => at, wait: async ms => { at += ms; } };
}
const run = (details, extra = {}, options = {}) => {
  const { asked, post } = standIn(details, options);
  return keepAnElestioUpdateSchedule({ ...request, ...extra }, { read: () => 'made-up-token\n', post, ...clock() }).then(answer => ({ answer, asked }));
};
const actions = asked => asked.map(call => call.body.action).filter(Boolean);

test('schedules equal to the request are only read', async () => {
  const { answer, asked } = await run(live(), { system: SYSTEM, app: APP });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.sent, []);
  assert.deepEqual(actions(asked), []);
  assert.deepEqual(answer.before, { system: SYSTEM, app: APP });
});

test('a schedule that differs is sent with its fields, and read back', async () => {
  const { answer, asked } = await run(live(), { system: { ...SYSTEM, day: 3, hour: 9 } }, { lag: 2 });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.sent, ['systemAutoUpdateEnable']);
  const call = asked.find(item => item.body.action === 'systemAutoUpdateEnable').body;
  assert.deepEqual({ ...call, jwt: undefined }, { jwt: undefined, vmID: '170000000', action: 'systemAutoUpdateEnable', systemAutoUpdateSecurityPatchesOnly: true,
    systemAutoUpdateRebootDayOfWeek: '3', systemAutoUpdateRebootHour: '9', systemAutoUpdateRebootMinute: '00' });
  assert.deepEqual(answer.after.system, { ...SYSTEM, day: 3, hour: 9 });
  assert.equal(answer.reads, 3);
});

test('a schedule switched off is disabled, and one the request does not name is left alone', async () => {
  const { answer, asked } = await run(live(), { app: { enabled: false } });
  assert.deepEqual(actions(asked), ['appAutoUpdateDisable']);
  assert.deepEqual(answer.after.app, { enabled: false });
  assert.deepEqual(answer.after.system, SYSTEM);
});

test('apply false only reads and says what differs', async () => {
  const { answer, asked } = await run(live(), { app: { enabled: false }, apply: false });
  assert.equal(answer.ok, false);
  assert.deepEqual(actions(asked), []);
  assert.match(answer.reason, /apply was false/);
  assert.deepEqual(answer.still_differs.app, { have: APP, want: { enabled: false } });
});

test('a schedule Elestio never takes is said after wait_seconds', async () => {
  const { answer } = await run(live(), { system: { ...SYSTEM, hour: 4 }, wait_seconds: 10 }, { never: true });
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /system still differs after 10 s/);
});

test('shapes outside the schedule are refused before any call', async () => {
  assert.throws(() => checkedSchedule({ enabled: true, day: 7, hour: 1 }, 'app'), /app\.day/);
  assert.throws(() => checkedSchedule({ enabled: true, day: 0, hour: 24 }, 'system'), /system\.hour/);
  assert.throws(() => checkedSchedule({ day: 0 }, 'system'), /enabled/);
  assert.deepEqual(checkedSchedule({ enabled: true, day: 0, hour: 5 }, 'system'), SYSTEM);
  assert.deepEqual(callFor('app', { enabled: false }), { action: 'appAutoUpdateDisable' });
  assert.deepEqual(schedulesIn({ system_AutoUpdate_Enabled: 0, app_AutoUpdate_Enabled: 0 }), { system: { enabled: false }, app: { enabled: false } });
  await assert.rejects(run(live(), { system: { enabled: true, day: 9, hour: 1 } }), /system\.day/);
});
