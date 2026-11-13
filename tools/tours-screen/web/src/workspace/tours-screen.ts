// src/workspace/tours-screen.ts
//
// PURPOSE
//   Tours: every guided tour the workspace ships (walkthroughs/*.json) and every tour the person's AIs wrote for them
//   (src/tours.mjs), as one list in the shared record views: whether this person has taken it, its category (the group
//   part's category groups, read through group.load-graph; a tour of their own lately written under Recent) and Show me
//   on each. It opens in the Guide view, the designed view every list is offered (parts/ui/show/record-views/designs),
//   which draws the sectioned rows this screen once drew by hand; Table, Cards, Board and every other view read the
//   same list, and the Guide look is offered on every other list too. A tour about a change (one with a landing time,
//   `changedAt`) is a line of the changelog under What is new: what changed, when, newest first, and Show me walks
//   the person through it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a tour: titles, summaries and step counts are the tours' DATA.
//   2. Whether a tour is taken is read from the person's progress record, the same one the tour host writes, and the
//      list draws again whenever it or the person's own tours change (a tour finished, skipped or written by an AI
//      while this tab is open).
//   3. This file writes no markup: the record views and the designed view draw every row and button.
//   4. Every tour also opens on the canvas (Edit on canvas, src/workspace/canvas-edit-screen.tsx), its steps laid out as
//      their cards to change in place.
//   5. Opened as Waiting tours (surface input `queue_only`), the list is the tours that would start by themselves the
//      next time Trillion opens, read through the same trigger fold, facts and show rules the tour host asks
//      (waitingWalkthroughs), so the list and what shows never disagree: why each waits (its reason and urgency, the
//      show-rules facts), whether a rule holds it and until when, and on each Show me, Hide (the rules' own quick
//      choices: an hour, a week, never), Let it show (takes the person's own rules holding it away) and Dismiss (marked
//      seen without showing). When the next one shows is the person's show rules, opened from the list; nothing here
//      decides it.

import { dismissWalkthroughs, listWalkthroughs, startListedWalkthrough, TOUR_SUBJECT, waitingWalkthroughs, type WaitingWalkthrough } from '../../parts/guided-overlay/show/walkthroughs';
import { chooseShow, onShowChange, removeShowRule, showMenu } from '../../parts/ui/show/show-rules/show-of';
import showRules from '../../../../set-up-my-account/read-data/show-rules.json';
import { WALKTHROUGH_PROGRESS_LABEL } from '../../parts/guided-overlay/do-work/walkthrough-progress';
import { OWN_WALKTHROUGHS_INPUT, TOUR_LIBRARY } from '../../../read-data/tour-library.ts';
import { libraryCategories, libraryRecent } from '../../parts/group/read-data/kept-library';
import type { GroupGraph } from '../../../../turn-frames-into-slides/read-data/group-graph.ts';
import { mountRecordViews, type FieldDescriptor, type RecordView } from '../../parts/ui/show/record-views/record-views';
import { viewsOfferedToEveryList } from '../../parts/ui/show/record-views/every-list-views';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { notify } from '../../parts/ui/show/coss/notifications';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { buildEngineReadCurrentRequestFromLabels, decodeEngineReadCurrentReply, readInputValue, sendRequestToBitfieldTarget, subscribe } from './records';
import { refusal } from './failure';
import { recordFilter } from './record-filter';
import { openScreenOn } from './open-screen';
import { replaceWorkspaceAddress } from './addresses.mjs';

type Tour = ReturnType<typeof listWalkthroughs>[number];
type Row = { id: string; tour: Tour; title: string; detail: string; taken: string; category: string; steps: number; by: string };
type QueueRow = { id: string; tour: Tour; waiting: WaitingWalkthrough; title: string; detail: string; reason: string; urgency: string; queue: string; why: string };
type Props = { surfaceInput?: Record<string, unknown> };

// The tour facts a waiting tour is listed by (why it shows, how urgent), with their words, from the show rules' own
// vocabulary (show-rules.json `subjects.tour.facts`), so a new reason or level is a row there and none here.
type Choice = string | { id: string; label: string };
const tourFact = (id: string) => (showRules.subjects.tour.facts as Array<{ id: string; label: string; choices?: Choice[] }>).find(fact => fact.id === id);
const factValues = (id: string) => Object.fromEntries((tourFact(id)?.choices ?? []).map(choice => (typeof choice === 'string' ? [choice, { label: choice }] : [choice.id, { label: choice.label }])));
const QUEUE_VALUES = { waiting: { label: 'Waiting', tone: 'info' }, held: { label: 'Held by your rules' } };
const URGENCY_TONES: Record<string, string> = { urgent: 'danger' };

const RECENT = 'Recent';
// Every tour about a change is one line of what changed, newest first, and Show me walks through that change.
const CHANGES = 'What is new';
const SHIPPED = "Trillion's tours";

const ownTours = (): Array<{ id: string; saved_at?: unknown }> => {
  const value = readInputValue<unknown>(OWN_WALKTHROUGHS_INPUT);
  return Array.isArray(value) ? value : [];
};

// The categories, read through the group part's own door from its one index group.
async function readCategories() {
  const reply = await sendRequestToBitfieldTarget({ target: 'group.load-graph', payload: { roots: [TOUR_LIBRARY.index_ref] } });
  const answer = JSON.parse(new TextDecoder().decode(reply.payload)) as { graph?: GroupGraph | null };
  return answer.graph ? libraryCategories(answer.graph, TOUR_LIBRARY) : [];
}

export async function readProgress(): Promise<unknown> {
  const reply = decodeEngineReadCurrentReply((await sendRequestToBitfieldTarget(buildEngineReadCurrentRequestFromLabels('person', WALKTHROUGH_PROGRESS_LABEL))).payload);
  return reply.found ? JSON.parse(new TextDecoder().decode(reply.payload)) : null;
}

// Opened as /tours?take=<tour id> (the welcome after paying names the tour for the plan bought, src/checkout-return.mjs),
// that tour starts once, and the address is put back to /tours so a reload does not start it again.
function takeAskedTour(tours: Tour[]) {
  const url = new URL(window.location.href);
  const asked = url.searchParams.get('take');
  if (!asked) return;
  url.searchParams.delete('take');
  replaceWorkspaceAddress(window.history.state, url.pathname + url.search + url.hash);
  const tour = tours.find(item => item.id === asked);
  if (tour) startListedWalkthrough(tour);
}

// The tours as one list: each in the first section the old screen showed it under (Recent, then its category, then
// Trillion's tours), and the section's order kept as the category field's declared values.
async function readTours() {
  const own = ownTours();
  // The shipped tours are the file the page fetches once it has painted (main.tsx), so opening Tours reuses it.
  const [progress, categories, walkthroughs] = await Promise.all([readProgress(), readCategories(), import('trillion-walkthroughs').then(module => module.default)]);
  const tours = listWalkthroughs([...walkthroughs, ...own], progress);
  const waiting = waitingWalkthroughs([...walkthroughs, ...own], progress);
  const recent = new Set(libraryRecent(own, TOUR_LIBRARY));
  const named = categories.filter(category => category.members.length);
  const sectionOf = (tour: Tour) => (recent.has(tour.id) ? RECENT : tour.changedAt ? CHANGES : named.find(category => category.members.includes(tour.id))?.name ?? SHIPPED);
  const ownIds = new Set(own.map(tour => tour.id));
  const when = (time: string) => new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const changes = tours.filter(tour => tour.changedAt).sort((left, right) => Date.parse(right.changedAt!) - Date.parse(left.changedAt!));
  const ordered = [...changes, ...tours.filter(tour => !tour.changedAt)];
  const rows: Row[] = ordered.map(tour => ({
    id: tour.id, tour, title: tour.changedAt && tour.summary ? tour.summary : tour.title,
    detail: tour.changedAt
      ? `${when(tour.changedAt)} · ${tour.steps} ${tour.steps === 1 ? 'step' : 'steps'}`
      : `${tour.summary}${tour.summary ? ' ' : ''}${tour.steps} ${tour.steps === 1 ? 'step' : 'steps'}.`,
    taken: tour.finished ? 'taken' : 'not-taken', category: sectionOf(tour), steps: tour.steps,
    by: ownIds.has(tour.id) ? 'Your AIs' : 'Trillion',
  }));
  const sections = [...(recent.size ? [RECENT] : []), ...(ordered.some(tour => tour.changedAt) ? [CHANGES] : []), ...named.map(category => category.name), SHIPPED];
  return { tours, rows, sections, waiting, queue: queueRows(tours, waiting) };
}

// With its date: a week's pause ends on the same weekday it began.
const timeWords = (time: string) => new Date(time).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// The waiting tours, urgent first: why each waits and what holds it, in the person's words.
function queueRows(tours: Tour[], waiting: WaitingWalkthrough[]): QueueRow[] {
  const urgency = factValues('urgency');
  const rank = Object.keys(urgency);
  const listed = new Map(tours.map(tour => [tour.id, tour]));
  return [...waiting]
    .sort((left, right) => Number(left.held) - Number(right.held) || rank.indexOf(right.urgency) - rank.indexOf(left.urgency))
    .flatMap(item => {
      const tour = listed.get(item.id);
      if (!tour) return [];
      const holding = item.heldBy.map(rule => `"${rule.label}"`).join(', ');
      return [{
        id: item.id, tour, waiting: item, title: tour.changedAt && tour.summary ? tour.summary : item.title, detail: item.summary,
        reason: String(item.facts.reason ?? ''), urgency: item.urgency, queue: item.held ? 'held' : 'waiting',
        why: item.held ? `Held by ${holding}${item.until ? ` until ${timeWords(item.until)}` : ''}` : 'Shows when you next open Trillion',
      }];
    });
}

const queueFields = (): FieldDescriptor[] => [
  { id: 'title', label: 'Tour', icon: 'Route', ruleKind: 'text', filterable: true, sortable: true, width: 300, role: 'title' },
  { id: 'why', label: 'When it shows', icon: 'Clock', ruleKind: 'text', filterable: true, width: 300, role: 'detail' },
  { id: 'queue', label: 'Waiting', icon: 'ListOrdered', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 170, role: 'status', values: QUEUE_VALUES },
  {
    id: 'urgency', label: tourFact('urgency')?.label ?? 'Urgency', icon: 'Flame', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 130,
    values: Object.fromEntries(Object.entries(factValues('urgency')).map(([id, value]) => [id, { ...value, ...(URGENCY_TONES[id] ? { tone: URGENCY_TONES[id] } : {}) }])),
  },
  { id: 'reason', label: tourFact('reason')?.label ?? 'Why it shows', icon: 'Info', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 200, role: 'section', values: factValues('reason') },
  { id: 'detail', label: 'What it shows', icon: 'AlignLeft', ruleKind: 'text', filterable: true, width: 420, hiddenByDefault: true },
];

// The list's count line: how many wait and how many the person's rules hold, the reason there are more than one.
function queueLabel(rows: QueueRow[]): string {
  const held = rows.filter(row => row.queue === 'held').length;
  const free = rows.length - held;
  if (!rows.length) return 'Waiting tours · none';
  return `Waiting tours · ${free} waiting${held ? `, ${held} held by your rules` : ''}`;
}

const failed = (words: string) => (error: unknown) => notify(errorWords(error, words), { kind: 'error' });

// What can be done to waiting tours, each from the person's show rules or progress record, never a decision here.
function queueActions(rows: QueueRow[], redraw: () => void) {
  const of = (ids: string[]) => rows.filter(row => ids.includes(row.id));
  const show = (ids: string[]) => {
    const row = of(ids)[0];
    if (!row || !startListedWalkthrough(row.tour)) notify('This tour could not start. Reload the page and try again.', { kind: 'error' });
  };
  const hide = {
    id: 'hide', label: 'Hide', icon: 'pause',
    // The show rules' own quick choices for a tour (an hour, until tomorrow, a week, never, only on this device).
    choices: (row: QueueRow) => (showMenu(TOUR_SUBJECT, row.waiting.facts)?.choices ?? []).map(choice => ({ id: choice.id, label: choice.label, icon: 'clock' })),
    choose: (ids: string[], choice: string) => {
      void Promise.all(of(ids).map(row => chooseShow(TOUR_SUBJECT, row.waiting.facts, choice))).then(redraw, failed('Your rule could not be kept. Try again.'));
    },
    run: () => openScreenOn('trillion.notification-settings', {}, 'When things show'),
  };
  // The person's own rules holding these tours, taken away; a starting rule is turned off or changed in When things show.
  const letShow = {
    id: 'let-show', label: 'Let it show', icon: 'play-circle',
    appliesTo: (row: QueueRow) => row.waiting.heldBy.some(rule => !rule.starting),
    run: (ids: string[]) => {
      const rules = [...new Set(of(ids).flatMap(row => row.waiting.heldBy.filter(rule => !rule.starting).map(rule => rule.id)))];
      void Promise.all(rules.map(removeShowRule)).then(redraw, failed('That rule could not be taken away. Try again.'));
    },
  };
  const dismiss = {
    id: 'dismiss', label: 'Dismiss', icon: 'x',
    run: (ids: string[]) => {
      void dismissWalkthroughs(of(ids).map(row => row.waiting)).then(kept => {
        if (kept) notify(ids.length === 1 ? 'Dismissed. It stays in Tours to show any time.' : `${ids.length} dismissed. They stay in Tours to show any time.`);
        else notify('These could not be dismissed. Try again.', { kind: 'error' });
        redraw();
      }, failed('These could not be dismissed. Try again.'));
    },
  };
  return {
    rowActions: [{ id: 'show', label: 'Show me', icon: 'play', lead: true, run: show }, hide, letShow, dismiss],
    bulkActions: [hide, letShow, dismiss],
    moreActions: {
      label: 'Waiting tours', icon: 'settings-2',
      items: [
        { id: 'rules', label: 'Change when tours show', icon: 'settings-2' },
        { id: 'dismiss-all', label: 'Dismiss every waiting tour', icon: 'x', confirm: 'Dismiss them all' },
        { id: 'all', label: 'All tours', icon: 'route' },
      ],
      onAction: (id: string) => {
        if (id === 'rules') openScreenOn('trillion.notification-settings', {}, 'When things show');
        else if (id === 'all') openScreenOn('trillion.tours', {}, 'Tours');
        else dismiss.run(rows.map(row => row.id));
      },
    },
  };
}

const fieldsFor = (sections: string[]): FieldDescriptor[] => [
  { id: 'title', label: 'Tour', icon: 'Route', ruleKind: 'text', filterable: true, sortable: true, width: 300, role: 'title' },
  { id: 'detail', label: 'What it shows', icon: 'AlignLeft', ruleKind: 'text', filterable: true, width: 420, role: 'detail' },
  {
    id: 'taken', label: 'Taken', icon: 'CircleCheck', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 150, role: 'status',
    values: { taken: { label: 'Taken', tone: 'success' }, 'not-taken': { label: 'Not taken yet' } },
  },
  {
    id: 'category', label: 'Category', icon: 'Folder', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 180, role: 'section',
    values: Object.fromEntries(sections.map(name => [name, { label: name }])),
  },
  { id: 'steps', label: 'Steps', icon: 'ListOrdered', kind: 'number', ruleKind: 'number', sortable: true, width: 100 },
  { id: 'by', label: 'Written by', icon: 'PenLine', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 140, hiddenByDefault: true },
];

// The list's own views, the Guide look first; a view no part offers is left out.
function toursViews(fields: FieldDescriptor[]): RecordView[] {
  const offered = viewsOfferedToEveryList(fields);
  return [
    ...offered.filter(view => view.id === 'guide'),
    { id: 'table', label: 'Table', icon: 'Table' },
    { id: 'gallery', label: 'Cards', icon: 'LayoutGrid' },
    { id: 'board', label: 'Board', icon: 'Kanban' },
  ];
}

export function mountToursScreen(element: HTMLElement, props: Props = {}) {
  const queueOnly = props.surfaceInput?.queue_only === true;
  let asked = false;
  let views: ReturnType<typeof mountRecordViews> | null = null;
  const host = document.createElement('div');
  host.className = 'trillion-decisions';
  // A tour step can point at the list of waiting tours by this mark, whichever pane it is open in.
  if (queueOnly) host.dataset.waitingTours = '';
  element.replaceChildren(host);
  const screen = loadScreen(host, {
    loading: { label: 'Loading your tours', layout: 'rows' },
    read: readTours,
    empty: () => null,
    failed: refusal('Your tours could not load'),
    clear: () => { views?.destroy(); views = null; },
    draw: ({ tours, rows, sections, waiting, queue }) => {
      if (!asked) { asked = true; takeAskedTour(tours); }
      if (queueOnly) {
        const options = {
          label: queueLabel(queue), fields: queueFields(), records: queue, identify: (row: QueueRow) => row.id, preferenceKey: 'trillion-waiting-tours',
          ...recordFilter,
          // The table first: its ⋯ on each row and its selection hold every action (Hide's choices, Dismiss), for one
          // tour or all of them; the Guide look is one press away.
          views: [...toursViews(queueFields())].sort((left, right) => Number(right.id === 'table') - Number(left.id === 'table')),
          ...queueActions(queue, () => void screen.reload()),
          emptyMessage: 'No tour is waiting. Every tour stays in Tours to show any time.',
        };
        if (views) views.update(options); else views = mountRecordViews(host, options);
        return;
      }
      const fields = fieldsFor(sections);
      const taken = rows.filter(row => row.taken === 'taken').length;
      const options = {
        label: `Tours · ${taken} of ${rows.length} taken`, fields, records: rows, identify: (row: Row) => row.id, preferenceKey: 'trillion-tours',
        ...recordFilter,
        views: toursViews(fields),
        rowActions: [{
          id: 'show', label: 'Show me', icon: 'play', lead: true,
          run: (ids: string[]) => {
            const tour = rows.find(row => row.id === ids[0])?.tour;
            if (!tour || !startListedWalkthrough(tour)) notify('This tour could not start. Reload the page and try again.', { kind: 'error' });
          },
        }, {
          // The tour laid out as its steps on the canvas, where any words or button can be changed in place.
          id: 'edit', label: 'Edit on canvas', icon: 'frame',
          run: (ids: string[]) => {
            const row = rows.find(one => one.id === ids[0]);
            if (row) openScreenOn('trillion.canvas-edit', { id: `tour:${row.id}` }, row.tour.title);
          },
        }],
        // The tours waiting to show by themselves, and why there are more, open as their own list.
        moreActions: {
          label: 'Tours', icon: 'list-ordered', ...(waiting.length ? { badge: waiting.length } : {}),
          items: [{ id: 'waiting', label: `Waiting tours (${waiting.length})`, icon: 'list-ordered' }, { id: 'rules', label: 'Change when tours show', icon: 'settings-2' }],
          onAction: (id: string) => (id === 'waiting'
            ? openScreenOn('trillion.waiting-tours', { queue_only: true }, 'Waiting tours')
            : openScreenOn('trillion.notification-settings', {}, 'When things show')),
        },
        emptyMessage: 'Nothing matches.',
      };
      if (views) views.update(options); else views = mountRecordViews(host, options);
    },
  });
  // The progress record changes when a tour moves or ends, and the person's own tours when an AI writes one; any other
  // record change leaves this screen as it is.
  const watched = async () => JSON.stringify([await readProgress(), ownTours()]);
  let shown = '';
  void watched().then(value => { shown = value; });
  const unsubscribe = subscribe(() => {
    void watched().then(now => {
      if (now !== shown) { shown = now; void screen.reload(); }
    });
  });
  // A rule kept or taken away (here, on a tour's bell, or in When things show) changes what waits.
  const stopRules = onShowChange(() => void screen.reload());
  return () => { unsubscribe(); stopRules(); screen.dispose(); element.replaceChildren(); };
}
