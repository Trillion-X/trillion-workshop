// parts/feel/show/mount-feel.ts
//
// NO PRIOR: searched bitfield-packages/packages/*/show for "haptic", "feel", "earcon" and "sound effect" (none);
// delight-moments answers the same happened channel with words, this answers it with touch, sound and motion.
//
// PURPOSE
//   The part's entry: started once on a page (the workspace shell, the Chrome extension's own pages), it hears every
//   thing that happened (parts/ui/show/happened), picks the feel its row names (read-data/choose-feel.mjs over
//   records/feel-moments.json), asks the person's show rules for each output, and hands what plays to the device's
//   players (parts/ui/show/feel/play-feel.ts). It also starts the one listener that says what the person's hands did
//   (chosen, lifted, dropped) and wakes sound on the first tap.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names an event, a moment, a feel or an output: rows, rules and players decide.
//   2. A feel plays on the thing it happened to when the sayer handed one (`target`), so a pressed button, a sent box
//      or a dropped row moves itself; with none, touch and sound still play.
//   3. The same feel within the DATA's repeat gap plays once (a button's done and the command's done are one moment).
//   4. `tryFeel` plays a feel row now for the Feel settings, through the same players, so what the person tries is what
//      they will get.
//
// The extensive documentation in this codebase is a critical design feature. You are forbidden from simplifying
// or removing it.

import { onHappened } from '../../ui/show/happened/happened';
import { observeHandling } from '../../ui/show/happened/observe-handling';
import { playFeel, wakeFeelSound, type FeelLogEntry } from '../../ui/show/feel/play-feel';
import { showChanged, showOf } from '../../ui/show/show-rules/show-of';
import {currentPresentationRows} from '../../ui/show/request/current-presentation-rows.mjs';
import { chooseFeel } from 'trillion-workshop/tools/make-things-feel-good/read-data/choose-feel.mjs';

/** The rows of records/feel-moments.json. */
export type FeelRows = {
  repeat_gap_ms?: number;
  outputs: Array<{ id: string; label: string }>;
  feels: Record<string, { label: string } & Record<string, unknown>>;
  moments: Array<{ id: string; label: string; feel: string; on: Record<string, unknown> }>;
};

const pageRules = { changed: showChanged, showOf };

/** Plays one feel row now, every output it has (or only `outputs`), for a person trying it. */
export function tryFeel(rows: FeelRows, feelId: string, target: Element | null, outputs?: string[]): FeelLogEntry {
  const feel = rows.feels[feelId] ?? {};
  const plays = rows.outputs.filter(output => (!outputs || outputs.includes(output.id)) && feel[output.id]).map(output => ({ output: output.id, play: feel[output.id] }));
  return playFeel(plays, { target, moment: 'tried', feel: feelId });
}

/** Starts the feel on this page; returns the call that stops it. */
export default function mountFeel({ props }: { el?: HTMLElement; props: { rows: FeelRows|null; source?:()=>Promise<FeelRows>; subscribe?:(changed:(()=>Promise<void>)&{invalidate:()=>void})=>(()=>void) } }): () => void {
  const rows=currentPresentationRows({...props,failed:error=>{console.warn('Feel rows could not be read.',error);}});
  let played: Record<string, number> = {};
  const stopHearing = onHappened(detail => {
    const current=rows.read();if(!current)return;
    const picked = chooseFeel(current, detail, pageRules, { now: Date.now(), played });
    played = picked.remember;
    if (!picked.moment || !picked.plays.length) return;
    const target = detail.target instanceof Element ? detail.target : null;
    playFeel(picked.plays, { target, moment: picked.moment.id, feel: picked.plays[0].feel });
  });
  const stopHands = typeof document === 'undefined' ? () => {} : observeHandling(document);
  const stopWaking = typeof document === 'undefined' ? () => {} : wakeFeelSound(document);
  return () => { rows.stop(); stopHearing(); stopHands(); stopWaking(); };
}
