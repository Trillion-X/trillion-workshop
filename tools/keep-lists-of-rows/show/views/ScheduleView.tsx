// parts/visual-database/show/views/ScheduleView.tsx
//
// PURPOSE
//   kind:'schedule' — the Gantt view: every record a bar on a time axis from its earliest to its latest date, its rows in
//   lanes (where each stands), weekends shaded, today marked, and a curve from each record to the ones that follow it.
//   Offered to every list that holds a date (source-data/views-offered-to-every-list.json). It works the rows and the
//   axis out of the records and hands them to the shared GanttChart, which draws them.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: it reads roles (`date`, `span`, `dependency-from|to`), never a field name or a list.
//   2. A record with no date is still on the schedule, in its own "not scheduled" group; none is dropped.
//   3. The axis, its zoom steps and every sentence are DATA (source-data/schedule-zoom-levels.json).

import * as React from 'react';
import { CalendarRange } from 'lucide-react';
import { Button, Container, EmptyPlaceholder, GanttChart, SegmentedControl, type GanttChartHandle, type GanttEdge, type GanttRow } from '../../../ui';
import { extractFieldText, extractFieldValue, type VisualDatabaseModel, type VisualDatabaseRecord, type VisualDatabaseViewDescriptor } from '../../read-data/visual-database';
import { axisFor, barBox, dayOf, dependencyPath, edgeFields, keptIso, shiftIso, spanOf, type ScheduleLevel, type ScheduleLimits, type ScheduleSpan } from '../../read-data/schedule-bars';
import type { RecordWriter } from '../../do-work/record-writes';
import schedule from '../../source-data/schedule-zoom-levels.json';
import { toneColor } from '../field-editor-kit';
import { canEditRecord, reportFailure, reportRefused, reportSuccess, writeField } from '../field-editors';

const LEVELS = schedule.levels as ScheduleLevel[];
const LIMITS: ScheduleLimits = { row_px: schedule.row_px, max_days: schedule.max_days, scroll_lead_px: schedule.scroll_lead_px };
const WORDS = schedule.words;
/** A bar says its record's name inside itself once it is at least this wide. */
const BAR_TEXT_MIN_PX = 110;

export interface ScheduleViewProps {
  records: readonly VisualDatabaseRecord[];
  view: VisualDatabaseViewDescriptor;
  model: VisualDatabaseModel;
  onOpenRecord?: (record: VisualDatabaseRecord) => void;
  /** The surface record writer, so changes remain one undoable list mutation. */
  writeRecord?: RecordWriter;
  /** Today as a day count; a test hands a fixed one. */
  today?: number;
}

interface Placed {
  record: VisualDatabaseRecord;
  span: ScheduleSpan | null;
}

/** The records in groups: each lane in its own order, earliest first; records with no date last under their own heading. */
function groupsOf(records: readonly VisualDatabaseRecord[], spanOfRecord: (record: VisualDatabaseRecord) => ScheduleSpan | null): { key: string; label: string; placed: Placed[] }[] {
  const lanes = new Map<string, { label: string; order: number; placed: Placed[] }>();
  const undated: Placed[] = [];
  for (const record of records) {
    const span = spanOfRecord(record);
    if (!span) { undated.push({ record, span }); continue; }
    const lane = lanes.get(record.lane.id) ?? { label: record.lane.label, order: record.lane.order, placed: [] };
    lane.placed.push({ record, span });
    lanes.set(record.lane.id, lane);
  }
  const groups = [...lanes].sort((a, b) => a[1].order - b[1].order).map(([id, lane]) => ({
    key: `lane:${id}`,
    label: lane.label,
    placed: lane.placed.sort((a, b) => a.span!.start - b.span!.start || a.span!.end - b.span!.end),
  }));
  return undated.length ? [...groups, { key: 'not-scheduled', label: WORDS.not_scheduled, placed: undated }] : groups;
}

export function ScheduleView({ records, view, model, onOpenRecord, writeRecord, today = dayOf(new Date().toISOString())! }: ScheduleViewProps): React.ReactElement {
  const [zoomId, setZoomId] = React.useState(() => (LEVELS.some(level => level.id === view.zoom) ? view.zoom! : LEVELS[0]!.id));
  const chart = React.useRef<GanttChartHandle>(null);
  const level = LEVELS.find(candidate => candidate.id === zoomId) ?? LEVELS[0]!;
  const startField = model.fields.find(field => field.role === 'date');
  const endField = model.fields.find(field => field.role === 'span');
  const dependencyFields = model.fields.filter(field => field.role.startsWith('dependency-'));
  const groups = React.useMemo(
    () => groupsOf(records, record => spanOf(startField ? extractFieldText(record, startField)[0] : record.date, endField ? extractFieldText(record, endField)[0] : null)),
    [records, startField, endField],
  );
  const spans = groups.flatMap(group => group.placed.flatMap(({ span }) => (span ? [span] : [])));
  const axis = axisFor(spans, level, LIMITS, today);
  if (records.length === 0) return <EmptyPlaceholder icon={CalendarRange} message={WORDS.empty} data-reach-role="empty-state" />;

  const rows: GanttRow[] = [];
  const byKey = new Map<string, VisualDatabaseRecord>();
  const startEditable = Boolean(startField && startField.editable !== false);
  const endEditable = Boolean(endField && endField.editable !== false);
  const editOf = (record: VisualDatabaseRecord): 'move' | 'resize' | 'refused' => {
    if (!writeRecord || !canEditRecord(record) || !startEditable) return 'refused';
    return endField ? (endEditable && extractFieldText(record, endField)[0] ? 'resize' : 'move') : 'move';
  };
  const reschedule = (key: string, edge: GanttEdge, days: number) => {
    const record = byKey.get(key);
    if (!record || !writeRecord || !startField || editOf(record) === 'refused') return;
    const first = extractFieldText(record, startField)[0];
    const second = endField ? extractFieldText(record, endField)[0] : undefined;
    const holds = edgeFields(first, second);
    const span = spanOf(first, second);
    if (!span) return;
    // Match the chart's one-day minimum when an end is dragged across the other end.
    if (edge === 'start') days = Math.min(days, span.end - span.start);
    else if (edge === 'end') days = Math.max(days, span.start - span.end);
    if (days === 0) return;
    const writes: { descriptor: typeof startField; value: unknown }[] = [];
    const set = (which: 'first' | 'second' | null) => {
      const descriptor = which === 'second' ? endField : startField;
      const value = which === 'second' ? second : first;
      if (descriptor && value) writes.push({ descriptor, value: keptIso(shiftIso(value, days)) });
    };
    if (edge === 'move') { if (first) set('first'); if (second) set('second'); }
    else set(edge === 'start' ? holds.start : holds.end);
    if (!writes.length) return;
    void writeField(writeRecord, record, writes).then(() => reportSuccess(WORDS.moved)).catch(reportFailure(WORDS.dates_scope));
  };
  const boxOf = new Map<string, NonNullable<ReturnType<typeof barBox>>>();
  const centreOf = new Map<string, number>();
  for (const group of groups) {
    rows.push({ key: group.key, kind: 'group', label: group.label, count: group.placed.length });
    for (const { record, span } of group.placed) {
      const box = span ? barBox(span, axis) : null;
      centreOf.set(record.id, rows.length * LIMITS.row_px + LIMITS.row_px / 2);
      if (box) boxOf.set(record.id, box);
      byKey.set(record.id, record);
      rows.push({ key: record.id, kind: 'record', label: record.title, bar: box ? { ...box, color: toneColor(record.lane.tone), edit: editOf(record) } : null, barText: Boolean(box && box.width > BAR_TEXT_MIN_PX) });
    }
  }
  const joins = groups.flatMap(group => group.placed).flatMap(({ record }) => dependencyFields.flatMap(field => {
    const ids = extractFieldValue(record, field);
    return (Array.isArray(ids) ? ids : []).map(String).flatMap(other => {
      // `from` names the records this one follows; `to` the records that follow it.
      const [before, after] = field.role === 'dependency-from' ? [other, record.id] : [record.id, other];
      const a = boxOf.get(before);
      const b = boxOf.get(after);
      return a && b ? [{ key: `${before}>${after}`, ...dependencyPath({ right: a.left + a.width, y: centreOf.get(before)! }, { left: b.left, y: centreOf.get(after)! }) }] : [];
    });
  }));
  // Several fields may name the same pair; one curve each.
  const curves = [...new Map(joins.map(join => [join.key, join])).values()];

  return (
    <Container layout="vertical" gap="sm" padding="none" data-schedule-bars="" data-zoom={level.id}>
      <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
        <SegmentedControl ariaLabel={WORDS.zoom} items={LEVELS.map(({ id, label }) => ({ id, label }))} value={zoomId} onValueChange={setZoomId} />
        <Button variant="ghost" size="sm" disabled={axis.todayLeft === null} onClick={() => chart.current?.scrollToToday('smooth')}>{WORDS.today}</Button>
      </Container>
      <GanttChart ref={chart} rows={rows} axis={axis} joins={curves} rowPx={LIMITS.row_px} leadPx={LIMITS.scroll_lead_px} namesLabel={WORDS.names} resetKey={zoomId}
        onReschedule={reschedule} onRefused={() => reportRefused(WORDS.cannot_edit)} edgeLabels={{ start: WORDS.edge_start, end: WORDS.edge_end }}
        onOpen={key => { const record = byKey.get(key); if (record) onOpenRecord?.(record); }} />
    </Container>
  );
}
