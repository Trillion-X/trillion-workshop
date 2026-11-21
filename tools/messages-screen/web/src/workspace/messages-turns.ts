// src/workspace/messages-turns.ts
//
// PURE HELPERS for the Messages screen: a stored time as milliseconds, and a conversation's lines grouped into days and
// turns of talk. No records, no React, no words of its own: the caller hands in the day words (messages-words.json).
// Kept apart so the grouping can be tested on its own (messages-turns.test.ts).

import type { Line } from './chat-records';

export type Turn = { mine: boolean; author: string | null; lines: Line[]; time: number };
export type Day = { key: string; label: string; turns: Turn[] };
export type DayWords = { today: string; yesterday: string };

// Messages from the same side, by the same person, within this many minutes are one turn of talk.
export const TURN_MS = 10 * 60 * 1000;

/** A stored time as milliseconds, from the store's text ("2026-11-20 16:59:07.381+00") or an ISO time; NaN when neither. */
export const timeOfText = (at: string): number => Date.parse(at.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));

/** Today, yesterday, or the day's short date, in the Mac's own time zone. */
export function dayLabelOf(time: number, now: Date, words: DayWords): string {
  const day = new Date(time);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day.toDateString() === now.toDateString()) return words.today;
  if (day.toDateString() === yesterday.toDateString()) return words.yesterday;
  return day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** The lines (oldest first) as days, each day as turns of talk: one side's lines in a row, under one time. */
export function daysOf(lines: Line[], now: Date, words: DayWords): Day[] {
  const days: Day[] = [];
  for (const line of lines) {
    const time = timeOfText(line.timestamp);
    const known = Number.isFinite(time);
    const mine = line.role === 'human';
    const author = mine ? null : line.author ?? null;
    const key = known ? new Date(time).toDateString() : 'unknown';
    let day = days.at(-1);
    if (!day || day.key !== key) {
      day = { key, label: known ? dayLabelOf(time, now, words) : '', turns: [] };
      days.push(day);
    }
    const turn = day.turns.at(-1);
    if (turn && turn.mine === mine && turn.author === author && known && time - turn.time <= TURN_MS) {
      turn.lines.push(line);
      turn.time = time;
    } else {
      day.turns.push({ mine, author, lines: [line], time: known ? time : 0 });
    }
  }
  return days;
}
