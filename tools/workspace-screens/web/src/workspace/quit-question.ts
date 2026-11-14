// src/workspace/quit-question.ts
//
// PURPOSE
//   The question a host app puts to the person before it quits while this page holds work that has not reached their
//   account. The Mac app (macos/App/LiveSurfaces.swift) brings this window forward and calls `window.trillionAskQuit`
//   with the words (from macos/App/live-surfaces.json); the page draws the question itself, in the shared screen state
//   and the worn look, and answers the app through the host channel it names. No native alert draws it
//   (parts/screen-look/device-hosts.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The words are the host's DATA, passed in; this file holds no sentence.
//   2. Asked while a question is open, the open one is replaced, never stacked. The workspace is inert while it shows,
//      so nothing is typed behind it.
//   3. Either button closes the question, makes the workspace live again, and answers the host once: `quit` or `cancel`.
//   4. Where no host listens (a browser tab), nothing is shown and the answer is `false`, so a page never covers itself
//      for a question nobody asked.

import { mountScreenState, releaseScreenState } from '../../parts/ui/show/screen-state';

export type QuitWords = { title: string; detail: string; quit: string; cancel: string };
type HostChannels = { webkit?: { messageHandlers?: Record<string, { postMessage(message: unknown): void } | undefined> } };

let open: HTMLElement | null = null;

function close(): void {
  if (!open) return;
  releaseScreenState(open);
  open.remove();
  open = null;
  for (const workspace of document.querySelectorAll('.trillion-workspace')) workspace.removeAttribute('inert');
}

/** Shows the host's question; true when shown (invariants 2 and 4). `channel` is the host handler that hears the answer. */
export function askQuit(words: QuitWords, channel: string): boolean {
  const host = (window as unknown as HostChannels).webkit?.messageHandlers?.[channel];
  if (!host) return false;
  close();
  const answer = (value: 'quit' | 'cancel') => () => { close(); host.postMessage({ answer: value }); };
  for (const workspace of document.querySelectorAll('.trillion-workspace')) workspace.setAttribute('inert', '');
  open = document.createElement('div');
  open.className = 'trillion-workspace-locked';
  open.setAttribute('role', 'alertdialog');
  open.setAttribute('aria-label', words.title);
  document.body.append(open);
  mountScreenState(open, { status: 'empty', icon: 'CloudOff', title: words.title, description: words.detail,
    action: { label: words.quit, run: answer('quit') }, secondary: { label: words.cancel, run: answer('cancel') } });
  return true;
}

/** Publishes `window.trillionAskQuit(words, channel)` for the host app (invariant 3 of unsaved-work.ts's twin). */
export function publishQuitQuestion(): void {
  (window as unknown as { trillionAskQuit?: typeof askQuit }).trillionAskQuit = askQuit;
}
