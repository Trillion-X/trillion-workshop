// src/workspace/failure.ts
//
// PURPOSE
//   What a refused read means in this app, handed to the shared screen-state part (parts/ui/show/screen-state) by
//   every screen. A feature the person's plan does not include (`PlanNeeded`, api.ts) is the plan state: a short title
//   naming what a paid plan unlocks, read from that feature's row in src/plan-comparison.json, and one button that
//   opens Plan. Any other refusal is the failed state with the screen's title and the reason in plain words:
//   it tries again by itself first (a refusal that cannot change by asking again does not), then offers Try again and
//   Ask your AI, which opens the AI the person chose (src/ask-your-ai.mjs, the shared OpenChoice) with words saying
//   what failed, on which page, and what Trillion answered, so their AI can help.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The plan state's words are DATA: a feature row's `needs_plan`, else the comparison's `words.needs_plan`, and
//      the button's `words.needs_plan_action`. No screen names its own plan words.
//   2. The Worker's plan refusal words (written for an AI, with an address) are never shown as the plan state.
//   3. A browser that could not reach Trillion, or a Worker that broke, is said in plain words, never as a status code
//      or a browser's own error text; a refusal is shown only through the one gate (sanitizeErrorText), so words
//      written for an AI, an id or a reference never reach the person. The Worker's own words go only to their AI.
//   4. This file writes no markup: every state is drawn by the shared screen-state part.

import comparison from '../plan-comparison.json';
import { needsPlanTitle } from '../plan-needs.mjs';
import { mountScreenState, type AskYourAi, type EmptyScreenState, type FailedScreenState, type StateAction } from '../../parts/ui/show/screen-state';
import type { OpenableChoice } from '../../parts/ui/show/choice-tiles/OpenChoice';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import { PlanNeeded, type UpgradeNeeded } from './api';
import { sanitizeErrorText } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
import { askChoices, CHOSEN_AI } from 'trillion-workshop/tools/set-up-my-account/read-data/ask-your-ai.mjs';
import words from './failure-words.json';

// The Plan screen (src/workspace/surfaces.json).
const PLAN_SCREEN = 'trillion.plan';
const UNREACHED = words.unreached;
const BROKE = words.broke;

/** The plan state's title for a plan refusal: what a paid plan unlocks, in the feature row's own words. */
export const planNeededTitle = (needed: UpgradeNeeded): string => needsPlanTitle(needed.feature?.id ?? null);

/** Why a read was refused, in plain words: the Worker's (or a reason's) own words when they were written for a person. */
export function reasonOf(error: unknown): string {
  if ((error as { slow?: boolean } | null)?.slow === true) return words.slow;
  // Only a request that never reached Trillion is "could not be reached": api.ts marks it, and a direct fetch refuses
  // with the browser's own network words. Any other TypeError is a mistake in the page, said as a problem answering.
  if ((error as { unreached?: boolean } | null)?.unreached === true) return UNREACHED;
  if (error instanceof TypeError && /\b(?:fetch|network|load failed)\b/i.test(error.message)) return UNREACHED;
  const status = (error as { status?: number } | null)?.status;
  if (typeof status === 'number' && (status === 0 || status >= 500)) return status === 0 ? UNREACHED : BROKE;
  return sanitizeErrorText(error instanceof Error ? error.message : typeof error === 'string' ? error : null, BROKE);
}

// A refusal asking again cannot change (the request itself is refused), so it is not tried again by itself.
const settled = (error: unknown) => {
  const status = (error as { status?: number } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
};

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, name) => values[name] ?? whole);

const here = () => (typeof location === 'undefined' ? '' : location.href);
const saidOf = (error: unknown) => (error as { said?: string } | null)?.said || (error instanceof Error ? error.message : String(error ?? '')) || words.broke;

/** The words handed to the person's AI when they ask it about a failure: what failed, where, and what Trillion said. */
function askWords(title: string, error: unknown): string {
  return fill(words.ask_prompt, { title, page: here(), said: saidOf(error) });
}

/** The person's own AI for a screen they cannot get past: every AI app that opens a chat holding `prompt`. */
export function askYourAi(prompt: string): AskYourAi {
  return { choices: askChoices(prompt) as OpenableChoice[], remember: CHOSEN_AI, labels: words.ask, words: prompt };
}

/** The person's own AI for a screen waiting for something it can do, by its name in failure-words.json `asks`. */
export function askFor(name: keyof typeof words.asks): AskYourAi {
  const ask = words.asks[name];
  return askYourAi(ask.prompt);
}

/** The plan state for a plan refusal. */
export function planState(error: PlanNeeded): EmptyScreenState {
  return {
    status: 'empty', icon: 'Sparkles',
    title: planNeededTitle(error.upgrade_needed),
    action: { label: comparison.words.needs_plan_action, run: () => { window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id: PLAN_SCREEN } })); } },
  };
}

/** The state a refused read draws: the plan state for a `PlanNeeded`, else `title` with the reason, tried again by
 *  itself first, then Try again and Ask your AI, and `elsewhere` as the one place to go instead when the screen has one. */
export function failedState(error: unknown, retry: () => void, title: string, elsewhere?: StateAction): FailedScreenState | EmptyScreenState {
  if (error instanceof PlanNeeded) return planState(error);
  return {
    // Every state drawn here is a refused read, which changes nothing, so the person is told their work is as it was.
    status: 'failed', title, description: reasonOf(error), kept: words.read_kept,
    retry: { label: words.retry, run: retry },
    ...(settled(error) ? {} : { again: { label: words.retrying, after: words.retry_after_ms } }),
    ask: askYourAi(askWords(title, error)),
    ...(elsewhere ? { secondary: elsewhere } : {}),
  };
}

/** A screen's refusal, named once: `failed` in a screen-state load. */
export const refusal = (title: string, elsewhere?: StateAction) => (error: unknown, retry: () => void) => failedState(error, retry, title, elsewhere);

/** Draws a refused read into `host` (a read outside a screen-state load, such as an action's plan refusal). */
export function mountFailure(host: HTMLElement, error: unknown, failed: { title: string; retry: () => void }): void {
  mountScreenState(host, failedState(error, failed.retry, failed.title));
}
