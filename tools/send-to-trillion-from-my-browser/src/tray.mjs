// extension/src/tray.mjs
//
// PURPOSE
//   The tray: what the person gathered to send next (right-clicked things, the whole text of a page, a recording of a
//   tab). It lives in session storage, so it is kept while the browser is open and gone when it closes; the popup
//   shows it and Send sends it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An item describes itself: kind, url, and whatever was learned about it (text, title, a kept file's identity).
//   2. Adding the same thing twice keeps one: same kind, same address, same words, same kept file.

export const sameItem = (left, right) => (left.account ?? null) === (right.account ?? null) && left.kind === right.kind && left.url === right.url
  && (left.text ?? null) === (right.text ?? null) && (left.file ?? null) === (right.file ?? null);

/** Account-owned results stay visible and removable only in the account that made them; unowned items remain shared. */
export const visibleToAccount = (item, account) => !item.account || item.account === account;

let mutation = Promise.resolve();
const mutate = operation => {
  const answer = mutation.then(operation, operation);
  mutation = answer.catch(() => {});
  return answer;
};

/** The background worker's sole serialized write path. Other extension pages call the message APIs below. */
export async function addToTrayOwned(item) {
  return mutate(async () => {
    const { tray = [] } = await chrome.storage.session.get('tray');
    if (tray.some(kept => sameItem(kept, item))) return tray;
    const next = [...tray, { ...item, added_at: new Date().toISOString() }];
    await chrome.storage.session.set({ tray: next });
    return next;
  });
}

/** The background worker's sole serialized removal path. */
export async function removeFromTrayOwned(items, account) {
  const wanted = Array.isArray(items) ? items : [items];
  return mutate(async () => {
    const { tray = [] } = await chrome.storage.session.get('tray');
    const next = tray.filter(item => !visibleToAccount(item, account) || !wanted.some(candidate => sameItem(item, candidate)));
    await chrome.storage.session.set({ tray: next });
    return next;
  });
}

/** Applies a client request in the background worker, where all tray mutations are serialized together. */
export function handleTrayMutation(request) {
  if (request?.add && typeof request.add === 'object') return addToTrayOwned(request.add.item);
  if (request?.remove && typeof request.remove === 'object') return removeFromTrayOwned(request.remove.items, request.remove.account ?? null);
  throw new Error('That tray change is not supported.');
}

/** One caller-facing API; each extension context gets a client that routes mutations to the background owner. */
export function createTrayClient(sendMessage) {
  const requestTrayMutation = async request => {
    const answer = await sendMessage({ trillion_tray: request });
    if (answer?.error) throw new Error(answer.error);
    return answer?.tray ?? [];
  };
  return {
    addToTray: item => requestTrayMutation({ add: { item } }),
    removeFromTray: (items, account) => requestTrayMutation({ remove: { items, account } }),
  };
}

const client = createTrayClient(message => chrome.runtime.sendMessage(message));
/** Adds an item through the background owner; safe from popup and other extension pages. */
export const addToTray = client.addToTray;
/** Removes matching visible items through the background owner, preserving other accounts' rows. */
export const removeFromTray = client.removeFromTray;
