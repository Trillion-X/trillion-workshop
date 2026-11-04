// computer/end-with-the-app.mjs
//
// Purpose: a program the Trillion app starts as its child (macos/computer-reader.json programs, started with
// --key-stdin) ends when the app that started it is gone. A crash, a force quit or an update replaces the app without
// telling its children, and a child left running keeps holding the account's live socket and doing its passes beside
// the new app's own copy, so every read it makes is made twice.
//
// Non-Negotiable Invariants:
//   1. Only a parent change ends the program: a program started by launchd or by hand from a shell keeps the parent
//      it started with, so this never stops it.
//   2. The check never keeps the program alive by itself (the timer is unref'd).
//

import { checkSwitches } from './switch-guard.mjs';

/** Ends this program once its parent changes (the app that started it has gone). → the timer, or null with no parent. */
export function endWithTheApp({ every_seconds = 5, parentOf = () => process.ppid, end = () => process.exit(0), guard = () => checkSwitches({ log: line => process.stderr.write(`${line}\n`) }), refuse = () => process.exit(78) } = {}) {
  // A program the app started refuses debugger and TLS-weakening switches (computer/switch-guard.mjs).
  if (!guard().ok) refuse();
  const parent = parentOf();
  if (!parent || parent === 1) return null;
  const timer = setInterval(() => { if (parentOf() !== parent) end(); }, every_seconds * 1000);
  timer.unref?.();
  return timer;
}
