// src/device-rows.mjs
//
// Purpose
//   A step on the person's Waiting on you list can be about one kind of device (a Sony camera, a printer). Someone who
//   owns no such device is never asked to do it: the row is left out of everything that shows the person what waits,
//   until something of theirs shows the device. Which rows, what shows a device and the account walk's words are DATA
//   (src/waiting-on-you.json `devices`).
//
// Non-negotiable invariants
//   1. A row is about a device when it carries `device`, or (a row written before that field) when its id starts with a
//      `legacy_rows` prefix, the rest of the id being the model. A row about no device is never touched here.
//   2. A device is shown by the person's device facts or by their files, matched as a whole word in any case:
//      ILCE-7M4 is shown by "SONY ILCE-7M4" and by "FaceTime HD Camera, ILCE-7M4", never by "ILCE-7M4X".
//   3. Only a definite "nothing shows it" hides a row. A read that failed shows the row and removes nothing.
//   4. One check stands in every reader (PersonStore.waitingOnYou), so a row hidden from one is hidden from all.
//
// Security: reads only this person's own facts and files; the account walk answers counts and row ids, no value.
//


export const DEVICE_ROWS_PATH = '/waiting-on-you/device-rows/clean';

/** The model a row is about (uppercase), or null when it is about no device. `rules` is waiting-on-you.json `devices`.
 *  A row that carries a `device` field, even an empty one (any camera that can send by FTP), is about what that field says. */
export function deviceOfRow(id, values, rules) {
  if (typeof values?.device === 'string') {
    const given = values.device.trim();
    return given ? given.toUpperCase() : null;
  }
  const legacy = legacyEntry(id, rules);
  const rest = legacy ? String(id).slice(legacy.id_prefix.length).trim() : '';
  return rest ? rest.toUpperCase() : null;
}

/** The `legacy_rows` entry a row id starts with, or null. */
export function legacyEntry(id, rules) {
  return (rules?.legacy_rows ?? []).find(entry => String(id ?? '').startsWith(entry.id_prefix)) ?? null;
}

/** Whether `text` names the model as a whole word, in any case. */
export function namesDevice(text, model) {
  if (typeof text !== 'string' || !model) return false;
  const escaped = String(model).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i').test(text);
}

/** A device facts report shows the model when any one of its fact texts names it. */
export function factsShowDevice(reports, model) {
  return (reports ?? []).some(report => Object.values(report?.facts ?? {}).some(text => namesDevice(text, model)));
}

/**
 * One page of every account: each has its unowned device rows cleaned (PersonStore.cleanUpDeviceRows). Only the holder of
 * a ticket (src/held-values-rotation.mjs ticketSlot, made by scripts/clean-unowned-device-rows.mjs) may call it.
 * POST { cursor?, dry? } (dry writes nothing and answers what would go) answers { walked, dry, cleaned, would_clean, already, accounts: [{ account, rows, login_removed }], not_yet, cursor }.
 */
export async function handleDeviceRowsRequest(request, { authorized, accountsOnPage, cleanUpDeviceRows }) {
  if (!await authorized(request)) return Response.json({ error: 'Not allowed.' }, { status: 403 });
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const dry = body?.dry === true;
  const page = await accountsOnPage({ cursor: typeof body?.cursor === 'string' ? body.cursor : null });
  const reports = await Promise.all(page.accounts.map(async account => {
    try { return { account, ...(await cleanUpDeviceRows(account, { dry })) }; } catch (error) { return { account, reason: String(error.message ?? error) }; }
  }));
  return Response.json({
    walked: reports.length,
    dry,
    cleaned: reports.filter(report => report.cleaned).length,
    would_clean: reports.filter(report => report.would_clean).length,
    already: reports.filter(report => report.already).length,
    accounts: reports.filter(report => report.cleaned || report.would_clean).map(({ account, rows, login_removed }) => ({ account, rows, login_removed })),
    not_yet: reports.filter(report => report.reason).map(({ account, reason }) => ({ account, reason })),
    cursor: page.cursor,
  });
}
