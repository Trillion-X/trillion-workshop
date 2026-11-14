// src/workspace/quiet-send-check.ts
//
// Purpose
//   What the message box checks before it sends into a pursuit: whether a person the message is for (everyone in a pursuit
//   of two; otherwise the people it mentions) is outside their working hours, and whether a person it mentions is not in the
//   pursuit at all. Either is advice, said once: the sender's next send of the same words goes. Each person's own
//   choice of what happens then (parts/timed-action/do-work/quiet-hours.json: nudge, auto_silent, none) decides whether
//   they are told; the answer comes from each member's store through /work/api/community/<id>/quiet-hours, which lets out
//   only quiet or not (src/space-calendars.mjs quiet), never hours.
//
// Non-negotiable invariants
//   1. Nothing here blocks a message. A notice is shown once per person per quiet period (remembered by the start of that
//      period, so it returns in the next), and sending again always sends.
//   2. A person whose hours are unknown, not shared, or could not be asked is not warned about and is not treated as
//      working or quiet: no notice rather than a wrong one.
//   3. A failed check never stops a message: it says nothing and the message goes.
//   4. Every word is DATA (quiet-send-check.json); the modes are DATA (quiet-hours.json).
import words from './quiet-send-check.json' with { type: 'json' };
import { postJson } from './api';
import { readWorkspacePreference, writeWorkspacePreference } from './records';
import { quietNotice, type QuietPerson, type Remembered } from './quiet-notice';

/** Looks before a send. Resolves the notice to show (and remembers it as shown), or null when the message may go. */
export async function quietHold(spaceId: string, mentions: readonly { kind: string; label: string }[], now: number = Date.now()): Promise<string | null> {
  try {
    const answer = await postJson<{ people: QuietPerson[] }>(`/work/api/community/${encodeURIComponent(spaceId)}/quiet-hours`, { at_ms: now });
    const remembered = readWorkspacePreference<Remembered>(words.remember_key) ?? {};
    const notice = quietNotice({ people: answer.people, mentions, others: answer.people.length, remembered });
    if (!notice) return null;
    const next = { ...remembered };
    for (const person of notice.shown) if (person.period_start_ms != null) next[person.person_ref] = person.period_start_ms;
    const kept = Object.fromEntries(Object.entries(next).slice(-words.remember_most));
    void writeWorkspacePreference(words.remember_key, kept).catch(() => {});
    return notice.text;
  } catch { return null; }
}
