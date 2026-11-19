// src/workspace/alone-notices.mjs
//
// PURPOSE
//   The notices loop of the page shown alone (alone-page.tsx): the person's notices for this device are read through the
//   Workshop (workflow:read-my-device-notices, run by tool:run-workflow-definition), each new one is told to the host to
//   show as a notification, and a tap from the host marks the notice read and acts on it (workflow:mark-my-notices-read,
//   then workflow:act-on-my-notice). The loop keeps no notice of its own: the only thing it keeps is the cursor the device
//   keeps, in the browser's storage, one per device.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Notices are read only by the three workflows, through the one tool road the page already uses (run, given by
//      alone-page.tsx); nothing here reads a store or names a login. The device id is this browser's own (deviceIdOf).
//   2. The cursor advances only after every notice the read returned was told to the host, so a read the host could not
//      take is read again at the next tick or wake.
//   3. Each notice is told once per device: a notice above the cursor is told; a notice at or below it never is.
//   4. register_device is told once per page, before the first read, so the device's registration exists when the
//      workflow reads it. A read that fails because the registration is not there yet is tried again.
//   5. A failed read or run keeps the cursor and the page as they were; nothing is shown as read that the store did not
//      mark read.
//   6. A tap (`notice_tapped` from the host, through the host entry of alone-page.tsx invariant 4) marks the notice read, then acts on its
//      one offered action, open. The path the action answers is returned for the page to open in place; a refused action
//      keeps the page as it is (the mark still stands).
//   7. Timing and the read size are DATA (alone-page.json `notices`); the host message kinds are DATA (`host_kinds`) and
//      must equal TO_HOST_KINDS and FROM_HOST_KINDS below (alone-notices.test.mjs holds that).

export const NOTICE_WORKFLOWS = Object.freeze({
  read: 'workflow:read-my-device-notices',
  mark: 'workflow:mark-my-notices-read',
  act: 'workflow:act-on-my-notice',
});
export const TO_HOST_KINDS = Object.freeze(['notify', 'register_device']);
export const FROM_HOST_KINDS = Object.freeze(['notice_tapped']);

const cursorKey = deviceId => `notice-cursor:${deviceId}`;
const DEVICE_KEY = 'notice-device-id';

/** This page's device id: made once in the browser's storage and kept there, so every read and the registration use the
 *  same id. It does not depend on a device copy, which a show rule may hide. */
export function deviceIdOf(storage, make = () => crypto.randomUUID()) {
  const kept = storage.getItem(DEVICE_KEY);
  if (kept) return kept;
  const id = make();
  storage.setItem(DEVICE_KEY, id);
  return id;
}

/**
 * Starts the loop. `database()` and `deviceId()` return the person's database name and this device's id, or null when
 * not known yet (then nothing is read). `run(row, input)` runs a Workshop workflow and answers its result. `tell(message)`
 * posts a message to the host. `open(path)` opens a path of this site in place. `storage` is a Web Storage-like object.
 * `settings` is alone-page.json `notices` ({ poll_seconds, limit }). `deviceId()` answers this device's id (deviceIdOf).
 */
export function keepNotices({ database, deviceId, run, tell, open, storage, settings }) {
  let registered = false;
  let reading = false;

  async function readNew() {
    if (reading) return;
    reading = true;
    try {
      const name = await database();
      const device = await deviceId();
      if (!name || !device) return;
      if (!registered) {
        tell({ kind: 'register_device', device_id: device });
        registered = true;
      }
      const key = cursorKey(device);
      const after = Number(storage.getItem(key) ?? 0);
      const answer = await run(NOTICE_WORKFLOWS.read, { database: name, device_id: device, after, limit: settings.limit });
      for (const notice of answer.notices) tell({ kind: 'notify', id: notice.id, title: notice.title, body: notice.body });
      storage.setItem(key, String(answer.cursor));
    } catch {
      // Invariants 2 and 5: the cursor stays where it was and the next tick or wake reads again.
    } finally {
      reading = false;
    }
  }

  async function tap(id) {
    const name = await database();
    if (!name) return null;
    await run(NOTICE_WORKFLOWS.mark, { database: name, ids: [id] });
    const acted = await run(NOTICE_WORKFLOWS.act, { database: name, id, action: 'open' });
    return typeof acted.open === 'string' ? acted.open : null;
  }

  // Answers a message the host sent through the host entry of alone-page.tsx. A kind this page does not take is not answered.
  function host(message) {
    if (!message || typeof message !== 'object' || !FROM_HOST_KINDS.includes(message.kind)) return false;
    if (typeof message.id !== 'string') return false;
    tap(message.id)
      .then(path => { if (path) open(path); })
      // Invariant 6: a refused action keeps the page as it is; the notice is already read or refused in the store.
      .catch(() => {});
    return true;
  }

  const timer = setInterval(() => { void readNew(); }, settings.poll_seconds * 1000);
  return {
    readNew,
    wake: () => { void readNew(); },
    host,
    stop: () => clearInterval(timer),
  };
}
