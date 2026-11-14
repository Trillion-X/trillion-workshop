// src/workspace/quiet-notice.ts
//
// Purpose
//   The notice a message box shows before sending into a pursuit (quiet-send-check.ts reads the people and calls this):
//   who the message is for, which of them is outside working hours and wants a nudge, and who it names that is not in the
//   pursuit. Pure: no store, no clock.
//
// Non-negotiable invariants
//   1. A person whose hours are unknown, not shared or not asked is never warned about; unknown is not read as quiet.
//   2. A quiet period already shown to the sender for a person (remembered by that period's start) is not shown again.
//   3. Every word is DATA (quiet-send-check.json); the modes are DATA (quiet-hours.json).
import quietModes from 'trillion-workshop/tools/run-work-later-or-on-a-repeat/do-work/quiet-hours.json' with { type: 'json' };
import words from './quiet-send-check.json' with { type: 'json' };

export interface QuietPerson { name: string; person_ref: string; read: boolean; quiet?: boolean; opens_at_ms?: number | null; period_start_ms?: number | null; mode?: string }
export type Remembered = Record<string, number>;

const fill = (template: string, facts: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, name) => facts[name] ?? '');
const named = (names: string[]) => names.join(words.join);

/** The notice for this message, or null: the people it is for, who is quiet and wants a nudge, who is not in the pursuit. */
export function quietNotice({ people, mentions, others, remembered, zone }: {
  people: readonly QuietPerson[]; mentions: readonly { kind: string; label: string }[]; others: number; remembered: Remembered; zone?: string;
}): { text: string; shown: QuietPerson[] } | null {
  const mentioned = new Set(mentions.filter(one => one.kind === 'person').map(one => one.label));
  const known = new Set(people.map(person => person.name));
  const audience = others === 1 ? people : people.filter(person => mentioned.has(person.name));
  const quiet = audience.filter(person => person.read && person.quiet && (quietModes.modes as Record<string, { nudge: boolean }>)[person.mode ?? quietModes.default_mode]?.nudge
    && remembered[person.person_ref] !== person.period_start_ms);
  const away = [...mentioned].filter(label => !known.has(label));
  const lines: string[] = [];
  if (quiet.length) {
    const back = Math.min(...quiet.map(person => person.opens_at_ms ?? Infinity));
    const when = Number.isFinite(back) ? new Date(back).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) }) : '';
    lines.push(fill(quiet.length === 1 ? words.quiet : words.quiet_many, { names: named(quiet.map(person => person.name)), when }));
  }
  if (away.length) lines.push(fill(away.length === 1 ? words.away : words.away_many, { names: named(away) }));
  return lines.length ? { text: lines.join(' '), shown: quiet } : null;
}

