// extension/src/notices.mjs
//
// PURPOSE
//   The pure half of Trillion's notices in this browser: turning a notice the account pushed (the device contract's
//   web push JSON: { id, title, body, open, tag, icon, level, actions }) into a browser notification, naming this
//   browser for the account's device list, and counting unread notices. src/notice-worker.mjs wires these to the
//   browser; nothing here touches it, so it runs in tests as it is.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An action is shown by its label and pressed by its id; nothing here knows what any action does.
//   2. How loud each level is (stays until dismissed, priority) is DATA (settings.json notices.levels); a level with
//      no row is as quiet as a notice can be.
//   3. Browser names are DATA (words.json notices.browsers); the brand list the browser reports is matched to it.

/** The bytes of a base64url text (the account's web push key), for pushManager.subscribe. */
export function bytesFromBase64url(text) {
  const plain = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(plain.padEnd(Math.ceil(plain.length / 4) * 4, '='));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Whether two keys (ArrayBuffer or byte arrays) hold the same bytes. */
export function sameBytes(left, right) {
  if (!left || !right) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * This browser's name in the account's device list: the first brand the browser reports that the DATA names
 * (Edge, Opera...), Brave by its own mark (it reports itself as Chromium), else the DATA's `otherwise` (Chrome).
 */
export function browserLabel({ brands = [], brave = false } = {}, names) {
  if (brave) return names.brave;
  const named = brands.map(entry => names.by_brand[entry.brand]).find(Boolean);
  return named ?? names.otherwise;
}

/** chrome.notifications options for a notice: its words, the first `most_buttons` actions' labels, its loudness. */
export function notificationFor(notice, { iconUrl, levels, most_buttons: mostButtons }) {
  const loudness = levels[notice.level] ?? { require_interaction: false, priority: 0 };
  return {
    type: 'basic', iconUrl,
    title: String(notice.title ?? ''), message: String(notice.body ?? ''),
    buttons: (notice.actions ?? []).slice(0, mostButtons).map(action => ({ title: action.label })),
    requireInteraction: Boolean(loudness.require_interaction), priority: loudness.priority ?? 0,
  };
}

/** How many of the account's notices the person has not read. */
export const unreadCount = notices => (notices ?? []).filter(notice => !notice.read).length;

/** The words of a template with {name} replaced by facts[name]. */
export const fill = (template, facts) => String(template).replace(/\{(\w+)\}/g, (whole, name) => (name in facts ? String(facts[name]) : whole));
