// src/workspace/message-task-canvas-screen.tsx
//
// PURPOSE
//   Every message the person wrote, as the tasks their AIs broke it into: one list of tasks in plain words, grouped by
//   pursuit and then by feature, each with how much of it is done, shown through the shared record views every list
//   has (Checklist, Outline, Table, Board, Swimlanes, Sprints, Calendar, Swipe, Document, Canvas and the rest).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A task is a work block an AI recorded (record_blocks, read by src/message-task-canvas.mjs messageTasks): its
//      words, its feature (the block it sits under), its pursuit and its progress come from what was recorded, never
//      guessed. A message no AI broke down yet is one row saying so; this screen never asks a model to split it.
//   2. Every view reads the same fields, each declaring the part it plays (`role`), so a view added to every list draws
//      these tasks with no change here. Filters (pursuit, state, day) are the record views' own rule filters.
//   3. Opening a task shows the exact words of the message it came from, the part it came from marked, and the AI work
//      linked to it (the message-to-work graph, src/message-task-canvas.mjs messageTaskGraph).
//   4. The person's view and grouping choices are kept under this list's preference key; until they choose, it opens on
//      the Checklist grouped by pursuit, then feature.
//   5. Only shared parts draw (parts/ui); no colour, font or control is authored here.
//
// REFERENCES (anatomy taken from, nothing copied)
//   - Airtable grouped grid, a summary on each group heading: https://mobbin.com/screens/7612f4c4-4104-4dbc-8e5f-579dde687f2b
//   - Toggl Track projects, progress bar with "n of m" in its row: https://mobbin.com/screens/17f6dc2f-e4ac-4388-b146-81aeddb113f1
//   - Basecamp to-dos, each task with its done count: https://mobbin.com/screens/8206b12c-8446-4d56-a9fb-af7df5c80b07
//   - Tana To-Do, tasks with state and filters above: https://mobbin.com/screens/8f7056a0-fe49-4cdd-820c-78147a8edcd2
//   - 21st.dev progress (shadcn, id 826): a track and fill with its value beside it; the shared ProgressBar already
//     draws this, so nothing was pulled.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Inline, ProgressBar, Text } from '../../parts/ui';
import { Composer, type ComposerDraft } from '../../parts/ui/show/composer';
import { RecordChipProvider } from '../../parts/ui/show/record-chip';
import { DisclosureSection } from '../../parts/ui/show/disclosure-section/DisclosureSection';
import { mountRecordViews, type FieldDescriptor } from '../../parts/ui/show/record-views/record-views';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { postJson, readJson } from './api';
import { NOT_BROKEN, NO_PURSUIT, doneOfAsked, messageTaskGraph, messageTasks, mergeMessagePage } from '../../../message-task-canvas.mjs';
import { refusal } from './failure';
import { recordFilter } from './record-filter';
import { openScreen, openScreenOn } from './open-screen';
import { useMentionChips, useMentions } from './mentions';
import { keepFiles, postToAllAis, readPastedLink, wordsWithLinks } from './send-message';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';

type Answer = { messages: { id: string; text: string; speaker: string; app: string; at: string }[]; arrivals: unknown[]; blocks?: unknown[]; activity: unknown[]; handoffs?: unknown[]; related?: unknown[]; next_before?: string | null };
type SourceSpan = { message_id: string; start: number; end: number; text: string; task_id?: string };
type Task = {
  id: string; kind: 'task' | 'message'; title: string; status: string; at: string; pursuit: string; feature: string;
  progress: number | null; parent_id: string | null; leaf: boolean; done_count?: number; asked_count?: number;
  detail: string; source_message: string; source_span?: SourceSpan;
};
type Named = { id: string; label: string; pursuit?: string };
type GraphNode = { id: string; label?: string; kind: string; opens?: { surface: string; input: string } };
type Waiting = { sections: { cards: unknown[] }[] };

// Each state a task can be in, with its words and tone; `settled` counts it as done.
const STATES: Record<string, { label: string; tone: string; working?: boolean; settled?: boolean }> = {
  open: { label: 'To do', tone: 'info' },
  in_progress: { label: 'In progress', tone: 'info', working: true },
  blocked: { label: 'Blocked', tone: 'warning' },
  done: { label: 'Done', tone: 'positive', settled: true },
  unbroken: { label: 'Not broken into tasks yet', tone: 'neutral' },
};
const WORDS = {
  list: 'Your tasks',
  no_pursuit: 'No pursuit yet',
  not_broken: 'Not broken into tasks yet',
  done_of: (done: number, asked: number) => `${done} of ${asked} done`,
  waiting: 'Waiting on you',
  loose_tasks: (pursuit: string) => `Other tasks for ${pursuit}`,
};

/** Tasks in the order they read: by pursuit, each feature together, the task heading a feature first, then oldest
 *  asked first. */
function ordered(tasks: Task[], pursuits: Named[]): Task[] {
  const pursuitAt = new Map(pursuits.map((pursuit, at) => [pursuit.id, at]));
  const featureAt = new Map<string, number>();
  for (const task of tasks) if (!featureAt.has(task.feature)) featureAt.set(task.feature, featureAt.size);
  const rank = (task: Task) => [pursuitAt.get(task.pursuit) ?? pursuits.length, task.kind === 'message' ? 1 : 0, featureAt.get(task.feature) ?? 0, task.id === task.feature ? 0 : 1];
  return [...tasks].sort((a, b) => {
    const left = rank(a), right = rank(b);
    for (let at = 0; at < left.length; at += 1) if (left[at] !== right[at]) return left[at]! - right[at]!;
    return a.at.localeCompare(b.at);
  });
}

function highlighted(text: string, span?: SourceSpan) {
  if (!span || span.start < 0 || text.slice(span.start, span.end) !== span.text || (span.start === 0 && span.end === text.length)) return [text];
  return [text.slice(0, span.start), React.createElement('mark', { key: 'span' }, span.text), text.slice(span.end)];
}

/** A group heading: its name, how many of the tasks asked under it are done, and the shared bar. */
function groupHeading(label: string, tasks: Task[]) {
  const { done, asked } = doneOfAsked(tasks);
  const percent = asked ? Math.round((done / asked) * 100) : 0;
  return React.createElement(Inline, { gap: 'sm' },
    React.createElement(Text, { as: 'span', variant: 'body' }, label),
    React.createElement(Text, { as: 'span', variant: 'caption' }, WORDS.done_of(done, asked)),
    asked ? React.createElement(ProgressBar, { percentage: percent, color: 'var(--record-kind-green, var(--color-success))', 'aria-label': `${label}: ${percent}% done`, style: { width: '6rem' } }) : null);
}

/** Words written on one task: sent to the AIs or people they @-name (every AI when they name none) as a message about
 *  that task. */
function WriteOnItem({ item, onSent }: { item: Task; onSent: () => void }) {
  const { mentions, mentionKinds, onMentionQuery } = useMentions();
  const chips = useMentionChips(mentionKinds);
  const send = async (draft: ComposerDraft) => {
    const files = (await keepFiles(draft)).map(file => ({ identity: file.identity }));
    const sent = await postToAllAis<{ message: string }>({ text: wordsWithLinks(draft), files, mentions: draft.mentions, anchor: { record: item.id } }, draft);
    onSent();
    return sent.message;
  };
  return React.createElement(RecordChipProvider, chips, React.createElement(Composer, {
    key: item.id, onSend: send, readLink: readPastedLink, mentions, mentionKinds, onMentionQuery,
    words: { label: `Write on ${item.title}`, placeholder: 'Comment, ask or hand off work. Type @ to send it to an AI or a person', send: 'Send' },
  }));
}

export function mountMessageTaskCanvasScreen(element: HTMLElement): () => void {
  const list = document.createElement('div');
  const detail = document.createElement('div');
  const more = document.createElement('div');
  element.replaceChildren(list, more, detail);
  const moreRoot = createRoot(more);
  let views: ReturnType<typeof mountRecordViews> | null = null;
  let detailRoot: ReturnType<typeof createRoot> | null = null;
  let answer: Answer | null = null;
  let tasks: Task[] = [];
  let pursuits: Named[] = [];
  let features: Named[] = [];
  let graph: { nodes: GraphNode[]; edges: { from: string; to: string }[] } = { nodes: [], edges: [] };
  let waitingCount = 0;
  let loadingMore = false;
  let moreError = false;
  let branching = false;
  let branchMessage = '';
  let branchRequest: { message_id: string; start: number; end: number; request_key: string } | null = null;
  const date = (at: string) => at ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const labelOf = (named: Named[], id: string) => named.find(one => one.id === id)?.label ?? '';

  /** The AI work and results reached from one task on the message-to-work map, nearest first. */
  const linkedWork = (id: string): GraphNode[] => {
    const seen = new Set([id]);
    const found: GraphNode[] = [];
    let edge = [id];
    while (edge.length) {
      const next: string[] = [];
      for (const from of edge) for (const line of graph.edges) {
        if (line.from !== from || seen.has(line.to)) continue;
        seen.add(line.to);
        const node = graph.nodes.find(one => one.id === line.to);
        if (!node || node.kind === 'Block') continue;
        found.push(node);
        next.push(line.to);
      }
      edge = next;
    }
    return found.filter(node => node.opens || node.kind === 'Decision');
  };

  const show = (id: string) => {
    const task = tasks.find(one => one.id === id);
    if (!task) return;
    if (!detailRoot) detailRoot = createRoot(detail);
    const branch = async () => {
      if (!task.source_message || branching) return;
      const body = detail.querySelector('[data-source-body]');
      const selection = window.getSelection();
      let start = task.source_span?.start ?? 0;
      let end = task.source_span?.end ?? task.source_message.length;
      if (body && selection?.rangeCount && !selection.isCollapsed) {
        const range = selection.getRangeAt(0);
        if (body.contains(range.startContainer) && body.contains(range.endContainer)) {
          const before = range.cloneRange();
          before.selectNodeContents(body);
          before.setEnd(range.startContainer, range.startOffset);
          start = before.toString().length;
          end = start + range.toString().length;
        }
      }
      branching = true;
      branchMessage = '';
      show(id);
      try {
        const message_id = task.source_span?.message_id ?? task.id;
        if (!branchRequest || branchRequest.message_id !== message_id || branchRequest.start !== start || branchRequest.end !== end) branchRequest = { message_id, start, end, request_key: `canvas:${crypto.randomUUID()}` };
        await postJson('/work/api/message-task-canvas/branch', branchRequest);
        branchRequest = null;
        branchMessage = 'Work is waiting for an AI.';
        await screen.reload();
      } catch (error) { branchMessage = errorWords(error, 'The work could not be saved. Try again.'); }
      finally { branching = false; show(id); }
    };
    const progressWords = task.asked_count ? WORDS.done_of(task.done_count ?? 0, task.asked_count) : task.progress === null ? '' : `${task.progress}% done`;
    const where = [task.pursuit === NO_PURSUIT ? WORDS.no_pursuit : labelOf(pursuits, task.pursuit), task.kind === 'task' && !features.find(one => one.id === task.feature)?.pursuit ? labelOf(features, task.feature) : ''].filter(Boolean).join(' › ');
    detailRoot.render(React.createElement(DisclosureSection, { title: task.title || WORDS.not_broken, collapsible: true, defaultOpen: true },
      task.source_message ? React.createElement(Text, { as: 'blockquote', variant: 'body', 'data-source-body': true, style: { whiteSpace: 'pre-wrap' } }, ...highlighted(task.source_message, task.source_span)) : null,
      React.createElement(Text, { as: 'p', variant: 'caption' }, [STATES[task.status]?.label, where, progressWords, date(task.at)].filter(Boolean).join(' · ')),
      task.source_message ? React.createElement(Button, { disabled: branching, onMouseDown: (event: React.MouseEvent) => event.preventDefault(), onClick: branch }, branching ? 'Saving work…' : 'Branch work from these words') : null,
      branchMessage ? React.createElement(Text, { as: 'p', variant: 'caption' }, branchMessage) : null,
      ...linkedWork(task.id).map(node => React.createElement(Button, {
        key: node.id, variant: 'outline',
        onClick: () => node.opens ? openScreenOn(node.opens.surface, { [node.opens.input]: node.id }, node.label) : openScreenOn('trillion.decision', { screen: 'decision', id: node.id }, node.label),
      }, node.kind === 'Decision' ? `Open decision: ${node.label ?? node.id}` : `Open ${node.label ?? node.id}`)),
      React.createElement(WriteOnItem, { item: task, onSent: () => void screen.reload() })));
  };

  const fields = (): FieldDescriptor[] => {
    const pursuitValues = Object.fromEntries([...pursuits.map(one => [one.id, { label: one.label }]), [NO_PURSUIT, { label: WORDS.no_pursuit }]]);
    const featureValues = Object.fromEntries([...features.map(one => [one.id, { label: one.pursuit ? WORDS.loose_tasks(one.label) : one.label }]), [NOT_BROKEN, { label: WORDS.not_broken }]]);
    return [
      { id: 'title', label: 'Task', icon: 'ListChecks', role: 'title', ruleKind: 'text', filterable: true, sortable: true, width: 380, read: (row: Task) => row.title },
      { id: 'status', label: 'State', icon: 'CircleCheck', role: 'status', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 170, values: STATES, read: (row: Task) => row.status },
      { id: 'progress', label: 'Progress', icon: 'ChartNoAxesColumn', kind: 'progress', ruleKind: 'number', unit: '%', align: 'left', filterable: true, sortable: true, width: 170, read: (row: Task) => row.progress },
      { id: 'detail', label: 'You wrote', icon: 'Quote', role: 'detail', kind: 'excerpt', ruleKind: 'text', filterable: true, width: 320, preview: true, read: (row: Task) => row.detail },
      { id: 'pursuit', label: 'Pursuit', icon: 'Target', scope: 'pursuit', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 200, hiddenByDefault: true, values: pursuitValues, read: (row: Task) => row.pursuit,
        renderGroup: (value: string, rows: Task[]) => groupHeading(pursuitValues[value]?.label ?? value, rows) },
      { id: 'feature', label: 'Feature', icon: 'Layers', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 220, hiddenByDefault: true, values: featureValues, read: (row: Task) => row.feature,
        renderGroup: (value: string, rows: Task[]) => groupHeading(featureValues[value]?.label ?? value, rows) },
      { id: 'at', label: 'When', icon: 'CalendarClock', role: 'when', kind: 'date', ruleKind: 'date', filterable: true, groupable: true, sortable: true, width: 190, read: (row: Task) => date(row.at), factValue: (row: Task) => Date.parse(row.at), sortValue: (row: Task) => Date.parse(row.at) },
      { id: 'came_from', label: 'Part of', icon: 'GitBranch', hiddenByDefault: true, width: 220, links: { direction: 'from' }, read: (row: Task) => row.parent_id ? [row.parent_id] : [] },
    ];
  };

  const draw = () => {
    const options = {
      label: WORDS.list,
      ...recordFilter,
      fields: fields(),
      records: tasks,
      identify: (row: Task) => row.id,
      preferenceKey: 'trillion-message-tasks',
      defaultView: 'checklist',
      defaultGroupLevels: [{ field: 'pursuit' }, { field: 'feature' }],
      statusField: 'status',
      onOpen: show,
      primaryAction: { label: waitingCount ? `${WORDS.waiting} · ${waitingCount}` : WORDS.waiting, icon: 'BellRing', onSelect: () => openScreen('trillion.home') },
      emptyMessage: 'Nothing matches these filters.',
    };
    if (views) views.update(options); else views = mountRecordViews(list, options);
  };
  const take = (result: Answer) => {
    answer = result;
    const read = messageTasks(result) as { tasks: Task[]; pursuits: Named[]; features: Named[] };
    pursuits = read.pursuits;
    features = read.features;
    tasks = ordered(read.tasks, pursuits);
    graph = messageTaskGraph(result);
  };
  const renderMore = () => {
    if (!answer?.next_before) { moreRoot.render(null); return; }
    moreRoot.render(React.createElement(React.Fragment, null,
      React.createElement(Button, {
        disabled: loadingMore,
        onClick: async () => {
          if (loadingMore || !answer?.next_before) return;
          loadingMore = true;
          moreError = false;
          renderMore();
          try {
            take(mergeMessagePage(answer, await readJson<Answer>(`/work/api/message-task-canvas?${new URLSearchParams({ before: answer.next_before })}`)));
            draw();
          } catch {
            moreError = true;
          } finally {
            loadingMore = false;
            renderMore();
          }
        },
      }, loadingMore ? 'Loading older messages…' : 'Older messages'),
      moreError ? React.createElement(Text, { as: 'p', variant: 'caption' }, 'Older messages could not load. Try again.') : null));
  };
  // How many things only the person can do; the button beside the views opens them on Home.
  void readJson<Waiting>('/work/api/waiting-on-you').then(waiting => {
    waitingCount = waiting.sections.reduce((sum, section) => sum + section.cards.length, 0);
    if (views) draw();
  }, () => undefined);
  const screen = loadScreen(list, {
    loading: { label: 'Loading your tasks', layout: 'rows' },
    read: () => readJson<Answer>('/work/api/message-task-canvas'),
    empty: result => (result.messages.length || (result.blocks ?? []).length ? null : {
      status: 'empty', icon: 'ListChecks', title: 'No messages yet',
      description: 'Messages you send to your AIs appear here as tasks, by pursuit, with how much is done.',
    }),
    failed: refusal('Your tasks could not load'),
    clear: () => { views?.destroy(); views = null; answer = null; moreRoot.render(null); },
    draw: result => {
      take(result);
      draw();
      renderMore();
    },
  });
  return () => { screen.dispose(); views?.destroy(); moreRoot.unmount(); detailRoot?.unmount(); element.replaceChildren(); };
}
