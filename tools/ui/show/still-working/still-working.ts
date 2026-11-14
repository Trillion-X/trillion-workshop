// parts/ui/show/still-working/still-working.ts
//
// NO PRIOR: searched parts/ui/show for words that change while a wait runs ("press-work" says one pending label for
// as long as the work runs, "loading-mark" draws the needle and thread with no words, "screen-state" says a screen's
// loading label only to a screen reader, "live-check" says when Trillion last looked at one thing); none says that a
// long wait is still going, how long it has been, or that it was asked again.
//
// PURPOSE
//   A wait that runs long says it is still working, in words that change as time passes (the way a thinking line
//   says it is still thinking), and says when the road under it asked again (a busy answer sent again by itself), so a
//   30 second wait never looks frozen and a silent retry is never silent. The pressed button's pending face
//   (button/press-work.tsx), a screen's loading rows (screen-state) and a server page's pressed action
//   (server-rendered-page/page-work.mjs) all say it through here.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No product words: the steps and the asked-again words are the owner's DATA, chosen once for the page
//      (`chooseStillWorkingWords`); with none chosen nothing extra is said.
//   2. A step is { after_seconds, words }; the last step whose `after_seconds` has passed is said, filled with
//      {label} (the wait's own words), {seconds} (how long it has run) and {tries} (how many times it was asked again).
//      Before the first step, the wait's own words stand as they are.
//   3. A road that asks again by itself says so on the window (`sayAskedAgain`); every wait running then counts it,
//      and from then on the `again` words are said, so the person knows it restarted.
//   4. No React here: the hook lives in use-still-working.ts, so a server page's plain script can use the words too.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

/** One step of a long wait's words: said once `after_seconds` have passed. */
export type StillWorkingStep = { after_seconds: number; words: string };
/** The owner's words for long waits: the steps in order, and what is said once the wait was asked again. */
export type StillWorkingWords = { steps: StillWorkingStep[]; again: string };

/** The window event a road sends when it asks again by itself (a busy answer sent again). */
export const ASKED_AGAIN_EVENT = 'trillion:asked-again';

let chosen: StillWorkingWords | null = null;

/** Chooses the words every long wait on this page says (invariant 1); the owner calls it once as the page starts. */
export function chooseStillWorkingWords(words: StillWorkingWords | null): void { chosen = words; }

/** The words chosen for this page, or null. */
export const stillWorkingWords = (): StillWorkingWords | null => chosen;

const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (whole, name: string) => String(values[name] ?? whole));

/** What a wait says after `seconds` with `tries` asked again (invariants 2 and 3), or null while its own words stand. */
export function stillWorkingAt(label: string, seconds: number, tries: number, words: StillWorkingWords | null = chosen): string | null {
  if (!words) return null;
  const values = { label, seconds: Math.floor(seconds), tries };
  if (tries > 0) return fill(words.again, values);
  const step = [...words.steps].sort((a, b) => a.after_seconds - b.after_seconds).filter(one => one.after_seconds <= seconds).pop();
  return step ? fill(step.words, values) : null;
}

/** Says that a road asked again by itself (invariant 3). Does nothing outside a browser. */
export function sayAskedAgain(detail: { path?: string; attempt: number }): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ASKED_AGAIN_EVENT, { detail }));
}

/** Listens for every asking again; returns the call that stops listening. */
export function onAskedAgain(listen: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(ASKED_AGAIN_EVENT, listen);
  return () => window.removeEventListener(ASKED_AGAIN_EVENT, listen);
}
