// extension/src/notice-worker.mjs
//
// PURPOSE
//   Trillion's notices reach this browser, with their actions. The background worker registers this browser as one of
//   the account's devices (a web push subscription registered through Workshop) whenever it starts and right after
//   the person signs in, shows each notice the account pushes as a browser notification whose buttons are the
//   notice's own actions, and counts unread notices on the toolbar badge (src/badge.mjs mark `unread`).
//
//   Pressing a button sends the action's id to Workshop with an idempotency key. An action that asks for words (`input`)
//   opens the extension's reply window (reply.html), since a browser notification has no text field; the window
//   hands the words back here and this sends them. Clicking the notice itself opens Trillion where the notice points,
//   in the Trillion tab already open when there is one.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here knows what an action does. The account answers `said` (shown) and `open` (opened).
//   2. Registering again with the same subscription keeps one device row (the account's rule), so it is done on every
//      start without a setup step. Device IDs, notices and actions stay scoped to the account that registered them.
//   3. The subscription is not tied to showing a notification (userVisibleOnly false, Chrome 121+): the notice is
//      shown with chrome.notifications so its buttons work, never a second time by the browser.
//   4. A notice shown is kept in session storage under an account-qualified notification ID until it is pressed or
//      closed, so a button pressed after the worker slept still finds it.

import { account, ORIGIN, runWorkshopTool, signedInAccount, SignInNeeded } from './trillion.mjs';
import { setMark } from './badge.mjs';
import { browserLabel, bytesFromBase64url, fill, notificationFor, sameBytes, unreadCount } from './notices.mjs';
import { openNotice } from './open-notice.mjs';
import { NOTIFICATION_TOOLS, browserDeviceRegistration, browserNoticeAction, browserNoticeList, browserNoticeRead } from './notice-tools.mjs';
import { keepWornLook } from './worn-look.mjs';
import settings from '../settings.json' with { type: 'json' };
import words from '../words.json' with { type: 'json' };

const said = words.notices;
const shape = { ...settings.notices, iconUrl: chrome.runtime.getURL(settings.notices.icon) };
const notificationId = (accountId, id) => `${encodeURIComponent(accountId)}::${encodeURIComponent(id)}`;
const stored = id => `notice:${id}`;
const DEVICE = 'browser-notification-device';
const NOTICE_STATE = 'browser-notification-state';
const ALARM = 'trillion-unread';

const keptNotice = async id => (await chrome.storage.session.get(stored(id)))[stored(id)] ?? null;
const forget = id => chrome.storage.session.remove(stored(id));

/** Registers this browser's push subscription as one of the account's devices; answers the account's device list. */
export async function registerThisBrowser() {
  const accountId = await signedInAccount();
  if (!accountId) return null;
  const keyAnswer = await runWorkshopTool(NOTIFICATION_TOOLS.publicKey, {}, {
    requestKey: crypto.randomUUID(), expectedAccount: accountId,
  });
  const key = keyAnswer?.applicationServerKey;
  if (!key) throw new Error('Trillion did not give a public push application key for this browser.');
  const applicationServerKey = bytesFromBase64url(key);
  const registeredDevice = (await chrome.storage.local.get(DEVICE))[DEVICE];
  let subscription = await self.registration.pushManager.getSubscription();
  if (subscription && (registeredDevice?.account && registeredDevice.account !== accountId
      || !sameBytes(subscription.options.applicationServerKey, applicationServerKey))) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await self.registration.pushManager.subscribe({ userVisibleOnly: false, applicationServerKey });
  const label = browserLabel({ brands: navigator.userAgentData?.brands ?? [], brave: Boolean(navigator.brave) }, said.browsers);
  const registered = await runWorkshopTool(NOTIFICATION_TOOLS.register, browserDeviceRegistration({ address: subscription.toJSON(), label }), {
    requestKey: crypto.randomUUID(), expectedAccount: accountId,
  });
  if (!registered?.device_id) throw new Error('Trillion did not confirm this browser notification device.');
  await chrome.storage.local.set({ [DEVICE]: { account: accountId, device_id: registered.device_id } });
  const previous = (await chrome.storage.local.get(NOTICE_STATE))[NOTICE_STATE];
  if (previous?.account !== accountId || previous?.device_id !== registered.device_id) {
    await chrome.storage.local.set({ [NOTICE_STATE]: { account: accountId, device_id: registered.device_id, cursor: 0, notices: [] } });
  }
  return registered;
}

/** Counts the account's unread notices onto the badge. */
export async function refreshUnread() {
  const accountId = await signedInAccount();
  if (!accountId) return setMark('unread', null);
  // The look the person wears is read on the same beat, so the badge and every extension page follow it.
  await keepWornLook(account).catch(() => false);
  let device = (await chrome.storage.local.get(DEVICE))[DEVICE];
  if (!device || device.account !== accountId) {
    await registerThisBrowser();
    device = (await chrome.storage.local.get(DEVICE))[DEVICE];
  }
  if (!device || device.account !== accountId) return setMark('unread', null);
  const state = (await chrome.storage.local.get(NOTICE_STATE))[NOTICE_STATE];
  const previous = state?.account === accountId && state?.device_id === device.device_id
    ? state : { account: accountId, device_id: device.device_id, cursor: 0, notices: [] };
  const answer = await runWorkshopTool(NOTIFICATION_TOOLS.list, browserNoticeList({ deviceId: device.device_id, after: previous.cursor }), {
    requestKey: crypto.randomUUID(), expectedAccount: accountId,
  });
  if (!Array.isArray(answer?.notices) || !Number.isSafeInteger(answer?.cursor)) throw new Error('Trillion did not return this browser’s notices.');
  const byId = new Map(previous.notices.map(notice => [notice.id, notice]));
  for (const notice of answer.notices) {
    if (typeof notice?.id !== 'string' || !notice.id.startsWith('told:')) continue;
    byId.set(notice.id, { ...byId.get(notice.id), ...notice });
    if (!notice.read) await showNotice(notice);
  }
  const notices = [...byId.values()];
  await chrome.storage.local.set({ [NOTICE_STATE]: { account: accountId, device_id: device.device_id, cursor: Math.max(previous.cursor, answer.cursor), notices } });
  return setMark('unread', unreadCount(notices) || null);
}

async function showNotice(notice) {
  if (!notice?.id) return;
  const accountId = await signedInAccount();
  if (!accountId) return;
  const id = notificationId(accountId, notice.id);
  await chrome.storage.session.set({ [stored(id)]: { ...notice, account: accountId, notification_id: id } });
  await chrome.notifications.create(id, notificationFor(notice, shape));
}

// A short notification with what happened, for a press whose window has nothing else to show it in.
const tell = (id, title, message) => chrome.notifications.create(`said:${id}`, { type: 'basic', iconUrl: shape.iconUrl, title, message, priority: 0 });

/** Opens Trillion at `path`, in the Trillion tab already open when there is one. */
export async function openInTrillion(path) {
  const url = new URL(path || '/', ORIGIN).href;
  const [open] = await chrome.tabs.query({ url: `${ORIGIN}/*` });
  if (!open) return chrome.tabs.create({ url });
  await chrome.tabs.update(open.id, { url, active: true });
  await chrome.windows.update(open.windowId, { focused: true });
  return open;
}

/** Sends the person's press (and their words) to the account; answers what the account said. */
export async function act(id, actionId, text = null) {
  const notice = await keptNotice(id);
  if (!notice) throw new Error(said.gone);
  const action = (notice.actions ?? []).find(candidate => candidate.id === actionId);
  if (!action) throw new Error(said.gone);
  const accountId = await signedInAccount();
  if (!accountId) throw new SignInNeeded();
  if (notice.account !== accountId) throw new SignInNeeded();
  const pendingKey = `notice-action:${accountId}:${notice.id}:${action.id}`;
  const saved = (await chrome.storage.session.get(pendingKey))[pendingKey];
  const pending = saved ?? { submissionId: crypto.randomUUID(), text };
  if (!saved) await chrome.storage.session.set({ [pendingKey]: pending });
  const answer = await runWorkshopTool(NOTIFICATION_TOOLS.act, browserNoticeAction({
    id: notice.id, action: action.id, text: pending.text, submissionId: pending.submissionId,
  }), { requestKey: pending.submissionId, expectedAccount: accountId });
  await markRead(notice.id, true, notice.account);
  await chrome.storage.session.remove(pendingKey);
  await chrome.notifications.clear(id);
  await forget(id);
  const where = answer.open ?? (action.opens ? notice.open : null);
  if (where) await openInTrillion(where);
  await refreshUnread().catch(() => {});
  return { ...answer, title: notice.title };
}

/** Handles an action already selected by the Web Push sender. The sender supplies the
 * notice and action IDs, so keep those IDs exact and scope the call to this signed-in device. */
export async function actPushedNotice(noticeId, actionId) {
  if (typeof noticeId !== 'string' || !noticeId || typeof actionId !== 'string' || !actionId) return null;
  const accountId = await signedInAccount();
  if (!accountId) throw new SignInNeeded();
  const device = (await chrome.storage.local.get(DEVICE))[DEVICE];
  if (!device || device.account !== accountId) throw new SignInNeeded();
  const pendingKey = `notice-action:${accountId}:${noticeId}:${actionId}`;
  const saved = (await chrome.storage.session.get(pendingKey))[pendingKey];
  const pending = saved ?? { submissionId: crypto.randomUUID(), text: null };
  if (!saved) await chrome.storage.session.set({ [pendingKey]: pending });
  const answer = await runWorkshopTool(NOTIFICATION_TOOLS.act, browserNoticeAction({
    id: noticeId, action: actionId, submissionId: pending.submissionId,
  }), { requestKey: pending.submissionId, expectedAccount: accountId });
  await markRead(noticeId, true, accountId);
  await chrome.storage.session.remove(pendingKey);
  return answer;
}

async function markRead(id, read = true, expectedAccount = null) {
  const device = (await chrome.storage.local.get(DEVICE))[DEVICE];
  const accountId = await signedInAccount();
  if (!device || device.account !== accountId || expectedAccount && expectedAccount !== accountId) throw new SignInNeeded();
  await runWorkshopTool(NOTIFICATION_TOOLS.markRead, browserNoticeRead({ id, deviceId: device.device_id, read }), {
    requestKey: crypto.randomUUID(), expectedAccount: accountId,
  });
  const state = (await chrome.storage.local.get(NOTICE_STATE))[NOTICE_STATE];
  if (state?.account === accountId && state?.device_id === device.device_id) {
    await chrome.storage.local.set({ [NOTICE_STATE]: { ...state, notices: state.notices.map(notice => notice.id === id ? { ...notice, read } : notice) } });
  }
}

async function press(id, index) {
  const notice = await keptNotice(id);
  const action = notice?.actions?.[index];
  if (!action) return;
  if (notice.account !== await signedInAccount()) {
    await tell(id, '', said.sign_in);
    return;
  }
  if (action.input) {
    const page = new URL(chrome.runtime.getURL(settings.notices.reply_page));
    page.searchParams.set('id', id);
    page.searchParams.set('action', action.id);
    await chrome.windows.create({ url: page.href, type: 'popup', focused: true, ...settings.notices.reply_window });
    return;
  }
  try {
    const answer = await act(id, action.id);
    await tell(notice.id, notice.title, answer.said || said.done);
  } catch (error) {
    await tell(notice.id, notice.title, error instanceof SignInNeeded ? said.sign_in : fill(said.could_not, { problem: error.message }));
  }
}

async function opened(id) {
  return openNotice(id, {
    get: keptNotice,
    open: async (path, notice) => {
      if (notice.account !== await signedInAccount()) throw new SignInNeeded();
      return openInTrillion(path);
    },
    clear: noticeId => chrome.notifications.clear(noticeId),
    forget,
    markRead: notice => markRead(notice.id, true, notice.account).then(refreshUnread),
  });
}

// Every start: register this browser, count unread, and keep counting.
async function start() {
  await chrome.alarms.create(ALARM, { periodInMinutes: settings.notices.unread_every_minutes });
  await registerThisBrowser().catch(error => console.warn('Trillion notices:', error.message));
  await refreshUnread().catch(error => console.warn('Trillion unread:', error.message));
}

chrome.runtime.onStartup.addListener(start);
chrome.runtime.onInstalled.addListener(start);
// Right after sign-in (signed-in.html keeps the tokens), and when the person signs out.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.tokens) return;
  if (changes.tokens.newValue && !changes.tokens.oldValue) start();
  if (!changes.tokens.newValue) {
    setMark('unread', null);
    self.registration.pushManager.getSubscription().then(subscription => subscription?.unsubscribe()).catch(() => {});
    chrome.storage.local.remove([DEVICE, NOTICE_STATE]);
  }
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) refreshUnread().catch(() => {}); });

self.addEventListener('push', event => {
  const notice = (() => { try { return event.data?.json() ?? null; } catch { return null; } })();
  if (notice?.type === 'notice-action' || notice?.type === 'trillion-notice-action') {
    event.waitUntil(actPushedNotice(notice.notice_id, notice.action)
      .then(refreshUnread)
      .catch(error => console.warn('Trillion notice action:', error.message)));
    return;
  }
  event.waitUntil(showNotice(notice).then(refreshUnread).catch(error => console.warn('Trillion notice:', error.message)));
});
self.addEventListener('pushsubscriptionchange', event => { event.waitUntil(registerThisBrowser().catch(() => {})); });

chrome.notifications.onButtonClicked.addListener((id, index) => { press(id, index); });
chrome.notifications.onClicked.addListener(id => {
  opened(id).catch(error => console.warn('Trillion notice did not open:', error.message));
});
chrome.notifications.onClosed.addListener(id => { if (!id.startsWith('said:')) forget(id); });

// The reply window hands the person's words here: { notice_act: { id, action, text } }.
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === 'notice-action' || message?.type === 'trillion-notice-action') {
    actPushedNotice(message.notice_id, message.action).then(reply, error => reply({ error: error instanceof SignInNeeded ? said.sign_in : String(error?.message ?? error) }));
    return true;
  }
  const asked = message?.notice_act;
  if (!asked || typeof asked !== 'object') return false;
  act(asked.id, asked.action, asked.text ?? null).then(reply, error => reply({ error: error instanceof SignInNeeded ? said.sign_in : String(error?.message ?? error) }));
  return true;
});
