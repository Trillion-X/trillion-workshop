// parts/ui/show/command-table/shortcut-coaching.ts
//
// =============================================================================
// PURPOSE — Shortcut tips that teach by what the person just did
// =============================================================================
//
// When a command that has a shortcut is run the slow way (from the palette, a menu or a button), the tip names the
// shortcut, once in a while: capped for each command, spaced out, capped for the day, and off when the person turned
// tips off. The history is plain data the caller keeps for the person (`CoachingHistory`); this file decides and hands
// back the history to keep. It is pure: no clock of its own, no storage, no screen.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The caps, the spacing and the slower paths are DATA (shortcut-coaching.json); this file names none.
//   2. A command with no keys, or run by its keys, is never coached.
//   3. A tip is decided from the history alone: the same history and time give the same answer.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import rules from './shortcut-coaching.json' with { type: 'json' };

/** What the person has been told: when the last tip was, how many for each command, and how many today. */
export interface CoachingHistory {
  readonly off?: boolean;
  readonly lastAt?: number;
  readonly day?: string;
  readonly today?: number;
  readonly counts?: Readonly<Record<string, number>>;
}

export type CoachingRules = typeof rules;
export type Coaching = { readonly tip: string; readonly history: CoachingHistory } | null;

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The command a tip is about: its id, its title and its keys as one line of text (keysOf, command-table.ts). */
export interface CoachedCommand { readonly id: string; readonly title: string; readonly keys: string }

/**
 * Whether to tell the person the shortcut now. `via` is how the command was just run; `now` the time in milliseconds.
 * Returns the tip and the history to keep, or null.
 */
export function coach(row: CoachedCommand | undefined, via: string, history: CoachingHistory, now: number, using: CoachingRules = rules): Coaching {
  if (!row?.keys || history.off || !using.slower_paths.includes(via)) return null;
  const day = dayOf(now);
  const today = history.day === day ? history.today ?? 0 : 0;
  if ((history.counts?.[row.id] ?? 0) >= using.max_per_command || today >= using.max_per_day) return null;
  if (history.lastAt !== undefined && now - history.lastAt < using.min_gap_seconds * 1000) return null;
  return {
    tip: using.words.tip.replace('{title}', row.title).replace('{keys}', row.keys),
    history: { ...history, lastAt: now, day, today: today + 1, counts: { ...history.counts, [row.id]: (history.counts?.[row.id] ?? 0) + 1 } },
  };
}

/** The history with tips turned on or off. */
export const tipsOn = (history: CoachingHistory, on: boolean): CoachingHistory => ({ ...history, off: !on });
