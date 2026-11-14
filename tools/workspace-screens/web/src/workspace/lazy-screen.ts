// src/workspace/lazy-screen.ts
//
// PURPOSE
//   A screen whose code is fetched the first time it opens, so the page downloads only the screens a person uses.
//   The build splits each screen into its own content-named file (scripts/build-workspace.mjs); this is the one place
//   that turns "fetch the screen's code, then mount it" into the ordinary mount a pane calls.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The mount keeps the pane's contract: it returns its cleanup at once, and a pane closed before the code arrives
//      never mounts it.
//   2. While the code arrives the pane shows the shared loading state. The code comes through the one loader
//      (parts/ui/show/load-later/load-code.ts), which mends a failed fetch by itself while the page is shown and online.
//      When it cannot be mended the pane says why in the loader's words: Try again asks again in place when the
//      connection was the reason (nothing else on the page is touched), and the pane asks again by itself when the
//      device comes back online; Reload page is offered only when a newer Trillion replaced the file or only a fresh
//      page can fetch it.
//   3. The code is fetched once per page; every later open of the same screen mounts at once.
//   4. `warm` fetches the code ahead of the first open (when the person points at the screen, or the page is idle),
//      through the same single fetch; a failed warm-up is forgotten, so the open asks again and shows its failure.
//   5. The loading state is let go of before the screen mounts: the screen owns the pane alone.

import { mountScreenState, releaseScreenState, type FailedScreenState } from '../../parts/ui/show/screen-state';
import { CodeLoadFailure, loadCode, whenOnline } from '../../parts/ui/show/load-later/load-code';
import { codeFailureNotice } from '../../parts/ui/show/load-later/later';

export type ScreenProps = { surfaceInput?: Record<string, unknown>; inPlace?: boolean; onChanged?: () => void; mountRole?: 'lead' | 'pane' };
export type ScreenPendingNotice = { title: string; description: string; action?: { label: string; run: () => void } };
export type Unmount = (() => void) & { update?: (props: ScreenProps) => boolean | void | Promise<boolean>; pending?: (notice: ScreenPendingNotice | null) => void };
export type Mount = (element: HTMLElement, props: ScreenProps) => Unmount;

/** A mount whose code can be fetched ahead of its first open. */
export type WarmMount = Mount & { warm?: () => void };

/** New inputs must never discard a screen's recording or unsaved work. A screen
 * explicitly implements the input update contract; a React render handle alone
 * does not accept screen props. Unsupported inputs stay pending beside the live
 * screen, and returning to its accepted inputs clears that notice. */
export function preserveScreenInputs(element: HTMLElement, stop: Unmount, props: ScreenProps): Unmount {
  let accepted = props;
  let notice: HTMLElement | null = null;
  let gone = false;
  let pinnedNotice: ScreenPendingNotice | null = null;
  let inputNotice: ScreenPendingNotice | null = null;
  // A refusal or lost acknowledgement means the child may still finish applying
  // an earlier input. Do not infer that it is back at `accepted` just because a
  // later request asks for those same values.
  let acceptedIsCertain = true;
  let updateVersion = 0;
  let updateQueue: Promise<boolean> = Promise.resolve(true);
  const clearNotice = () => { if (notice) { releaseScreenState(notice); notice.remove(); notice = null; } };
  const showNotice = () => {
    const current = pinnedNotice ?? inputNotice;
    if (!current) { clearNotice(); return; }
    if (!notice) {
      notice = element.ownerDocument.createElement('div');
      notice.dataset.screenInputsPending = '';
      element.prepend(notice);
    }
    mountScreenState(notice, { status: 'empty', icon: 'SlidersHorizontal', title: current.title, description: current.description, action: current.action });
  };
  const dispose: Unmount = () => { gone = true; clearNotice(); stop(); };
  dispose.pending = pending => { if (gone) return; pinnedNotice = pending; showNotice(); };
  dispose.update = next => {
    if (gone) return;
    const version = ++updateVersion;
    const pending = updateQueue.catch(() => false).then(async () => {
      if (gone) return false;
      const target = next;
      const targetVersion = version;
      if (acceptedIsCertain && JSON.stringify(accepted.surfaceInput ?? {}) === JSON.stringify(target.surfaceInput ?? {})) {
        if (targetVersion === updateVersion) { inputNotice = null; showNotice(); }
        return true;
      }
      if (!stop.update) {
        if (targetVersion === updateVersion) { inputNotice = { title: 'This screen is using earlier values', description: 'Your work is still here. Finish it, then reopen this screen to use the changed values.' }; showNotice(); }
        return false;
      }
      try {
        const applied = await stop.update(target);
        if (applied !== false) { accepted = target; acceptedIsCertain = true; }
        else acceptedIsCertain = false;
        if (targetVersion !== updateVersion || gone) return applied !== false;
        if (applied === false) inputNotice = { title: 'This screen is using earlier values', description: 'Your work is still here. Finish it, then reopen this screen to use the changed values.' };
        else inputNotice = null;
        showNotice();
        return applied !== false;
      } catch {
        acceptedIsCertain = false;
        if (targetVersion === updateVersion && !gone) {
          inputNotice = { title: 'This screen is using earlier values', description: 'Your work is still here. Finish it, then reopen this screen to use the changed values.' };
          showNotice();
        }
        return false;
      }
    });
    updateQueue = pending;
    return pending;
  };
  return dispose;
}

/** The failed state of a screen whose code could not be had, in the loader's words (parts/ui/show/load-later). */
function codeFailedState(error: unknown, retry: () => void): FailedScreenState {
  const notice = codeFailureNotice(error instanceof CodeLoadFailure ? error.reason : 'broken', retry);
  return { status: 'failed', title: 'This screen could not open', description: `${notice.why}. ${notice.then}`, retry: notice.action };
}

/** A screen whose code `load` imports when it first opens, `pick` taking its mount from that module. */
export function lazyScreen<M>(load: () => Promise<M>, pick: (module: M) => Mount): WarmMount {
  let loaded: Mount | null = null;
  let loading: Promise<Mount> | null = null;
  const fetchCode = () => (loading ||= loadCode(load, pick).then(mount => (loaded = mount), error => { loading = null; throw error; }));
  const mount: Mount = (element, props) => {
    let unmount: Unmount | null = loaded ? preserveScreenInputs(element, loaded(element, props), props) : null;
    let gone = false;
    let latestProps = props;
    let stopWaitingForOnline = () => {};
    const open = () => {
      stopWaitingForOnline();
      mountScreenState(element, { status: 'loading', label: 'Opening this screen', layout: 'rows' });
      fetchCode().then(
        // The loading state lets go of the pane before the screen draws: a screen that adds its own box beside
        // whatever the pane held never draws under the loading rows.
        screen => { if (!gone) { releaseScreenState(element); unmount = preserveScreenInputs(element, screen(element, latestProps), latestProps); } },
        error => {
          if (gone) return;
          mountScreenState(element, codeFailedState(error, open));
          if (error instanceof CodeLoadFailure && error.reason === 'unreached') stopWaitingForOnline = whenOnline(open);
        },
      );
    };
    if (!unmount) open();
    const dispose: Unmount = () => { gone = true; stopWaitingForOnline(); unmount?.(); };
    dispose.update = next => {
      if (gone) return;
      latestProps = next;
      unmount?.update?.(next);
    };
    return dispose;
  };
  return Object.assign(mount, { warm: () => { fetchCode().catch(() => {}); } });
}
