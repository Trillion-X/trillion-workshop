// src/workspace/client-version.ts
//
// PURPOSE
//   Keeps an open tab from working on after the store moved past its build: the tab asks the Worker which page builds
//   may keep working (GET /work/api/client-version, src/client-version.mjs) every `check_every_ms` while it is shown and
//   when it is shown again after that long, and a tab that may not is covered by one reload screen (the shared screen
//   state), so it never writes the shape the store no longer takes.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A check that fails (offline, signed out, refused, a malformed answer) never locks a tab out (src/client-version.mjs).
//   2. Locked out covers the whole window and makes the workspace inert, so nothing more is typed or pressed; writes this
//      page already kept on the device are left as they are, for the reloaded page to send (quiet-writes.ts).
//   3. One check at a time, none while the tab is hidden, and nothing after the tab is locked out.

import settings from '../client-version.json' with { type: 'json' };
import { lockedOut } from '../client-version.mjs';
import { mountScreenState } from '../../parts/ui/show/screen-state';

let locked = false;
let checking = false;
let checkedAt = 0;

function lockOut(): void {
  locked = true;
  for (const workspace of document.querySelectorAll('.trillion-workspace')) workspace.setAttribute('inert', '');
  const host = document.createElement('div');
  host.className = 'trillion-workspace-locked';
  document.body.append(host);
  mountScreenState(host, { status: 'unavailable', icon: 'RefreshCw', title: settings.words.title, description: settings.words.description,
    retry: { label: settings.words.reload, run: () => location.reload() } });
}

/** Asks once whether this tab's build may keep working, and covers the tab when it may not (invariants 1 and 3). */
export async function checkClientVersion(): Promise<boolean> {
  if (locked || checking) return locked;
  checking = true;
  checkedAt = Date.now();
  try {
    const reply = await fetch(settings.path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const answer: unknown = reply.ok ? await reply.json() : null;
    if (!locked && lockedOut(answer, { generation: settings.generation, openedAt: performance.timeOrigin })) lockOut();
  } catch { /* a failed check never locks a tab out */ } finally { checking = false; }
  return locked;
}

/** Checks while the tab is shown, every `check_every_ms` and when shown again after that long; returns the stop. */
export function watchClientVersion(): () => void {
  const due = () => { if (document.visibilityState === 'visible' && Date.now() - checkedAt >= settings.check_every_ms) void checkClientVersion(); };
  const timer = window.setInterval(due, settings.check_every_ms);
  document.addEventListener('visibilitychange', due);
  return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', due); };
}
