// src/workspace/decisions-screen.tsx
//
// PURPOSE
//   Decisions: the decisions this person's AI made with Trillion, drawn by the shared record views from the same
//   store the decision screen reads. Opening one shows it in its own tab, where it can be read, answered, copied or removed.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real rows from the person's store; a plan that keeps no decisions says so in the shared empty state.
//   2. Fields and status words are DATA (fieldsFor and STATUS below); a new column is one row, never drawing code.
//   3. A decision waiting for the person's answer is answered from the list: hovering "Your answer needed" opens the
//      shared hover form (parts/ui/show/record-views/hover-form.tsx) with what was decided and how they would know.

import { mountRecordViews, type FieldDescriptor } from '../../parts/ui/show/record-views/record-views';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { recordFilter } from './record-filter';
import { readJson, readCollectionJson } from './api';
import { askFor, refusal } from './failure';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import surfaces from './screens.mjs';
import { addressOf } from './addresses.mjs';
import { shareAction } from './sharing-sheet';
import { addSelectedToTrayAction } from './tray';
import { backingOn, withBacking } from './automation-preview-source';
import timelineLevels from '../../parts/ui/show/record-views/timeline-zoom-levels.json';
import stanceData from '../record-stance.json';
import { answerForm, type Summary } from './decision-answer';

export { answerForm, type Summary };

type Screen = { free: boolean; summaries: Summary[]; allowance: { count: number | null; used: number } | null };

const STATUS: Record<string, { label: string; tone: string }> = {
  needs_decision: { label: 'Deciding', tone: 'info' },
  needs_outcome: { label: 'Decided', tone: 'success' },
  closed: { label: 'Done', tone: 'neutral' },
};

const fieldsFor = (reload: () => void): FieldDescriptor[] => [
  { id: 'goal', label: 'Decision', icon: 'Compass', ruleKind: 'text', filterable: true, sortable: true, width: 300 },
  { id: 'pursuits', label: 'Pursuit', icon: 'Target', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 230, read: (row: Summary) => row.pursuits?.map(item => item.title) ?? [] },
  { id: 'decision', label: 'Chosen', icon: 'CircleCheck', ruleKind: 'text', filterable: true, sortable: true, width: 150, read: (row: Summary) => row.decision ?? '' },
  { id: 'status', label: 'State', icon: 'CircleDot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 120, values: STATUS },
  // How far it has got, measured by the store from its own facts (src/decision-progress.json).
  { id: 'progress', label: 'Progress', icon: 'CirclePercent', ruleKind: 'text', filterable: true, width: 260, read: (row: Summary) => row.progress ?? 'Not measured' },
  { id: 'waiting', label: 'Waiting for you', icon: 'MessageCircleQuestion', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 180, read: (row: Summary) => (row.outcome_question ? 'Your answer needed' : ''), values: { 'Your answer needed': { tone: 'warning' } }, hoverForm: answerForm(reload) },
  // Where the person stands on each decision, its words and tone from the stands src/record-stance.json lists.
  { id: 'stance', label: 'Your view', icon: 'ThumbsUp', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 150, read: (row: Summary) => stanceData.stances.find(item => item.id === row.stance)?.label ?? '', values: Object.fromEntries(stanceData.stances.map(item => [item.label, { tone: item.list_tone }])) },
  { id: 'created_at', label: 'Started', icon: 'CalendarClock', kind: 'date', ruleKind: 'date', filterable: true, groupable: true, sortable: true, width: 170, read: (row: Summary) => new Date(row.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }), factValue: (row: Summary) => Date.parse(row.created_at), sortValue: (row: Summary) => Date.parse(row.created_at) },
];

export function mountDecisionsScreen(element: HTMLElement): () => void {
  let views: ReturnType<typeof mountRecordViews> | null = null;
  let shown: Summary[] = [];
  const list = document.createElement('div');
  list.className = 'trillion-decisions';
  element.replaceChildren(list);

  // After an answer the rows are read again in place: the list keeps its search, filters and scroll.
  const screen = loadScreen(list, {
    loading: { label: 'Loading your decisions', layout: 'rows' },
    read: () => Promise.all([readCollectionJson<Screen>('/work/api/decisions'), backingOn('trillion.decisions')]),
    empty: ([answer]) => {
      if (answer.summaries.length) return null;
      return answer.free
        ? { status: 'empty', icon: 'Sparkles', title: 'Decisions are kept on a paid plan', description: 'On the free plan your AI still decides with Trillion; the decisions are not kept here.', action: { label: 'See plans', run: () => location.assign(addressOf(surfaces, 'trillion.plan')) } }
        : { status: 'empty', icon: 'Compass', title: 'No decisions yet', description: 'Ask your AI to use Trillion on the next choice you face, and it appears here.', ask: askFor('decisions') };
    },
    failed: refusal('Your decisions could not load'),
    clear: () => { views?.destroy(); views = null; },
    draw: ([answer, behind]) => {
      shown = answer.summaries;
      if (views) { views.update({ records: shown }); return; }
      const rowOf = (id: string) => shown.find(row => row.case_id === id);
      const recordOf = (row: Summary) => row.case_id;
      const titleOf = (row: Summary) => row.goal;
      views = mountRecordViews(list, {
        label: 'Decisions',
        fields: withBacking(fieldsFor(() => void screen.reload()), behind),
        records: shown,
        identify: (row: Summary) => row.case_id,
        shareRecord: recordOf,
        // Its ⋯ offers every tool that takes a decision (menu-rows.tsx: an input of format `trillion:decision`).
        aboutRecord: (row: Summary) => ({ kind: 'decision', id: row.case_id, title: row.goal, record: row.case_id }),
        preferenceKey: 'trillion-decisions',
        views: [{ id: 'gallery', label: 'Timeline' }, { id: 'table', label: 'Table' }, { id: 'board', label: 'Board by pursuit' }],
        view: 'table',
        timeline: { fieldId: 'created_at', levels: timelineLevels as never },
        ...recordFilter,
        // A decision opens in its own tab beside the list (surface trillion.decision), titled by what it decides.
        onOpen: (id: string) => window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id: 'trillion.decision', title: shown.find(row => row.case_id === id)?.goal, surfaceInput: { screen: 'decision', id } } })),
        // One decision's ⋯ shares it through the menu's own Share row (menu-rows `sharing`); several chosen share as one link.
        bulkActions: [shareAction(rowOf, recordOf, titleOf), addSelectedToTrayAction(list, rowOf, recordOf, titleOf)],
        emptyMessage: 'Nothing matches.',
      });
    },
  });
  return () => { screen.dispose(); element.replaceChildren(); };
}
