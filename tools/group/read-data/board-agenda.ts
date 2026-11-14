// packages/group/read-data/board-agenda.ts
//
// BOARD AGENDA — the human "what's coming up" view: the board's dated cards grouped by URGENCY bucket
// (Overdue / Today / Due soon / Upcoming / Later), each group sorted nearest-first. DISTINCT from the `ics`
// export (a machine calendar file of VEVENTs) and the `summary` census (counts): this is the ordered, grouped
// to-do readout a goal board answers with. A pure COMPOSITION of the shipped due-date engine (`relativeDue`
// gives the urgency + countdown label) — owns no time logic of its own (L069/L093, no god package). Pure +
// deterministic: `now` is INJECTED.

import type { BoardItem } from './group-board-model';
import { itemIsConnector } from './group-board-model';
import { dueDateFromRaw, relativeDue, type DueUrgency } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-due-date.ts';

export interface AgendaEntry {
  readonly memberId: string;
  readonly title: string;
  readonly due: number;
  readonly daysUntil: number;
  /** The countdown label from the due engine ("Today" / "in 5 days" / "3 days ago"). */
  readonly label: string;
  readonly urgency: DueUrgency;
}

export interface AgendaGroup {
  readonly urgency: DueUrgency;
  readonly label: string;
  readonly entries: readonly AgendaEntry[];
}

/** The urgency buckets in display order + their headers. `DueUrgency` is a closed Physics set (day-distance
 *  bands owned by the due engine), so this fixed order/label map is not a Society enum — it is the engine's
 *  own buckets given human names, the display twin of `statusView`. */
const URGENCY_ORDER: ReadonlyArray<{ readonly urgency: DueUrgency; readonly label: string }> = [
  { urgency: 'overdue', label: 'Overdue' },
  { urgency: 'today', label: 'Today' },
  { urgency: 'soon', label: 'Due soon' },
  { urgency: 'upcoming', label: 'Upcoming' },
  { urgency: 'later', label: 'Later' },
];

/** A card's TITLE = its first non-empty line. */
function titleOf(item: BoardItem): string {
  const t = typeof item.text === 'string' ? item.text : '';
  const first = (t.split(/\r?\n/, 1)[0] ?? '').trim();
  return first.length > 0 ? first : '(untitled)';
}

/**
 * Group the board's dated cards into the agenda at `now`. Cards with no due date, connectors, and sections are
 * skipped. Each group's entries are sorted nearest-due first (id tie-break → deterministic); empty buckets are
 * dropped. Pure.
 */
export function boardAgenda(items: readonly BoardItem[], now: number): AgendaGroup[] {
  const entries: AgendaEntry[] = [];
  for (const it of items) {
    if (itemIsConnector(it) || it.isSection) continue;
    const due = dueDateFromRaw(it.extra?.dueDate);
    if (due === null) continue;
    const rel = relativeDue(due, now);
    entries.push({ memberId: it.memberId, title: titleOf(it), due, daysUntil: rel.daysUntil, label: rel.label, urgency: rel.urgency });
  }
  return URGENCY_ORDER.map(({ urgency, label }) => ({
    urgency,
    label,
    entries: entries.filter((e) => e.urgency === urgency).sort((a, b) => a.due - b.due || a.memberId.localeCompare(b.memberId)),
  })).filter((g) => g.entries.length > 0);
}

/** A human agenda report — a header per non-empty urgency group + one line per dated card. `No dated goals`
 *  when the board has none. The `agenda` document-export format renders this. */
export function agendaText(agenda: readonly AgendaGroup[], title?: string): string {
  const lines: string[] = [];
  if (title && title.trim().length > 0) lines.push(title.trim(), '');
  if (agenda.length === 0) {
    lines.push('No dated goals');
    return lines.join('\n');
  }
  for (const g of agenda) {
    lines.push(`${g.label} (${g.entries.length})`);
    for (const e of g.entries) lines.push(`  ${e.title} — ${e.label}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
