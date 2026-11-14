// src/workspace/live-instructions.ts
//
// PURPOSE
//   What the page does when the store steers it from the first frame of its live socket (src/live-protocol.json boot): the
//   socket announces the instruction as a window event `trillion-live-instruction` with { action, said }, and this is its one
//   listener. `reload` reloads, `clear-kept` deletes what this computer kept for any account and then reloads, `sign-in` opens
//   the sign-in and comes back to this address; `stop` is the socket's own (it stops listening).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A reload or clear-kept acts at most once per `boot.repeat_guard_ms` on this tab, so an instruction left on cannot loop the page.
//   2. What was said is told to the person before the page acts.
//   3. Nothing here names an instruction: the actions are the data's (live-protocol.json boot.actions).

import { LIVE } from '../live-protocol.mjs';
import { signInAddress } from './addresses.mjs';
import { clearKept } from './api';
import { notify } from '../../parts/ui/show/coss/notifications';

const GUARD = 'trillion-live-instruction-at';
const recently = (): boolean => {
  try {
    const at = Number(window.sessionStorage.getItem(GUARD) ?? 0);
    if (Date.now() - at < LIVE.boot.repeat_guard_ms) return true;
    window.sessionStorage.setItem(GUARD, String(Date.now()));
    return false;
  } catch { return false; }
};

/** Acts on one instruction ({ action, said }); `reload` is given for a test's stand-in. */
export async function followInstruction({ action, said }: { action: string; said: string }, reload: () => void = () => window.location.reload()): Promise<void> {
  if (said) notify(said);
  if (action === 'reload') { if (!recently()) reload(); return; }
  if (action === 'clear-kept') { if (recently()) return; await clearKept(); reload(); return; }
  if (action === 'sign-in') window.location.assign(signInAddress(`${window.location.pathname}${window.location.search}${window.location.hash}`));
}

/** Starts the listener once for the page. */
export function publishLiveInstructions(): void {
  const host = window as unknown as { trillionPendingInstruction?: { action: string; said: string } };
  window.addEventListener('trillion-live-instruction', event => { host.trillionPendingInstruction = undefined; void followInstruction((event as CustomEvent<{ action: string; said: string }>).detail); });
  // An instruction the socket heard before this started.
  if (host.trillionPendingInstruction) { const heard = host.trillionPendingInstruction; host.trillionPendingInstruction = undefined; void followInstruction(heard); }
}
