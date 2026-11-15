// extension/src/loaded-current.mjs
//
// PURPOSE
//   An extension loaded from a folder reads its pages and scripts from that folder every time they open, but reads its
//   manifest (what it may do: record a tab, open an offscreen page) only when the browser loads it. After an update
//   the new pages can ask for something the browser has not granted yet, which fails with a browser error such as
//   "Cannot read properties of undefined". This compares the manifest the browser loaded with the one in the folder
//   and, when they differ, has the browser load the extension again, so what it may do matches what it runs.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only what the manifest grants and its version are compared; a store install always matches and never reloads.
//   2. Reloading is the browser's own chrome.runtime.reload, which keeps the person signed in (local storage stays).

const granted = manifest => JSON.stringify([manifest.version, [...(manifest.permissions ?? [])].sort(), [...(manifest.host_permissions ?? [])].sort()]);

/** True when the folder's manifest grants the same as the loaded one; otherwise reloads the extension. */
export async function reloadIfUpdated() {
  const onDisk = await (await fetch(chrome.runtime.getURL('manifest.json'))).json().catch(() => null);
  if (!onDisk || granted(onDisk) === granted(chrome.runtime.getManifest())) return true;
  chrome.runtime.reload();
  return false;
}
