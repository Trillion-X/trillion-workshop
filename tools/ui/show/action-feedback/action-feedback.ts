// parts/ui/show/action-feedback/action-feedback.ts
//
// PURPOSE
//   The one place a command a person gives tells them what happened and is
//   written down. Shared controls (the icon toolbar, the action menu, the action
//   row) report the command a person chose; the page's command transport runs
//   each server command through `runCommand`. Nothing is wired per button.
//
//   - A server command that changes saved work announces its outcome as a short
//     toast that also stays in the notification center's history. A failure
//     stays until the person handles it.
//   - A command that only changes the screen (split, resize, close a pane,
//     choose a menu entry that opens something) is written to history quietly:
//     it lands in the notification center's history, never as a toast.
//   - A choice that starts a server command is announced once, by that command.
//   - Every command is recorded durably by the sink's `record` (the app's action
//     history), with its outcome.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No control names a command it reports; labels are the words the person
//      saw on the control or the command's owner gave.
//   2. A command whose own work already announced itself (it emitted a
//      notification while running or just after) gets no second toast.
//   3. Scrolling, hovering and focusing are not commands and are never reported.
//   4. Without a provided sink nothing is shown or recorded (tests, previews).
//   5. Presses are heard once, by `observeChoices` on the page root; controls do
//      not report their own presses, so no press is reported twice.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.

import type {NotificationCenter} from '../notifications/notification-center';
import {sayHappened} from '../happened/happened';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
export type CommandRecord = {label: string; surface?: string; outcome: 'done' | 'failed'; detail?: string};
export type ActionFeedbackSink = {
  center: NotificationCenter;
  /** Durable history for commands that never reach the server (a pane resized). */
  record?: (entry: CommandRecord) => void;
  /** How long a chosen control waits for a server command it may have started. */
  settleMs?: number;
};

let sink: ActionFeedbackSink | null = null;
let lastServerCommand = 0;

/** Install where commands are announced and recorded. Returns the previous sink's restore. */
export function provideActionFeedback(next: ActionFeedbackSink | null): () => void {
  const previous = sink;
  sink = next;
  return () => { sink = previous; };
}

/**
 * A person chose a control (a toolbar icon, a menu entry, a row action). If no
 * server command follows within the settle window, it is written to history
 * quietly; if one does, that command announces the outcome instead.
 */
export function reportChoice(label: string, surface?: string): void {
  const current = sink;
  const words = label?.trim();
  if (!current || !words) return;
  const chosenAt = Date.now();
  setTimeout(() => {
    if (lastServerCommand >= chosenAt) return;
    current.center.emit(words, {kind: 'done', quiet: true, detail: surface || undefined}).finish({kind: 'done'});
    current.record?.({label: words, surface, outcome: 'done'});
  }, current.settleMs ?? 700);
}

// The controls whose press is a command. A control that only opens or closes something that shows more choices
// (a menu trigger, a disclosure) is not a command, nor is one that asks not to be reported.
const COMMAND_CONTROLS = 'button,[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio]';
// The words on a control, without what only decorates it: a count badge ("Notifications 2") or hidden text.
const DECORATION = '[aria-hidden=true],[data-slot*=badge],[role=status]';
function visibleWords(control: Element): string {
  const walker = control.ownerDocument.createTreeWalker(control, NodeFilter.SHOW_TEXT);
  let words = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!node.parentElement?.closest(DECORATION)) words += ` ${node.textContent}`;
  return words;
}
function commandName(control: Element): string {
  const named = control.getAttribute('aria-label') || control.querySelector('[data-slot=menu-item-label]')?.textContent || visibleWords(control) || control.getAttribute('title') || '';
  return named.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Report every command pressed anywhere under `root`, once, from one delegated listener: no control is wired one by
 * one. Returns the function that stops listening.
 */
export function observeChoices(root: Document | HTMLElement = document): () => void {
  const chose = (event: Event) => {
    const control = (event.target as Element | null)?.closest?.(COMMAND_CONTROLS);
    if (!control || (control as HTMLButtonElement).disabled || control.getAttribute('aria-disabled') === 'true') return;
    if (control.hasAttribute('aria-haspopup') || control.hasAttribute('aria-expanded') || control.closest('[data-feedback=none]')) return;
    const surface = control.closest('[role=toolbar],[role=menu],[role=dialog],[role=region],section,nav,aside')?.getAttribute('aria-label') || undefined;
    reportChoice(commandName(control), surface);
  };
  root.addEventListener('click', chose, true);
  return () => root.removeEventListener('click', chose, true);
}

/** A screen-only command that is not a control press (a pane resized by dragging). */
export function reportScreenCommand(label: string, surface?: string): void {
  const current = sink;
  if (!current || !label) return;
  current.center.emit(label, {kind: 'done', quiet: true, detail: surface || undefined}).finish({kind: 'done'});
  current.record?.({label, surface, outcome: 'done'});
}

/**
 * Run one server command. `label` is null for a command with no words for a
 * person (it is still recorded by the server); the outcome is announced once.
 */
export async function runCommand<T>(label: string | null, run: () => Promise<T>): Promise<T> {
  lastServerCommand = Date.now();
  const current = sink;
  let announced = 0;
  const stop = current?.center.subscribe(change => { if (change.type === 'added') announced += 1; });
  // The page often says what happened itself, right after the command returns ("Archived 3 recordings",
  // "Could not archive"). The generic words wait a moment and stay silent if the page spoke.
  const announce = (title: string, input: Parameters<ActionFeedbackSink['center']['emit']>[1]) => setTimeout(() => {
    stop?.();
    if (current && label && !announced) current.center.emit(title, input);
  }, current?.settleMs ?? 700);
  try {
    const result = await run();
    announce(label ?? '', {kind: 'done', detail: 'Done', timeout: 3500});
    // Work a person asked for got done; whoever answers it (parts/delight-moments) may mark the moment.
    sayHappened({event_kind: 'work-done', label: label ?? ''});
    return result;
  } catch (error) {
    sayHappened({event_kind: 'work-failed', label: label ?? ''});
    announce(`${label ?? ''} did not work`, {kind: 'error', detail: errorWords(error), timeout: 0});
    throw error;
  }
}
