// extension/src/computer-host.mjs
//
// PURPOSE
//   Lets the extension ask the person's own computer directly, through the native messaging host the Trillion Mac app
//   places for this extension's exact id (extension/native-host/offer-in-browsers.mjs, extension/native-host/browser-native-host.mjs): which
//   computer answers, and how its Trillion files stand (the drive's typed sync status record).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The browser permission is optional and asked only when the person asks (`allow`); without it nothing is sent and
//      the answer says so (`state: not_allowed`), never an empty answer.
//   2. A computer with no host placed is its own state (`not_installed`), separate from a host that refused.
//   3. Only this extension's own documents may ask (the same sender check as the tray); the host name is DATA
//      (settings.json `computer_host`).

import settings from '../settings.json' with { type: 'json' };

const PERMISSION = { permissions: ['nativeMessaging'] };

/** One ask of the computer: { state: answered, answer } | { state: not_allowed | not_installed | refused, error? }. */
export async function askComputer(action, { browser = chrome } = {}) {
  if (!await browser.permissions.contains(PERMISSION)) return { state: 'not_allowed' };
  try {
    const answer = await browser.runtime.sendNativeMessage(settings.computer_host, { action });
    return answer?.ok ? { state: 'answered', answer } : { state: 'refused', error: answer?.error ?? null };
  } catch (error) { return { state: 'not_installed', error: String(error?.message ?? error) }; }
}

/** Asks the browser for the optional permission; only a click by the person can grant it. */
export const allowComputer = ({ browser = chrome } = {}) => browser.permissions.request(PERMISSION);

// Extension documents ask here: { trillion_computer: { action } } or { trillion_computer: { allow: true } }.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const asked = message?.trillion_computer;
  if (!asked || typeof asked !== 'object') return false;
  if (sender?.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  (asked.allow === true ? allowComputer().then(allowed => ({ state: allowed ? 'allowed' : 'not_allowed' })) : askComputer(String(asked.action ?? '')))
    .then(reply, error => reply({ state: 'refused', error: String(error?.message ?? error) }));
  return true;
});
