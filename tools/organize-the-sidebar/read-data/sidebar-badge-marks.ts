// packages/sidebar/read-data/sidebar-badge-marks.ts
//
// PURPOSE
// Which mark a sidebar row draws for its live badge, read from DATA
// (sidebar-badge-marks.json): by what the badge counts (the publisher's
// `kind`) and whether the row shows its name or only its icon. A collapsed
// sidebar keeps red for notifications: an unread notification is a small red
// dot, a count of new things shows nothing there.
//
// NON-NEGOTIABLE INVARIANTS
// 1. No code names a kind or a screen; a new kind is a DATA row.
// 2. A kind with no row, a malformed row, and a badge with no kind use the
//    DATA's `fallback`; a fallback that is missing or malformed shows `number`
//    with the name and nothing on the icon alone.
// 3. The marks are the ones the row can draw (SIDEBAR_BADGE_MARKS); any other
//    value in DATA is ignored, never guessed at.

import marks from './sidebar-badge-marks.json' with { type: 'json' };

/** What a row draws for its badge: the words in the quiet pill, a small red dot, or nothing. */
export const SIDEBAR_BADGE_MARKS = ['number', 'dot', 'none'] as const;
export type SidebarBadgeMark = (typeof SIDEBAR_BADGE_MARKS)[number];

/** Whether the row shows its name beside its icon, or only the icon. */
export type SidebarRowShown = 'with_label' | 'icon_only';

type MarkRow = Readonly<Record<SidebarRowShown, SidebarBadgeMark>>;
export interface SidebarBadgeMarks {
  readonly fallback: MarkRow;
  readonly kinds: Readonly<Record<string, MarkRow>>;
}

const BUILT_IN: MarkRow = { with_label: 'number', icon_only: 'none' };
const isMark = (value: unknown): value is SidebarBadgeMark => (SIDEBAR_BADGE_MARKS as readonly unknown[]).includes(value);

function readRow(value: unknown, otherwise: MarkRow): MarkRow {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    with_label: isMark(row.with_label) ? row.with_label : otherwise.with_label,
    icon_only: isMark(row.icon_only) ? row.icon_only : otherwise.icon_only,
  };
}

/** The well-formed marks of a DATA value (invariants 2 and 3). */
export function readSidebarBadgeMarks(value: unknown): SidebarBadgeMarks {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const fallback = readRow(data.fallback, BUILT_IN);
  const kinds = data.kinds && typeof data.kinds === 'object' && !Array.isArray(data.kinds) ? data.kinds as Record<string, unknown> : {};
  return { fallback, kinds: Object.fromEntries(Object.entries(kinds).map(([kind, row]) => [kind, readRow(row, fallback)])) };
}

/** The mark for a badge of `kind` on a row shown `shown`. */
export function sidebarBadgeMark(table: SidebarBadgeMarks, kind: string | undefined, shown: SidebarRowShown): SidebarBadgeMark {
  const row = kind !== undefined && Object.prototype.hasOwnProperty.call(table.kinds, kind) ? table.kinds[kind] : table.fallback;
  return row[shown];
}

/** The sidebar's own marks (sidebar-badge-marks.json). */
export const SIDEBAR_BADGE_MARK_TABLE = readSidebarBadgeMarks(marks);

/** The colours a dot can be drawn in (the shared StatusDot's). */
export const SIDEBAR_DOT_STATUSES = ['success', 'warning', 'error', 'info', 'idle'] as const;
export type SidebarDotStatus = (typeof SIDEBAR_DOT_STATUSES)[number];
const DOT_BY_TONE = (marks as { dot_status_by_tone?: Record<string, unknown> }).dot_status_by_tone ?? {};
/** A dot's colour for a badge's tone (DATA `dot_status_by_tone`); a badge with no tone, or a tone with no row, is red. */
export function sidebarDotStatus(tone: string | undefined): SidebarDotStatus {
  const status = tone !== undefined ? DOT_BY_TONE[tone] : undefined;
  return (SIDEBAR_DOT_STATUSES as readonly unknown[]).includes(status) ? status as SidebarDotStatus : 'error';
}
