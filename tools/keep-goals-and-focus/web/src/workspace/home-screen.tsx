// src/workspace/home-screen.tsx
//
// PURPOSE
//   Home, the screen Trillion opens on, as an arrangement of screens the person arranges like any other screen (its
//   row's `surface_input.arrangement` in records/workshop-screen-tool-records.json, drawn by the window's own
//   arrangement through src/workspace/screen-own-arrangement.ts): by default a greeting with the message box and the one next step,
//   stat cards with their lines over time, the needle-mover spotlight, the time-to-decide chart, what is waiting for the
//   person's answer (answered in place by hovering it), what their AIs are working on (open AI work as a few
//   workstreams), recent decisions, their messages, what they are working toward and suggestions.
//   Each of those is its own screen (a row of records/workshop-screen-tool-records.json whose entry is `home-card`), so
//   it can be moved, resized, replaced or removed, opened in a pane on its own, and any other screen the person is
//   offered can join Home beside them. Each part is drawn by the shared dashboard (tools/ui/show/dashboard) from one
//   read of the person's own tables: each read names a role, and the role's database comes from the person's own records
//   (read-data/home-sources.json). Unread notices that need an answer, open AI work and goals are read here; decisions
//   come from the decisions owner, and the person's messages wait for an index on their table.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real rows from the person's store; nothing is made up, and an empty card says so plainly.
//   2. Every word is in src/home-words.json; a suggestion is one DATA row there, never code here.
//   3. Answering a decision happens on this screen (the shared hover form); opening one opens it beside Home.
//   4. Each goal carries no queue button for now: asking the person's AIs to look into it needs an owner route that is not
//      wired to this screen yet, so the button is not shown rather than shown as a failure.
//   6. Home's parts share one read: every part on the page draws from one read of Home's answers (kept a few seconds),
//      reading again together after an answer, wherever the parts are placed.
//   7. How the person arranged Home is kept like any screen's (`screen-arrangement-of::trillion.home`), across
//      devices; without one Home is its row's arrangement. Home placed inside its own arrangement says so and offers
//      another screen in its place.
//   9. Home is one screen made of screens; any row can be another (the Mac menu bar panel is one) by carrying its own
//      `surface_input.arrangement`, including tabs (a pane of several screens), each placed with its own `kept_as`.
//   5. The goal marked `needle_mover` is drawn large first; every other goal can be made the one. With none marked,
//      the goal with the most other goals set under it is drawn as Trillion's guess, saying why, with Make it the one;
//      with no goal under another, the card says how to choose one (home-words.json needle_mover).
//      Goals are rows of home_goals in the person's own database (home-sources.json goals): a new goal is a new row with
//      its own id, and the needle-mover mark is one statement that sets it on the chosen goal alone.
//   8. Open AI work (the job runs not yet finished, home-sources.json open_work) is one row per job it started from, never one per job: the row says the first
//      job's own words cut to one line, and under it what is stuck or how many are where, in the overview sections of
//      the shared work-state looks (tools/screen-look/show/work-state-looks.json), both wrapping rather than cut. What is
//      stuck comes first.
//  10. Each part waits only for the reads it draws from (PART_READS): one slow or failed read shows loading or its
//      failure in the parts drawn from it, never a blank Home. On a busy store /work/api/decisions took over two
//      minutes and every part of Home waited for it (2026-10-08).

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardCardView, DashboardHead, DashboardPiece, DashboardStats, type DashboardCard, type DashboardProps, type DashboardStat } from '../../../../ui/show/dashboard';
import { Composer, type ComposerDraft } from '../../../../ui/show/composer';
import { InstantScreen } from './instant-screen';
import { useMentions } from './mentions';
import { useSnippets } from './snippets';
import { loadScreen } from '../../../../ui/show/screen-state';
import { relativeWhen } from '../../../../ui/show/relative-time/relative-time';
import { PLACEABLE_SURFACE_MIME } from '../../../../ui/show/placeable-surface-intent/placeable-surface-intent';
import { runWorkshopTool } from './workshop-tool-api';
import { readPastedLink } from './send-message';
import { useSendChoices } from './send-choices';
import { JobRuns } from './job-runs-later';
import { notify } from '../../../../ui/show/coss/notifications';
import { refusal } from './failure';
import type { HoverForm } from '../../../../ui/show/record-views/hover-form';
import surfaces from './screens.mjs';
import type { ScreenProps } from './lazy-screen';
import words from '../home-words.json';
import workLooks from '../../../../screen-look/show/work-state-looks.json';
import sources from '../../../read-data/home-sources.json';
import { goalsOf, isMissingTable, openWorkOf, rolesOf, waitingOf } from '../../../read-data/home-answers.mjs';
import { onKeptAnswerReplaced } from '../../../../ui/show/request/kept-answers';
import { sayHappened } from '../../../../ui/show/happened/happened';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { titleOf } from '../work-title.mjs';
type Summary = { case_id: string; goal: string; status: string; outcome_question: string | null; decision: string | null; created_at: string };
type Waiting = { id: string; title: string; detail: string | null };
type Pursuit = { id: string; title: string; now?: string; after?: string; why_it_matters?: string; needle_mover?: boolean; parents?: string[]; children?: string[] };
type Job = { handoff_id: string; status: string; job: string; said: string | null; in_the_way: string | null; parent_handoff_id: string | null; handed_at: string; finished_at: string | null };
type Work = { work: Job[] };
type Home = { summaries: Summary[]; waiting: Waiting[]; pursuits: Pursuit[] };
type Roles = Partial<Record<'notices' | 'goals' | 'messages' | 'open_work', string>>;
type Message = { id: string; text: string; speaker: string; app: string; at: string };

const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));
type GlancePart = { count: string; one: string; many: string; opens?: string; tone?: string; tone_from?: number };
/** The counts under the greeting as tiles (home-words.json `summary`): each its number over its words for one or for
 *  any other number, opening its screen when pressed, never one sentence of joined parts. */
const glanceTiles = (parts: GlancePart[], counts: Record<string, number>) => parts.map(part => {
  const n = counts[part.count] ?? 0;
  return { id: part.count, value: String(n), label: fill(n === 1 ? part.one : part.many, { n }),
    ...(part.tone && n >= (part.tone_from ?? 0) ? { tone: part.tone } : {}),
    ...(part.opens ? { open: { label: part.one, run: () => open(part.opens!) } } : {}) };
});

// Opens one of this app's screens beside Home, with the input it was given added to the screen's own.
function open(id: string, title?: string, input: Record<string, unknown> = {}) {
  const surface = (surfaces.surfaces as { id: string; surface_input?: Record<string, unknown> }[]).find(item => item.id === id);
  if (!surface) return;
  window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { ...surface, ...(title ? { title } : {}), surfaceInput: { ...surface.surface_input, ...input } } }));
}
const opener = (label: string, id: string) => ({ label, run: () => open(id) });

// Every read and write of Home's own tables: one statement run at the account's door, with the owner's credential and
// the statement's own time limit (home-sources.json statement_timeout_ms), so no read holds a database.
const runSql = async (credential_name: string, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> => {
  const ran = await runWorkshopTool<{ rows?: Record<string, unknown>[] }>(sources.tool, { credential_name, sql, params, statement_timeout_ms: sources.statement_timeout_ms });
  if (!Array.isArray(ran.result?.rows)) throw new Error(words.unreadable);
  return ran.result.rows;
};
// The person's role-to-connection map, one row of their own records; with no row, no role has a database.
const readRoles = async (): Promise<Roles> => rolesOf((await runSql(sources.roles_credential, sources.roles_sql, [sources.roles_label]))[0]?.value);
const readRowsOf = async (roles: Roles, read: { role: string; sql: string }) => {
  const credential = roles[read.role as keyof Roles];
  return credential ? runSql(credential, read.sql, [sources.most]) : [];
};
const readGoals = async (roles: Roles): Promise<Pursuit[]> => {
  const credential = roles.goals;
  if (!credential) return [];
  try {
    return goalsOf(await runSql(credential, sources.goals.select, [sources.most])) as Pursuit[];
  } catch (cause) {
    // No goal has been written yet, so the table is not made: nothing is kept there.
    if (isMissingTable(cause instanceof Error ? cause.message : String(cause))) return [];
    throw cause;
  }
};
// A change to goals: its statement runs with the goals role's connection, and a person with no goals place is told so.
const writeGoals = async (sql: string, params: unknown[]) => {
  const credential = (await readRoles()).goals;
  if (!credential) throw new Error(words.no_goal_place);
  return runSql(credential, sql, params);
};

// Makes one goal the biggest needle mover: one statement sets the mark on it alone, so no other goal keeps it.
const makeNeedleMover = async (chosen: Pursuit, reload: () => void) => {
  try {
    await writeGoals(sources.goals.make_needle_mover, [chosen.id]);
    notify(words.pursuits.made_needle_mover, { kind: 'done' });
    sayHappened({ event_kind: 'needle-found', pursuit: chosen.id });
    reload();
  } catch (cause) { notify(errorWords(cause), { kind: 'error' }); }
};

// The add-a-goal form: its boxes are home-words.json add_pursuit.fields, each named for the field it fills.
const addPursuitForm = (reload: () => void): HoverForm => ({
  title: words.add_pursuit.title,
  fields: words.add_pursuit.fields,
  submit: words.add_pursuit.submit,
  run: async values => {
    const goal = Object.fromEntries(Object.entries(values).map(([name, text]) => [name, text.trim() || null]));
    if (!goal.title) throw new Error(words.add_pursuit.title_missing);
    await writeGoals(sources.goals.create, []);
    await writeGoals(sources.goals.insert, [crypto.randomUUID(), goal.title, goal.now, goal.after, goal.why_it_matters]);
    notify(words.add_pursuit.saved, { kind: 'done' });
    reload();
  },
});

// The large card for the one goal that moves the others most, or the way to find it.
function needleMoverCard(home: Home, reload: () => void): DashboardCard {
  const base = { kind: 'spotlight' as const, id: 'needle-mover', wide: 'full' as const, title: words.needle_mover.title };
  const top = home.pursuits.find(item => item.needle_mover);
  if (top) return { ...base, headline: top.title, detail: top.why_it_matters, stages: stagesOf(top) };
  if (!home.pursuits.length) return { ...base, headline: words.needle_mover.empty_headline, detail: words.needle_mover.empty_detail, form: { label: words.add_pursuit.label, form: addPursuitForm(reload) } };
  const likely = likelyNeedleMover(home.pursuits);
  if (likely) return { ...base, title: words.needle_mover.likely_title, headline: likely.pursuit.title,
    stages: stagesOf(likely.pursuit), detail: fill(likely.under === 1 ? words.needle_mover.likely_detail.one : words.needle_mover.likely_detail.many, { n: likely.under }),
    action: { label: words.needle_mover.make_it, run: () => makeNeedleMover(likely.pursuit, reload) } };
  return { ...base, headline: words.needle_mover.choose_headline, detail: words.needle_mover.choose_detail };
}

const stagesOf = (goal: Pursuit) => [goal.now ? { label: words.needle_mover.now, text: goal.now, tone: 'quiet' as const } : null, goal.after ? { label: words.needle_mover.after, text: goal.after, tone: 'accent' as const } : null].filter(stage => stage !== null);

/** Trillion's guess at the goal that moves the others most, when none is marked: the one with the most goals set under it
 *  (counted through every level, each once), the earlier listed on a tie; none when no goal sits under another. */
export function likelyNeedleMover(pursuits: Pursuit[]): { pursuit: Pursuit; under: number } | null {
  const below = new Map<string, Set<string>>(pursuits.map(item => [item.id, new Set(item.children ?? [])]));
  for (const item of pursuits) for (const parent of item.parents ?? []) below.get(parent)?.add(item.id);
  const under = (id: string) => {
    const seen = new Set<string>();
    const walk = (at: string) => { for (const child of below.get(at) ?? []) if (child !== id && !seen.has(child)) { seen.add(child); walk(child); } };
    walk(id);
    return seen.size;
  };
  let best: { pursuit: Pursuit; under: number } | null = null;
  for (const pursuit of pursuits) { const count = under(pursuit.id); if (count > (best?.under ?? 0)) best = { pursuit, under: count }; }
  return best;
}

const sectionOf = (status: string) => (workLooks.states as Record<string, { section: string }>)[status]?.section ?? 'later';
const sectionRank = (section: string) => { const at = workLooks.sections.findIndex(item => item.id === section); return at < 0 ? workLooks.sections.length : at; };

/** Open AI work as workstreams: every open job under the job it started from (invariant 8); pressing a row opens AI work. */
export function workstreamsCard(work: Work): DashboardCard {
  const said = words.workstreams;
  const byId = new Map(work.work.map(job => [job.handoff_id, job]));
  const rootOf = (job: Job) => { let at = job; const seen = new Set([at.handoff_id]); while (at.parent_handoff_id && byId.has(at.parent_handoff_id) && !seen.has(at.parent_handoff_id)) { at = byId.get(at.parent_handoff_id)!; seen.add(at.handoff_id); } return at; };
  const streams = new Map<string, { root: Job; open: Job[] }>();
  for (const job of work.work) {
    if (job.finished_at || sectionOf(job.status) === 'finished') continue;
    const root = rootOf(job);
    const stream = streams.get(root.handoff_id) ?? { root, open: [] };
    stream.open.push(job);
    streams.set(root.handoff_id, stream);
  }
  const rows = [...streams.values()].map(stream => {
    const sections = stream.open.map(job => sectionOf(job.status));
    const first = Math.min(...sections.map(sectionRank));
    const stuck = stream.open.find(job => sectionOf(job.status) === 'needs-you' && job.in_the_way);
    const latest = stream.open.reduce((at, job) => (job.handed_at > at ? job.handed_at : at), stream.root.handed_at);
    const look = (workLooks.states as Record<string, { label: string }>)[stream.open.find(job => sectionRank(sectionOf(job.status)) === first)!.status];
    return { first, latest, row: {
      id: stream.root.handoff_id, title: titleOf(stream.root), icon: said.icon, meta: relativeWhen(latest), whole: true,
      detail: stuck ? fill(said.stuck, { why: stuck.in_the_way! }) : said.counts.map(part => ({ part, n: sections.filter(section => section === part.section).length }))
        .filter(({ n }) => n).map(({ part, n }) => fill(n === 1 ? part.one : part.many, { n })).join(' · '),
      ...(look ? { badge: { label: look.label, tone: said.counts.find(part => sectionRank(part.section) === first)?.tone } } : {}),
      open: () => open(said.opens) } };
  }).sort((a, b) => a.first - b.first || b.latest.localeCompare(a.latest));
  return { kind: 'rows', id: 'workstreams', wide: true, title: said.title, description: said.description, empty: said.empty,
    more: rows.length ? opener(said.more, said.opens) : undefined, rows: rows.slice(0, said.count).map(item => item.row) };
}


const greetingAt = (hour: number) => words.greetings.find(item => hour < item.until_hour)?.text ?? words.greetings[words.greetings.length - 1].text;

// The one composer (tools/ui/show/composer): words, files, links, voice, video, screen and drawings, sent once to every
// AI on the account (src/workspace/send-message.ts), or where the person chose (src/workspace/send-choices.ts); Home
// reads its numbers again after each send. Under it, as the words are written, the screen they pick (instant-screen.tsx).
function HomeComposer({ reload }: { reload: () => void }) {
  const [written, setWritten] = React.useState('');
  const choices = useSendChoices();
  const send = React.useCallback(async (draft: ComposerDraft) => {
    const said = await choices.send(draft);
    reload();
    return said;
  }, [reload, choices.send]);
  const { mentions, mentionKinds, onMentionQuery } = useMentions();
  const snippets = useSnippets();
  // What each send from this box started shows under it, being done (job-run.tsx).
  return (
    <React.Fragment>
      <Composer onSend={send} pickers={choices.pickers} snippets={snippets} words={words.ask_bar} readLink={readPastedLink} mentions={mentions} mentionKinds={mentionKinds} onMentionQuery={onMentionQuery} onWordsChange={setWritten} />
      <InstantScreen words={written} />
      <JobRuns runs={choices.runs} />
    </React.Fragment>
  );
}

type Facts = Record<string, number>;
const holds = (rule: { fact: string; at_most?: number; at_least?: number }, facts: Facts) => {
  const value = facts[rule.fact] ?? 0;
  return (rule.at_most === undefined || value <= rule.at_most) && (rule.at_least === undefined || value >= rule.at_least);
};

export function homeDescription(home: Home, messages: Message[], work: Work, reload: () => void, now = new Date()): DashboardProps {
  const waiting = home.waiting;
  const deciding = home.summaries.filter(row => row.status === 'needs_decision');
  const facts: Facts = { decisions: home.summaries.length, waiting: waiting.length, pursuits: home.pursuits.length, messages: messages.length };
  const recentMessages = messages.filter(message => message.speaker === 'person');

  const stats: DashboardStat[] = [{ id: 'waiting', label: words.stat_waiting, value: String(waiting.length), detail: waiting.length ? words.stat_waiting_detail : words.stat_waiting_none }];
  const cards: DashboardCard[] = [
    needleMoverCard(home, reload),
    workstreamsCard(work),
    // The time-to-decide line needs each decision's own timing, which no owner table keeps yet, so the chart stays empty.
    { kind: 'chart', id: 'deciding', wide: true, title: words.chart.title, description: words.chart.description, empty: words.chart.empty,
      points: [], unit: 'seconds', better: 'lower' },
    { kind: 'rows', id: 'waiting', title: words.waiting.title, description: words.waiting.description, empty: words.waiting.empty,
      rows: waiting.map(row => ({ id: row.id, title: row.title, detail: row.detail ?? undefined })) },
    { kind: 'rows', id: 'recent', wide: true, title: words.recent.title, description: words.recent.description, empty: words.recent.empty, more: opener(words.recent.more, words.recent.opens),
      rows: home.summaries.slice(0, words.recent.count).map(row => {
        const status = (words.status as Record<string, { label: string; tone: string }>)[row.status];
        return { id: row.case_id, title: row.goal, detail: row.decision ?? undefined, meta: relativeWhen(row.created_at), badge: status, action: { label: words.recent.action, run: () => open('trillion.decision', row.goal, { screen: 'decision', id: row.case_id }) } };
      }) },
    { kind: 'feed', id: 'messages', wide: true, title: words.messages.title, description: words.messages.description, empty: words.messages.empty, more: opener(words.messages.more, words.messages.opens),
      items: recentMessages.slice(0, words.messages.count).map(message => ({
        id: message.id, who: message.app, picture: null,
        title: message.text.replace(/\s+/g, ' ').trim().slice(0, 120) || words.messages.with_files,
        at: message.at,
      })) },
    { kind: 'rows', id: 'pursuits', wide: true, title: words.pursuits.title, description: words.pursuits.description, empty: words.pursuits.empty, more: opener(words.pursuits.more, words.pursuits.opens),
      form: { label: words.add_pursuit.label, form: addPursuitForm(reload) },
      // Where a goal is now and where it is going are two state chips, `now -> after`, not a sentence.
      rows: home.pursuits.map(item => ({ id: item.id, title: item.title, icon: words.pursuits.icon,
        ...(item.now && item.after ? { chips: [{ label: item.now, tone: words.pursuits.now_tone }, { label: item.after, tone: words.pursuits.after_tone, arrow: true }] } : {}),
        badge: item.needle_mover ? { label: words.pursuits.needle_badge, tone: 'good' } : { label: words.pursuits.badge, tone: 'info' },
        ...(item.needle_mover ? {} : { action: { label: words.pursuits.make_needle_mover, run: () => makeNeedleMover(item, reload) } }) })) },
    { kind: 'rows', id: 'suggestions', title: words.suggestions.title, description: words.suggestions.description, empty: words.suggestions.empty,
      rows: words.suggestions.items.filter(item => holds(item.show_when, facts)).slice(0, 3).map(item => ({ id: item.id, title: item.title, detail: item.detail, action: opener(item.action, item.opens) })) },
  ];

  const first = waiting[0];
  const next: DashboardProps['next'] = first ? { title: fill(words.next_answer.title, { question: first.title }), detail: first.detail ?? undefined }
    : !home.summaries.length ? { title: words.next_first.title, detail: words.next_first.detail, action: opener(words.next_first.action, words.next_first.opens) }
    : undefined;

  return {
    greeting: greetingAt(now.getHours()),
    glance: glanceTiles(words.summary, { waiting: waiting.length, deciding: deciding.length, pursuits: home.pursuits.length }),
    next,
    stats,
    cards,
  };
}

/** Everything Home's parts draw from, read once (invariant 6). */
type HomeAnswers = { home: Home; messages: Message[]; work: Work };
type HomeReads = { [Read in keyof HomeAnswers]: Promise<HomeAnswers[Read]> };
type HomeRead = keyof HomeReads;


/** Each of Home's reads on its own, so a part waits only for the reads it draws from (invariant 10). */
const readHome = (): HomeReads => {
  const roles = readRoles();
  return {
    home: roles.then(map => Promise.all([readRowsOf(map, sources.notices), readGoals(map)])).then(([waiting, pursuits]) => ({
      // Decisions wait for the decisions owner's answer shape (tool:see-my-decisions); until it is wired, the part is empty.
      summaries: [], waiting: waitingOf(waiting), pursuits })),
    // The person's own messages wait for an index on the table that keeps them (a read of it would sort every row).
    messages: Promise.resolve([]),
    // Only open work: Home never shows a finished job, so it reads only the job runs not yet finished.
    work: roles.then(map => readRowsOf(map, sources.open_work)).then(rows => ({ work: openWorkOf(rows, sources.open_work.status) as Job[] })),
  };
};

// The reads each of Home's parts draws from (invariant 10). A part not named here is one of the dashboard's cards by
// its id, which may draw from any read, so it waits for them all.
const EVERY_READ: HomeRead[] = ['home', 'messages', 'work'];
const PART_READS: Record<string, HomeRead[]> = {
  greeting: ['home'],
  numbers: ['home'],
  'needle-mover': ['home'],
  workstreams: ['work'],
  deciding: ['home'],
  waiting: ['home'],
  recent: ['home'],
  messages: ['home', 'messages'],
  pursuits: ['home'],
  suggestions: ['home', 'messages'],
};
// What a read Home's part does not draw from stands as, so homeDescription can build the part it does draw.
const unread = (): HomeAnswers => ({
  home: { summaries: [], waiting: [], pursuits: [] },
  messages: [],
  work: { work: [] },
});

/** The answers one part draws from: its own reads, every other one standing as unread. */
async function partAnswers(reads: HomeReads, card: string): Promise<HomeAnswers> {
  const needs = PART_READS[card] ?? EVERY_READ;
  const read = Object.fromEntries(await Promise.all(needs.map(async name => [name, await reads[name]] as const)));
  return { ...unread(), ...read };
}

/** Home's answers as its parts see them: the latest read, and the one way to read them all again. */
function homeAnswers(reload: () => void) {
  let answers: HomeAnswers | null = null;
  const listeners = new Set<() => void>();
  return {
    reload,
    get: () => answers,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set: (next: HomeAnswers) => { answers = next; for (const listener of listeners) listener(); },
  };
}
type HomeStore = ReturnType<typeof homeAnswers>;

// How each of Home's own parts draws from its answers; any other part is one of the dashboard's cards by its id.
const PARTS: Record<string, (description: DashboardProps, answers: HomeAnswers, store: HomeStore) => React.ReactNode> = {
  greeting: (description, _answers, store) => <DashboardHead {...description} headerAction={<HomeComposer reload={store.reload} />} />,
  numbers: description => <DashboardStats stats={description.stats} />,
};

/** One part of Home, drawn from Home's answers (nothing, when Home has no such part). */
function HomePart({ card, store }: { card: string; store: HomeStore }) {
  const answers = React.useSyncExternalStore(store.subscribe, store.get, store.get);
  if (!answers) return null;
  const description = homeDescription(answers.home, answers.messages, answers.work, store.reload, new Date());
  const own = PARTS[card];
  if (own) { const drawn = own(description, answers, store); return drawn ? <DashboardPiece>{drawn}</DashboardPiece> : null; }
  const found = description.cards.find(one => one.id === card);
  return found ? <DashboardPiece><DashboardCardView card={found} /></DashboardPiece> : null;
}

/** Draws one part of Home into `element` from Home's answers; the cleanup lets it go. */
function mountPart(element: HTMLElement, card: string, store: HomeStore): () => void {
  const root = createRoot(element);
  root.render(<HomePart card={card} store={store} />);
  return () => root.unmount();
}

// Every part of Home on the page draws from one read (invariant 6): the first part to open reads, the rest share
// that answer for a short while, and an answer given in any part reads them all again together.
const SHARED_FOR_MS = 15_000;
let shared: { at: number; reads: HomeReads } | null = null;
const readers = new Set<() => void>();
function sharedRead() {
  if (!shared || Date.now() - shared.at > SHARED_FOR_MS) {
    const reads = readHome();
    const kept = { at: Date.now(), reads };
    shared = kept;
    // A failed read is asked again by the next part that opens; the reads that answered stay shared meanwhile.
    for (const read of Object.values(reads)) (read as Promise<unknown>).catch(() => { if (shared === kept) shared = null; });
  }
  return shared;
}
const readAllAgain = () => { shared = null; for (const again of [...readers]) again(); };
// A part drawn from a copy kept on this computer reads again when the Worker's answer differs (ScreenState); the
// shared read is let go first, so that read gets the Worker's answers instead of the copies it shared.
onKeptAnswerReplaced(() => { shared = null; });

/** Reads Home's answers into `host` with the shared screen states, handing each read to `draw`. */
function readHomeInto(host: HTMLElement, card: string, draw: (store: HomeStore) => void) {
  const store = homeAnswers(readAllAgain);
  let drawn = false;
  const screen = loadScreen(host, {
    loading: { label: words.loading, layout: 'rows' },
    read: () => partAnswers(sharedRead().reads, card),
    failed: refusal(words.failed),
    clear: () => { drawn = false; release?.(); },
    draw: answers => {
      store.set(answers);
      if (!drawn) { drawn = true; draw(store); }
    },
  });
  const again = () => void screen.reload();
  readers.add(again);
  let release: (() => void) | null = null;
  return { store, setRelease: (next: () => void) => { release = next; }, dispose: () => { readers.delete(again); screen.dispose(); } };
}

/** Home itself drawn bare: Home is made of its parts (its screen row's arrangement, screen-own-arrangement.ts), which
 *  every host draws, inside itself too; only an arrangement holding Home twice inside itself reaches here, and it shows
 *  Home's greeting, a real part of Home. */
export function mountHomeScreen(element: HTMLElement): () => void {
  return mountHomeCard(element, { surfaceInput: { card: 'greeting' } });
}

/** One part of Home on its own (in a pane, or anywhere a screen opens): `surfaceInput.card` names which. */
export function mountHomeCard(element: HTMLElement, { surfaceInput }: ScreenProps = {}): () => void {
  const host = document.createElement('div');
  host.className = 'trillion-home-part';
  // A part of Home draws at its own height, so the pane holding it is as tall as the part (split-arranger.css).
  host.dataset.fitsContent = '';
  element.replaceChildren(host);
  let release: (() => void) | null = null;
  const card = String(surfaceInput?.card ?? '');
  const reading = readHomeInto(host, card, store => { release = mountPart(host, card, store); });
  reading.setRelease(() => { release?.(); release = null; });
  return () => { reading.dispose(); release?.(); element.replaceChildren(); };
}
