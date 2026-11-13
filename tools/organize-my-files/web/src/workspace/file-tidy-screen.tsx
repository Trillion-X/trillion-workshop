// src/workspace/file-tidy-screen.tsx
//
// PURPOSE
//   Tidy up (entry `file-tidy`, the screen of the Workshop tool tool:list-file-tidy): the titles and folders the
//   person's own AI suggested for their files (src/file-tidy.mjs through /work/api/namespace/tidy), each with what it is
//   based on and why, in the shared record views. The person accepts or rejects each (one at a time or several
//   selected), applies the accepted ones as one tidy-up, and undoes the latest tidy-up. Applied and undone suggestions
//   stay in the list, grouped by the tidy-up they were part of, which is the history.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real rows: every row is a suggestion the Worker keeps for this person; an empty list is the shared empty
//      state, which sends the person to Files, where Ask my AI to tidy these hands the job to their AI.
//   2. Fields are DATA (FIELDS below, their words in src/file-tidy.json `screen.fields`); every state's label and tone,
//      and the saved view per state, come from src/file-tidy.json `states`. No state is named in drawing code.
//   3. Every control is a shared component (record views, action menu, notifications, screen state).
//   4. Nothing here checks grounding or staleness: applying asks the Worker, which refuses what changed since and says
//      why in its own words.

import { mountRecordViews, type FieldDescriptor } from '../../parts/ui/show/record-views/record-views';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { notify } from '../../parts/ui/show/coss/notifications';
import settings from '../file-tidy.json';
import { postJson, readJson } from './api';
import { refusal } from './failure';
import { goTo } from './open-screen';
import { recordFilter } from './record-filter';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type StateId = keyof typeof settings.states;
type Suggestion = {
  id: string; name: string; identity: string; title: string | null; folder: string | null; reason: string | null;
  evidence: { kind: string; value_identity: string }[]; produced_by: string | null; state: StateId; problem: string | null;
  proposed_at: string; decided_at: string | null; tidy_up: { id: string; applied_at: string; undone_at: string | null } | null;
};
type Listing = { proposals: Suggestion[]; counts: Record<string, number>; can_undo: string | null };
type Applied = { tidy_up: string | null; applied: number; refused: { id: string; name: string; reason: string }[]; said: string };

const words = settings.screen;
const label = (state: StateId) => settings.states[state]?.label ?? state;
const decidable = (row: Suggestion) => (settings.decidable_states as string[]).includes(row.state);
const baseOf = (name: string) => name.slice(name.lastIndexOf('/') + 1);
const parentOf = (name: string) => name.replace(/\/[^/]+$/, '') || '/';
const when = (at: string | null | undefined) => (at ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const tidyUpOf = (row: Suggestion) => row.tidy_up
  ? `${words.tidy_up_on.replace('{date}', when(row.tidy_up.applied_at))}${row.tidy_up.undone_at ? ` (${words.undone_mark})` : ''}`
  : '';

const FIELDS: FieldDescriptor[] = [
  { id: 'file', label: words.fields.file, icon: 'FileText', ruleKind: 'text', filterable: true, sortable: true, width: 240, read: (row: Suggestion) => baseOf(row.name) },
  { id: 'now_in', label: words.fields.now_in, icon: 'Folder', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 180, hiddenByDefault: true, read: (row: Suggestion) => parentOf(row.name) },
  { id: 'title', label: words.fields.title, icon: 'Type', ruleKind: 'text', filterable: true, sortable: true, width: 280, read: (row: Suggestion) => row.title ?? '' },
  { id: 'folder', label: words.fields.folder, icon: 'FolderInput', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 200, read: (row: Suggestion) => row.folder ?? '' },
  { id: 'state', label: words.fields.state, icon: 'CircleDot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 150, read: (row: Suggestion) => label(row.state),
    values: Object.fromEntries(Object.values(settings.states).map(state => [state.label, { tone: state.tone }])) },
  { id: 'evidence', label: words.fields.evidence, icon: 'Quote', kind: 'tag', ruleKind: 'choice', filterable: true, width: 170, read: (row: Suggestion) => row.evidence.map(item => item.kind) },
  { id: 'reason', label: words.fields.reason, icon: 'MessageSquareText', ruleKind: 'text', filterable: true, width: 280, read: (row: Suggestion) => row.reason ?? '' },
  { id: 'problem', label: words.fields.problem, icon: 'TriangleAlert', ruleKind: 'text', filterable: true, width: 260, read: (row: Suggestion) => row.problem ?? '' },
  { id: 'by', label: words.fields.by, icon: 'Bot', ruleKind: 'choice', filterable: true, groupable: true, width: 150, hiddenByDefault: true, read: (row: Suggestion) => row.produced_by ?? '' },
  { id: 'proposed', label: words.fields.proposed, icon: 'CalendarClock', kind: 'date', ruleKind: 'date', filterable: true, sortable: true, width: 170, read: (row: Suggestion) => when(row.proposed_at), factValue: (row: Suggestion) => Date.parse(row.proposed_at), sortValue: (row: Suggestion) => Date.parse(row.proposed_at) },
  // The history: each applied suggestion names the tidy-up it was part of, and grouping by it lists them tidy-up by tidy-up.
  { id: 'tidy_up', label: words.fields.tidy_up, icon: 'History', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 220, read: tidyUpOf, sortValue: (row: Suggestion) => row.tidy_up?.applied_at ?? '' },
];

// One saved view per state (src/file-tidy.json `states`): "Waiting for you", "Done", and the rest.
const stateViews = () => (Object.keys(settings.states) as StateId[]).map(state => ({
  id: `state:${state}`, label: label(state), search: '',
  rules: { kind: 'group' as const, combinator: 'and', negate: false, rules: [{ kind: 'rule' as const, field: 'state', operator: 'is_any_of', params: { values: [label(state)] } }] },
}));

export function mountFileTidyScreen(element: HTMLElement): () => void {
  let views: ReturnType<typeof mountRecordViews> | null = null;
  const list = document.createElement('div');
  list.className = 'trillion-file-tidy';
  element.replaceChildren(list);

  // Each change goes to the Worker and the list is read again from it; a refusal is said in the Worker's words. An
  // accept or reject shows as the row's new state, so only applying and undoing say they finished.
  type Answered = { said?: string; refused?: { id: string | null; name?: string; reason: string }[] };
  const act = async (run: () => Promise<Answered>, done: string | null) => {
    try {
      const answer = await run();
      const refused = answer.refused ?? [];
      if (refused.length) notify(words.not_applied, { kind: 'error', detail: refused.map(item => (item.name ? `${baseOf(item.name)}: ${item.reason}` : item.reason)).join('\n'), timeout: 0 });
      else if (done) notify(done, { kind: 'done', ...(answer.said ? { detail: answer.said } : {}) });
    } catch (error) {
      notify(words.could_not, { kind: 'error', detail: errorWords(error) });
    }
    await screen.reload();
  };
  const decide = (ids: string[], choice: 'accept' | 'reject') => act(() => postJson<Answered>('/work/api/namespace/tidy/decisions', { decisions: ids.map(id => ({ id, choice })) }), null);
  const apply = () => act(() => postJson<Applied>('/work/api/namespace/tidy/apply', {}), words.applied);
  const undo = () => act(() => postJson<Answered>('/work/api/namespace/tidy/undo', {}), words.undone);

  const screen = loadScreen(list, {
    loading: { label: words.loading, layout: 'rows' as const },
    read: () => readJson<Listing>('/work/api/namespace/tidy'),
    failed: refusal(words.failed),
    empty: listing => (listing.proposals.length ? null : { status: 'empty' as const, icon: 'Sparkles', title: words.empty_title, description: words.empty_description, action: goTo(words.open_files, 'trillion.files') }),
    clear: () => { views?.destroy(); views = null; },
    draw: listing => {
      const accepted = listing.counts.accepted ?? 0;
      const accept = { id: 'accept', label: words.accept, icon: 'Check', lead: true, appliesTo: (row: Suggestion) => decidable(row) && row.state !== 'accepted', run: (ids: string[]) => void decide(ids, 'accept') };
      const reject = { id: 'reject', label: words.reject, icon: 'X', appliesTo: (row: Suggestion) => decidable(row) && row.state !== 'rejected', run: (ids: string[]) => void decide(ids, 'reject') };
      const options = {
        label: words.title,
        fields: FIELDS,
        records: listing.proposals,
        identify: (row: Suggestion) => row.id,
        preferenceKey: 'trillion-file-tidy',
        views: [{ id: 'table', label: 'List', icon: 'List' }, { id: 'board', label: 'Board', icon: 'Columns3' }],
        ...recordFilter,
        savedViews: stateViews(),
        rowActions: [accept, reject],
        bulkActions: [accept, reject],
        ...(accepted ? { primaryAction: { label: `${words.apply} (${accepted})`, icon: 'Sparkles', onSelect: () => void apply() } } : {}),
        ...(listing.can_undo ? { moreActions: { label: words.more, icon: 'Ellipsis', items: [{ id: 'undo', label: words.undo, icon: 'Undo2' }], onAction: (id: string) => { if (id === 'undo') void undo(); } } } : {}),
        emptyMessage: 'Nothing matches.',
      };
      if (views) views.update(options as never); else views = mountRecordViews(list, options as never);
    },
  });

  return () => {
    screen.dispose();
    element.replaceChildren();
  };
}
