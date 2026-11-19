// extension/src/background.mjs
//
// PURPOSE
//   Lets the person gather things from many pages before sending: right-click anything (a page, a selection, a
//   picture, a link, a video) and "Add to Trillion" puts it in the tray the popup sends. The tray lives in session
//   storage, so it is kept while the browser is open and gone when it closes.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An item describes itself: kind, url, and whatever the browser told us about it. No list of known sites.
//   2. Adding the same thing twice keeps one (src/tray.mjs).
//   3. Recording (src/recorder-worker.mjs), the page tools (src/page-tool-runs.mjs) and Trillion's notices
//      (src/notice-worker.mjs), the requests the person's own computer relays to this browser (tools/run-tools-in-my-signed-in-browser/computer-relay.mjs,
//      answered by src/browser-runs.mjs) and what this asks of that computer (src/computer-host.mjs) are their own
//      modules; this file only loads them.
//   4. What the popup was doing on a tab (its draft, session `draft:<tab id>`) is forgotten when that tab closes.
//   5. The tray's count is one mark on the toolbar badge (src/badge.mjs, mark `tray`); the badge has one owner.
//   6. A send kept on this device (local `outbox`, src/outbox.mjs) is sent again every minute and at startup with its own
//      request_key, and leaves the outbox only when the account answered it.

import { addToTrayOwned, handleTrayMutation } from './tray.mjs';
import { reloadIfUpdated } from './loaded-current.mjs';
import { setMark } from './badge.mjs';
import { drainOutbox, OUTBOX, OUTBOX_ALARM, OUTBOX_EVERY_MINUTES } from './outbox.mjs';
import { signedInAccount, tool } from './trillion.mjs';
import './recorder-worker.mjs';
import './page-tool-runs.mjs';
import './notice-worker.mjs';
import './browser-runs.mjs';
import './computer-host.mjs';
import { startComputerRelay } from '../../run-tools-in-my-signed-in-browser/computer-relay.mjs';
import settings from '../settings.json' with { type: 'json' };
import { runBrowserTool } from './browser-runs.mjs';

// An update that changed what the extension may do is loaded before anything uses it (src/loaded-current.mjs).
reloadIfUpdated();

const MENU = 'add-to-trillion';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU, title: 'Add to Trillion', contexts: ['page', 'selection', 'image', 'link', 'video', 'audio'] });
});

// What the page's own script (right-clicked.mjs) said was under the pointer, per tab, for the click that follows.
const RECENT_MS = 15_000;
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!('right_clicked' in (message ?? {})) || !sender.tab?.id) return;
  chrome.storage.session.set({ [`right-clicked:${sender.tab.id}`]: { item: message.right_clicked, at: Date.now() } });
});

// Popup and other extension documents send tray changes here. The background worker is the only context
// allowed to mutate session `tray`, so its queue orders writes across every caller.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message?.trillion_tray || typeof message.trillion_tray !== 'object') return false;
  const extensionOrigin = chrome.runtime.getURL('');
  if (sender?.id !== chrome.runtime.id || !sender.url?.startsWith(extensionOrigin)) return false;
  Promise.resolve().then(() => handleTrayMutation(message.trillion_tray))
    .then(tray => reply({ tray }), error => reply({ error: String(error?.message ?? error) }));
  return true;
});

// A selection is what the person chose; then the post they clicked in (with a picture they clicked on); then the
// picture, link or page the browser names.
export function itemFromClick(info, tab, post = null) {
  const page = { page_url: tab?.url ?? info.pageUrl ?? null, page_title: tab?.title ?? null };
  if (!info.selectionText && post) return { ...post, url: post.url ?? info.linkUrl ?? info.pageUrl, ...(info.srcUrl ? { clicked_picture: info.srcUrl } : {}), ...page };
  if (info.selectionText) return { kind: 'selection', text: info.selectionText, url: info.pageUrl, ...page };
  if (info.mediaType && info.srcUrl) return { kind: info.mediaType, url: info.srcUrl, ...page };
  if (info.linkUrl) return { kind: 'link', url: info.linkUrl, text: info.linkText ?? null, ...page };
  return { kind: 'page', url: info.pageUrl, title: tab?.title ?? null, ...page };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU) return;
  const key = `right-clicked:${tab?.id}`;
  const noted = (await chrome.storage.session.get(key))[key];
  await chrome.storage.session.remove(key);
  const item = itemFromClick(info, tab, noted && Date.now() - noted.at < RECENT_MS ? noted.item : null);
  await addToTrayOwned(item);
  chrome.action.openPopup?.().catch(() => {});
});

chrome.storage.session.onChanged.addListener(changes => {
  if (!changes.tray) return;
  setMark('tray', changes.tray.newValue?.length ?? 0);
});

// Sends kept on this device because the account could not be reached go again every minute, when the browser starts and
// when the extension is installed or updated, each with the request_key it was kept with (src/outbox.mjs).
const sendKept = () => drainOutbox({ tool, account: signedInAccount }).catch(() => {});
chrome.alarms.create(OUTBOX_ALARM, { periodInMinutes: OUTBOX_EVERY_MINUTES });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === OUTBOX_ALARM) sendKept(); });
chrome.runtime.onStartup.addListener(sendKept);
chrome.runtime.onInstalled.addListener(sendKept);
// Right after sign-in, and whenever something is newly kept, try at once instead of waiting for the minute.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.tokens?.newValue || changes[OUTBOX]?.newValue?.some(row => !row.refused && !changes[OUTBOX].oldValue?.some(old => old.request_key === row.request_key)))) sendKept();
});
sendKept();

chrome.tabs.onRemoved.addListener(tabId => { chrome.storage.session.remove(`draft:${tabId}`); });

// The person's own computer can ask this browser to read or act on a page, once the person has allowed the computer.
startComputerRelay({ host: settings.computer_host, run: runBrowserTool });
