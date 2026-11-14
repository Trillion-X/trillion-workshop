// parts/ui/show/sound-signal/sound-targets.ts
//
// NO PRIOR: searched bitfield-packages show for light sync, follow sound, hue entertainment, and 21st.dev 'smart lights music sync'
//
// PURPOSE
//   Things outside the screen that follow the same sound: the person's lights first, anything that can take a colour
//   and a brightness next. The page registers where its targets come from (registerSoundTargets, done once by the
//   workspace with the person's light services); whatever moves with sound names the targets that follow it by id,
//   and followSound sends each one the look's colour and the sound's brightness, no faster than that target's own
//   pace (`every_ms`, DATA on the target).
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file names no service: a target is an id, words, a pace and a send function handed in by its owner.
//   2. A target is never sent to faster than its pace, and a send still in flight is never overlapped by another.
//   3. Each target's last answer (sent, or what went wrong in plain words) is told to whoever watches, so the switch
//      that turned it on can say whether it works.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { onSoundFrame, type SoundFrame } from './sound-signal';
import type { SoundLook } from './sound-painters';

export type TargetPaint = { colour: string; brightness: number; level: number; beat: boolean; seconds: number };
export type SoundTarget = { id: string; label: string; icon?: string; about?: string; every_ms: number; send: (paint: TargetPaint) => Promise<void> };
export type TargetAnswer = { state: 'idle' | 'sending' | 'sent' | 'failed'; words: string | null; at: number };
type TargetList = Array<SoundTarget>;

let provider: (() => Promise<TargetList>) | null = null;
const answers = new Map<string, TargetAnswer>();
const watchers = new Set<(answers: ReadonlyMap<string, TargetAnswer>) => void>();
const tell = (id: string, answer: TargetAnswer) => { answers.set(id, answer); watchers.forEach(watch => watch(answers)); };

/** The page says where targets come from (once, at start). */
export function registerSoundTargets(next: () => Promise<TargetList>) { provider = next; }

/** The targets the person can have follow the sound now (their lights). */
export async function listSoundTargets(): Promise<TargetList> {
  return provider ? provider().catch(() => []) : [];
}

export function onTargetAnswers(watch: (answers: ReadonlyMap<string, TargetAnswer>) => void): () => void {
  watchers.add(watch);
  watch(answers);
  return () => { watchers.delete(watch); };
}

/** What a target is sent for one moment of the sound in a look: the palette colour the beats have reached, and a
 *  brightness from how loud it is. */
export function paintFor(frame: SoundFrame, look: SoundLook, step: number, seconds: number): TargetPaint {
  return {
    colour: look.palette[step % Math.max(1, look.palette.length)] ?? '#ffffff',
    brightness: Math.max(0.08, Math.min(1, 0.25 + 0.75 * frame.level * (0.4 + look.strength * 0.6))),
    level: frame.level,
    beat: frame.beat,
    seconds,
  };
}

/** Have these targets follow the sound in this look until the returned stop is called. */
export function followSound(targetIds: readonly string[], look: () => SoundLook): () => void {
  if (!targetIds.length) return () => {};
  let stopped = false;
  let targets: TargetList = [];
  const lastSent = new Map<string, number>();
  const busy = new Set<string>();
  let step = 0;
  let loudest: SoundFrame | null = null;
  void listSoundTargets().then(all => { targets = all.filter(target => targetIds.includes(target.id)); });
  const stop = onSoundFrame(frame => {
    if (stopped) return;
    if (frame.beat) step += 1;
    // Between sends the loudest moment is kept, so a beat between two sends is not lost.
    if (!loudest || frame.level > loudest.level || frame.beat) loudest = frame;
    const now = performance.now();
    for (const target of targets) {
      if (busy.has(target.id) || now - (lastSent.get(target.id) ?? 0) < target.every_ms) continue;
      lastSent.set(target.id, now);
      busy.add(target.id);
      const paint = paintFor(loudest, look(), step, Math.min(2, target.every_ms / 1000));
      tell(target.id, { state: 'sending', words: null, at: Date.now() });
      target.send(paint).then(
        () => tell(target.id, { state: 'sent', words: null, at: Date.now() }),
        error => tell(target.id, { state: 'failed', words: String((error as Error)?.message ?? error), at: Date.now() }),
      ).finally(() => busy.delete(target.id));
    }
    loudest = null;
  });
  return () => { stopped = true; stop(); };
}
