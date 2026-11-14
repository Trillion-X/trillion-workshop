// src/workspace/keep-next-commitment.ts
//
// Purpose
//   Keeps the line for the Calendar item now or next (tool:name-my-next-commitment, the Workshop's countdown) current for a page that tells a host's mark,
//   by reading the person's own Calendar for the look-ahead and again every `refresh_seconds`.
//
// Non-negotiable invariants
//   1. One read road: /work/api/calendar, the same list the Calendar screen draws, so what the mark counts down to is
//      what the person sees there.
//   2. A read that fails keeps the line it had and tries again at the next refresh; a failed read is never an empty
//      calendar.
//   3. `stop` ends the refresh; nothing is told after it.
//   4. How far ahead counts is the person's menu bar setting (`within`: hours, 0 for today only, and a way to hear it
//      change); a change tells the line again at once, without reading the Calendar again.
//   5. Each calendar's own menu bar choice (calendar settings: auto, always, never) decides whether its items count and how
//      far ahead; a calendar with no choice is auto.
//   6. The countdown is the Workshop tool's answer, read through the one tool road (workshop-tool-api.ts); this page keeps
//      no copy of its rule or words. A failed run keeps the line it had, like a failed read.
import controls from './calendar-controls.json' with { type: 'json' };
import { readJson } from './api';
import { readSavedLabels, readWorkspacePreference } from './records';
import { newRunKey, runWorkshopTool } from './workshop-tool-api';

const SETTINGS = 'calendar-settings';
const COUNTDOWN_TOOL = 'tool:name-my-next-commitment';
const counts = new Map((controls.menubarChoices as { id: string; counts: CommitmentCounting }[]).map(row => [row.id, row.counts]));

export type CommitmentCounting = 'within' | 'always' | 'never';
export type CommitmentItem = { id?: string; title?: string | null; source?: string; starts_at: string; ends_at?: string | null; all_day?: boolean };
export interface CommitmentReach { hours(): number | null; subscribe(listener: () => void): () => void }

// The tool's answer: the line, and the timing it asks for (how far ahead the Calendar is read, how often it is asked again).
type Countdown = { line: string | null; look_ahead_minutes: number; refresh_seconds: number };

export function keepNextCommitment(onChange: (line: string | null) => void, within?: CommitmentReach): () => void {
  let items: CommitmentItem[] = [];
  let timing: { look_ahead_minutes: number; refresh_seconds: number } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let line: string | null = null;
  const countingFor = (source: string): CommitmentCounting => counts.get(readWorkspacePreference<{ menubar?: Record<string, string> }>(SETTINGS)?.menubar?.[source] ?? '') ?? 'within';
  // Asks the tool for the line of these items, with the person's reach and each calendar's counting.
  const countdown = async (list: CommitmentItem[]): Promise<Countdown> => {
    const counting = Object.fromEntries([...new Set(list.map(item => item.source ?? ''))].map(source => [source, countingFor(source)]));
    const hours = within?.hours() ?? null;
    const ran = await runWorkshopTool<Countdown>(COUNTDOWN_TOOL, { items: list, ...(hours === null ? {} : { within_hours: hours }), counting }, newRunKey('next-commitment'));
    return ran.result as Countdown;
  };
  const tell = () => {
    if (stopped) return;
    void countdown(items).then(answer => { if (!stopped) { line = answer.line; onChange(line); } }).catch(() => { /* invariant 6: keep the line it had */ });
  };
  const unhear = within?.subscribe(tell);
  const read = async () => {
    try {
      // The first answer names how far ahead to read and how often to ask again; nothing is assumed here.
      timing ??= await countdown([]);
      const look = timing.look_ahead_minutes;
      const from = new Date(), to = new Date(from.getTime() + look * 60_000);
      await readSavedLabels([`workspace-preference:${SETTINGS}`]);
      const answer = await readJson<{ items: CommitmentItem[] }>(`/work/api/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
      items = answer.items;
    } catch { /* invariant 2: keep what was read */ }
    if (timing && timer === null && !stopped) timer = setInterval(() => { void read(); }, timing.refresh_seconds * 1000);
    tell();
  };
  void read();
  return () => { stopped = true; if (timer !== null) clearInterval(timer); unhear?.(); };
}
