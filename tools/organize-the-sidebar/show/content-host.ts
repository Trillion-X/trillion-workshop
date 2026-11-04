// parts/sidebar/show/content-host.ts
//
// PURPOSE
//   A sidebar list can host a shared panel instead of rows (DATA: the app's content_host_by_section_id names the
//   list and the host). The sidebar draws an empty element carrying CONTENT_HOST_ATTRIBUTE; whatever fills it
//   mounts through mountIntoContentHost, which follows that element as the sidebar redraws, collapses, moves or
//   unpins the list, so the filler never touches sidebar code.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The attribute name has one home, here; AppSidebar draws with it and every filler finds with it.
//   2. At most one mount per host element: a new element unmounts the old one first.
//   3. The returned stop ends the watching and unmounts.

export const CONTENT_HOST_ATTRIBUTE = 'data-sidebar-content-host';

/** Keep `mount` running inside the sidebar element hosting `hostId`, following it wherever the sidebar draws it. */
export function mountIntoContentHost(hostId: string, mount: (host: HTMLElement) => () => void): () => void {
  let held: { host: HTMLElement; stop: () => void } | null = null;
  const place = () => {
    const host = document.querySelector<HTMLElement>(`[${CONTENT_HOST_ATTRIBUTE}="${CSS.escape(hostId)}"]`);
    if (host === held?.host) return;
    held?.stop();
    held = host ? { host, stop: mount(host) } : null;
  };
  const watcher = new MutationObserver(place);
  watcher.observe(document.body, { childList: true, subtree: true });
  place();
  return () => { watcher.disconnect(); held?.stop(); held = null; };
}
