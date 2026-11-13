// src/workspace/job-run.tsx
//
// PURPOSE
//   One job as the person watches it, the same wherever the job appears: under the message box and Home's box right
//   after Send (the work that message started), and opened on its own (from a notification's See AI work or the AI
//   work screen). It reads GET /work/api/job-run (src/person-store.mjs jobRun: the work, every part handed on from it,
//   every call kept for it, oldest first, and who did it) and draws it with the shared run view (parts/ui/show/run-view):
//   the work's state as a tinted tile, the faces of whoever is on it, one glance row per step with what it read or
//   changed, the seconds it took since the step before, and a row while someone holds it. Opened on its own, the run
//   is the left column with a box at its foot for telling whoever has the job more, and the AI on it sits beside it
//   on the board (board-of.tsx BoardOf, one board per job): the AI, what it does, the tools it called, the other AIs
//   it asked and its skills, each a card whose state follows the job, with the board's pen, notes and shapes around. It reads itself again whenever the person's store changes, so steps arrive
//   while the person watches.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only what the store answered: every step is a kept call. An older recorded association stays visible with
//      its missing source basis; a current card or shared app cannot establish its caller or link to this job.
//      The tool graph includes only calls with a captured work link and a caller-named card matching this job's
//      assigned AI. A returned call is separate from the job's outcome; a message with no work yet shows as waiting.
//   2. Words, icons and tones are DATA (job-run.json); nothing here names a tool, an app or a kind of job.
//   3. The person takes, finishes, follows up and withdraws waiting work through the same guarded owners an AI uses
//      (/work/api/job-run/take, /finish, /follow-up and /withdraw-waiting). Withdrawal is never a running-work cancellation.
//   4. Reference anatomy: Browserbase's run (a step list with each call's kind and time) and AirOps' workflow screen
//      (the conversation and its box on the left, the agent's graph on a canvas on the right).

import React from 'react';
import { RunView } from '../../parts/ui/show/run-view';
import { ListingCard, type Listing, type ListingChip } from '../../parts/ui/show/listing-card';
import { Container, Text } from '../../parts/ui';
import { Composer, type ComposerDraft } from '../../parts/ui/show/composer';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { relativeWhen } from '../../parts/ui/show/relative-time/relative-time';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { BoardOf } from './board-of';
import { graphAsBoardSource } from '../graph-board-source.mjs';
import { postJson, readJson } from './api';
import { reasonOf, refusal } from './failure';
import { AI_WORK, onStoreChange } from './store-changes';
import words from './job-run.json';
import { titleOf } from '../work-title.mjs';
import { activityAssociationLabel, activityEvidence, dispatchLabel } from './activity-trace-view.mjs';

/** A card of the AI's graph: an actor, a tool it called or a skill, with its state key (job-run.json graph.looks). */
type GraphStep = { id: string; title: string; icon?: string; caption?: string; state?: string; details?: { label: string; text: string }[]; output?: unknown; group?: string };
type GraphEdge = { from: string; to: string; label?: string };
type StateLook = { label: string; tone?: string; pulse?: boolean };

/** What a run is read by: the message the person sent, or one job. */
export type RunRef = { message: string } | { handoff: string };

type Job = { handoff_id: string; state: string; revision: number; withdrawal?: { by: string; reason: string; at: string } | null; said: string | null; job: string; case_id: string | null; parent_handoff_id?: string | null; handed_at: string; taken_by: string | null; to_agent?: string | null; hold_until: string | null; finished_at: string | null; result: unknown; summary: string | null; in_the_way: string | null };
type Step = { seq: number; at: string; app: string | null; tool: string; label: string; title: string | null; item: string | null; uses?: string[]; for?: string[]; for_basis?: Record<string, string>; reads?: boolean; agent: string | null; agent_name?: string | null; model?: string | null; identity_snapshot?: { agent_id?: string | null; agent_name?: string | null; model?: string | null; conversation_id?: string | null; basis?: string; selection_basis?: string }; identity_basis?: string; ok: boolean; reason: string | null };
type Actor = { id: string; name: string; kind: string; app: string | null; model: string | null; description?: string | null; skills?: string[] };
type Run = { jobs: Job[]; steps: Step[]; actors: Actor[]; apps: Record<string, { picture: string | null }>; progress?: string | null };

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, key) => values[key] ?? whole);
const query = (ref: RunRef) => new URLSearchParams('message' in ref ? { message: ref.message } : { handoff: ref.handoff }).toString();
const PERSON_CARD = 'you';
// Where each of the run's buttons is sent: the person takes, finishes and follows up work as every AI does.
const ROADS = { take: '/work/api/job-run/take', finish: '/work/api/job-run/finish', 'withdraw-waiting': '/work/api/job-run/withdraw-waiting' };
const FOLLOW_UP = '/work/api/job-run/follow-up';
/** The exact request each displayed action sends; withdrawal uses the revision this screen read. */
export function jobActionRequest(run: Run, id: string, action: string) {
  const path = ROADS[action as keyof typeof ROADS];
  const job = run.jobs.find(item => item.handoff_id === id);
  if (!path || !job) return null;
  if (action === 'withdraw-waiting' && (job.state !== 'open' || !Number.isInteger(job.revision) || job.revision < 1)) return null;
  return { path, input: { handoff_id: id, ...(action === 'withdraw-waiting' ? { revision: job.revision } : {}) } };
}

// The last part of an id or a path ("/Notes/plan.md" is "plan.md"), as a chip names a thing it has no title for.
const lastPart = (id: string) => id.split(/[/:]/).filter(Boolean).pop()?.slice(0, 40) ?? id;

/** Which of job-run.json's states the work is in: the first that holds, in the file's order. */
function stateOf(jobs: Job[], now: number): keyof typeof words.states {
  if (jobs[0]?.withdrawal) return 'withdrawn';
  if (jobs.some(job => job.in_the_way && job.state !== 'finished')) return 'stuck';
  if (jobs.some(job => job.state === 'taken' && job.hold_until && Date.parse(job.hold_until) > now)) return 'working';
  if (jobs.length && jobs.every(job => job.state === 'finished')) return 'done';
  return 'waiting';
}

/** How a step's tile reads: failed, else whether its tool only reads or changes things, else plainly done. */
const stepLook = (step: Step) => (!step.ok ? words.step.failed : step.reads === true ? words.step.read : step.reads === false ? words.step.changed : words.step.ok);

/** A related case, an app match or a legacy `for` link cannot establish that a call served this job. Keep that
 *  history visible, but only descriptor-captured links to the actual handoffs qualify for the tool graph. */
function workAssociation(run: Run, step: Step) {
  const handoffs = new Set(run.jobs.map(job => job.handoff_id));
  const refs = [...new Set((step.for ?? []).filter(id => handoffs.has(id)))];
  const captured = refs.some(id => Object.hasOwn(step.for_basis ?? {}, id) && ['explicit_input', 'tool_result'].includes(step.for_basis![id]));
  const labels = [...new Set(refs.map(id => activityAssociationLabel(step, id)))];
  return { captured, refs, label: labels.join(' · ') || words.related_association };
}

/** The run as glance DATA for the shared run view. */
export function runListings(run: Run, now = Date.now()) {
  const root = run.jobs[0];
  const state = words.states[stateOf(run.jobs, now)];
  const pictureOf = (app: string | null) => (app ? run.apps?.[app]?.picture ?? null : null);
  const face = (actor: Actor): ListingChip => ({ label: actor.name, picture: actor.kind === 'person' ? null : pictureOf(actor.app) });
  const held = run.jobs.filter(job => job.state === 'taken' && job.hold_until && Date.parse(job.hold_until) > now);
  const heldActors = [...new Map(held.flatMap(job => {
    const actor = run.actors.find(item => item.id === job.taken_by);
    return actor ? [[actor.id, actor] as const] : [];
  })).values()];
  const assigned = new Set(run.jobs.flatMap(job => [job.taken_by, job.to_agent]).filter(Boolean));
  const headerActors = heldActors.length ? heldActors : run.actors.filter(actor => assigned.has(actor.id));
  const actions = !root ? [] : stateOf(run.jobs, now) === 'waiting' ? [{ id: 'take', label: words.actions.take, primary: true }]
    : held.some(job => job.handoff_id === root.handoff_id && job.taken_by === PERSON_CARD) ? [{ id: 'finish', label: words.actions.finish, primary: true }] : [];
  if (root?.state === 'open' && Number.isInteger(root.revision) && root.revision > 0) actions.push({ id: 'withdraw-waiting', label: words.actions['withdraw-waiting'], primary: false });
  const header: Listing = {
    id: root?.handoff_id ?? 'message',
    title: root ? titleOf(root) : words.untitled,
    icon: state.icon, tone: state.tone, mark: { label: state.label, tone: state.tone },
    when: root ? relativeWhen(root.handed_at, now) : undefined,
    text: root?.in_the_way ?? root?.summary ?? undefined,
    chips: [
      ...headerActors.map(face),
      // How many of its parts finished, measured by the store from the parts themselves (src/work-progress.mjs).
      ...(run.progress ? [{ label: run.progress, icon: 'CirclePercent' }] : []),
      ...(root?.case_id ? [{ label: words.decision_chip, kind: 'decision', value: root.case_id, href: `/decisions/${encodeURIComponent(root.case_id)}` }] : []),
    ],
    actions,
  };
  // What a step made or read, as chips: the thing it made by its title, each thing it used by the last part of its id,
  // the first few shown and the rest counted in one more chip.
  const readChips = (step: Step): ListingChip[] => {
    const read = [
      ...(step.item ? [{ label: step.title ?? lastPart(step.item), value: step.item }] : []),
      ...(step.uses ?? []).filter(id => id !== step.item).map(id => ({ label: lastPart(id), value: id })),
    ];
    const shown = read.slice(0, words.read_shown);
    return read.length > shown.length ? [...shown, { label: fill(words.more, { count: String(read.length - shown.length) }) }] : shown;
  };
  const steps: Listing[] = run.steps.map((step, index) => {
    const association = workAssociation(run, step);
    const identity = activityEvidence(step);
    const look = !step.ok || association.captured && identity.actor_id ? stepLook(step) : words.step.linked;
    const actor = identity.actor_id ? run.actors.find(item => item.id === identity.actor_id) : null;
    const before = index ? Date.parse(run.steps[index - 1].at) : root ? Date.parse(root.handed_at) : NaN;
    const gap = Math.round((Date.parse(step.at) - before) / 1000);
    return {
      id: String(step.seq), icon: look.icon, tone: look.tone, title: step.label,
      when: relativeWhen(step.at, now), text: step.reason ?? undefined,
      ...(gap >= 1 ? { value: String(gap), unit: words.gap_unit } : {}),
      chips: [{ label: association.label }, { label: identity.actor_id ? fill(words.named_caller, { name: identity.actor }) : identity.actor, picture: actor ? pictureOf(actor.app) : null }, ...readChips(step)],
    };
  });
  const details: Record<string, Listing> = Object.fromEntries(run.steps.map(step => {
    const association = workAssociation(run, step);
    const identity = activityEvidence(step);
    const facts = [
      { ...words.detail.association, value: association.label },
      ...association.refs.map(id => ({ ...words.detail.work, value: `${id} · ${activityAssociationLabel(step, id)}` })),
      { ...words.detail.actor, value: identity.actor },
      { ...words.detail.actor_basis, value: identity.actor_basis },
      !identity.actor_id && step.agent ? { ...words.detail.recorded_agent, value: step.agent } : null,
      { ...words.detail.recorder, value: identity.recorder },
      { ...words.detail.call_result, value: dispatchLabel(step.ok ? 'returned' : 'failed') },
      { ...words.detail.tool, value: step.tool },
      { ...words.detail.at, value: new Date(step.at).toLocaleString() },
    ].filter((fact): fact is { label: string; icon: string; value: string } => Boolean(fact));
    const look = !step.ok || association.captured && identity.actor_id ? stepLook(step) : words.step.linked;
    return [String(step.seq), { id: `detail:${step.seq}`, icon: look.icon, tone: look.tone, title: step.label, text: step.reason ?? step.title ?? undefined, facts }];
  }));
  const working: Listing[] = held.flatMap(job => {
    const actor = run.actors.find(item => item.id === job.taken_by);
    if (!actor) return [];
    return [{ id: job.handoff_id, icon: words.working.icon, tone: words.working.tone,
      title: fill(words.working.title, { name: actor.name }),
      text: job.handoff_id === root?.handoff_id ? undefined : titleOf(job),
      chips: [face(actor)],
      actions: actor.id === PERSON_CARD && job.handoff_id !== root?.handoff_id ? [{ id: 'finish', label: words.actions.finish, primary: true }] : [],
    }];
  });
  return { header, steps, details, working };
}

/** Where a job stands, as the graph's state keys. */
const jobState = (job: Job | undefined, now: number) => (!job ? 'waiting' : job.withdrawal ? 'withdrawn' : job.state === 'finished' ? 'done' : job.in_the_way ? 'failed' : job.state === 'taken' && job.hold_until && Date.parse(job.hold_until) > now ? 'working' : 'waiting');

/** The assigned AI as a graph: its calls whose exact work association and caller selection were captured, the
 *  recorded parts handed on, and its listed skills. Tool nodes show call results, never a verdict on the job. */
export function agentGraph(run: Run, now = Date.now()): { steps: GraphStep[]; edges: GraphEdge[]; looks: Record<string, StateLook> } {
  const g = words.graph;
  const root = run.jobs[0];
  const ais = run.actors.filter(actor => actor.kind !== 'person');
  const main = ais.find(actor => actor.id === (root?.taken_by ?? root?.to_agent));
  const steps: GraphStep[] = [];
  const edges: GraphEdge[] = [];
  const agentId = `agent:${main?.id ?? 'waiting'}`;
  steps.push({
    id: agentId, title: main?.name ?? words.states.waiting.label, icon: g.agent_icon, caption: main?.model ?? main?.app ?? undefined, state: jobState(root, now),
    details: [main?.app ? { label: g.details.app, text: main.app } : null, main?.model ? { label: g.details.model, text: main.model } : null, { label: g.details.calls, text: g.calls_evidence }].filter((detail): detail is { label: string; text: string } => Boolean(detail)),
  });
  if (main?.description) {
    steps.push({ id: 'instructions', title: g.instructions.title, icon: g.instructions.icon, caption: main.description.slice(0, 80), state: 'part', details: [{ label: g.details.what, text: main.description }] });
    edges.push({ from: agentId, to: 'instructions' });
  }
  const group = (key: keyof typeof g.groups, members: GraphStep[]) => {
    if (!members.length) return;
    const id = `group:${key}`;
    steps.push({ id, title: g.groups[key].title, icon: g.groups[key].icon, caption: String(members.length), state: 'part' });
    edges.push({ from: agentId, to: id });
    for (const member of members) { steps.push({ ...member, group: g.groups[key].title }); edges.push({ from: id, to: member.id }); }
  };
  const byTool = new Map<string, Step[]>();
  for (const step of run.steps) {
    if (!main || !workAssociation(run, step).captured || activityEvidence(step).actor_id !== main.id) continue;
    byTool.set(step.tool, [...(byTool.get(step.tool) ?? []), step]);
  }
  group('tools', [...byTool].map(([tool, calls]) => {
    const last = calls[calls.length - 1];
    return {
      id: `tool:${tool}`, title: last.label, icon: stepLook({ ...last, ok: true }).icon,
      caption: calls.length > 1 ? fill(g.uses, { count: String(calls.length) }) : g.used_once,
      state: calls.some(call => !call.ok) ? 'failed' : 'returned',
      details: [{ label: words.detail.tool.label, text: tool }, { label: words.detail.association.label, text: workAssociation(run, last).label }, { label: words.detail.actor_basis.label, text: activityEvidence(last).actor_basis }, { label: g.details.last, text: new Date(last.at).toLocaleString() }, ...(last.reason ? [{ label: g.details.why, text: last.reason }] : [])],
    };
  }));
  group('helpers', run.jobs.slice(1).flatMap(job => {
    const actor = run.actors.find(item => item.id === (job.taken_by ?? job.to_agent));
    return [{ id: `part:${job.handoff_id}`, title: actor?.name ?? titleOf(job), icon: g.agent_icon, caption: titleOf(job), state: jobState(job, now), output: job.result ?? undefined }];
  }));
  group('skills', (main?.skills ?? []).map(skill => ({ id: `skill:${skill}`, title: skill, icon: g.groups.skills.icon, state: 'part' })));
  return { steps, edges, looks: g.looks as Record<string, StateLook> };
}

// A link an answer card may carry: an address inside this workspace, or a web page.
const safeHref = (href: unknown) => (typeof href === 'string' && (/^\/(?!\/)/.test(href) || /^https:\/\//.test(href)) ? href : undefined);
const textOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** The answer cards a finished job carries: finish_work's result.show, one glance card or a list of them (the shared
 *  Listing shape), kept to the fields a card draws and to links that stay inside the workspace or on the web. */
export function answerCards(jobs: Job[]): Listing[] {
  return jobs.flatMap(job => {
    const show = job.result && typeof job.result === 'object' ? (job.result as { show?: unknown }).show : undefined;
    const cards = Array.isArray(show) ? show : show ? [show] : [];
    return cards.flatMap((card, index): Listing[] => {
      if (!card || typeof card !== 'object') return [];
      const given = card as Record<string, unknown>;
      const title = textOf(given.title);
      if (!title) return [];
      const facts = Array.isArray(given.facts) ? given.facts.flatMap(fact => {
        const each = fact as Record<string, unknown>;
        const label = textOf(each?.label); const value = textOf(each?.value);
        return label && value ? [{ label, value, ...(textOf(each.icon) ? { icon: textOf(each.icon) } : {}) }] : [];
      }) : [];
      const chips = Array.isArray(given.chips) ? given.chips.flatMap((chip): ListingChip[] => {
        const each = chip as Record<string, unknown>;
        const label = textOf(each?.label);
        return label ? [{ label, ...(textOf(each.kind) ? { kind: textOf(each.kind) } : {}), ...(textOf(each.value) ? { value: textOf(each.value) } : {}), ...(safeHref(each.href) ? { href: safeHref(each.href) } : {}) }] : [];
      }) : [];
      return [{
        id: `${job.handoff_id}:${index}`, title,
        ...(textOf(given.text) ? { text: textOf(given.text) } : {}),
        ...(textOf(given.icon) ? { icon: textOf(given.icon) } : {}),
        ...(textOf(given.tone) ? { tone: textOf(given.tone) } : {}),
        ...(textOf(given.value) ? { value: textOf(given.value) } : {}),
        ...(textOf(given.unit) ? { unit: textOf(given.unit) } : {}),
        ...(facts.length ? { facts } : {}),
        ...(chips.length ? { chips } : {}),
      }];
    });
  });
}

/** One job read, reading itself again whenever the person's store changes. */
function useJobRun(runRef: RunRef) {
  const key = query(runRef);
  const loaded = useScreenLoad(`job-run:${key}`, {
    loading: { label: words.loading, layout: 'rows' },
    read: () => readJson<Run>(`/work/api/job-run?${key}`),
    failed: refusal(words.failed),
  });
  const { reload } = loaded;
  React.useEffect(() => onStoreChange(() => void reload(), AI_WORK), [reload]);
  return loaded;
}

/** The run's own column: the run view, the answer cards, and a line when a button was refused. */
function RunColumn({ run, reload }: { run: Run; reload: () => Promise<void> }) {
  const [failed, setFailed] = React.useState('');
  const onAction = React.useCallback(async (id: string, action: string) => {
    const request = jobActionRequest(run, id, action);
    if (!request) return;
    try { await postJson(request.path, request.input); setFailed(''); } catch (error) { setFailed(reasonOf(error)); }
    await reload();
  }, [reload, run.jobs]);
  const { header, steps, details, working } = runListings(run);
  const answers = answerCards(run.jobs);
  return (
    <Container layout="vertical" gap="xs" minWidth="0" data-slot="job-run">
      <RunView run={header} steps={steps} details={details} working={working} stepsLabel={words.steps_label} onAction={onAction} />
      {answers.map(card => <ListingCard key={card.id} listing={card} />)}
      {failed ? <Text variant="body-sm" color="error" role="alert">{failed}</Text> : null}
    </Container>
  );
}

/** One job, read and drawn. */
export function JobRun({ runRef }: { runRef: RunRef }) {
  const loaded = useJobRun(runRef);
  if (loaded.state) return <ScreenState state={loaded.state} />;
  return <RunColumn run={loaded.value} reload={loaded.reload} />;
}

/** The jobs sent from one box, newest first. */
export function JobRuns({ runs }: { runs: RunRef[] }) {
  if (!runs.length) return null;
  return (
    <Container layout="vertical" gap="md" minWidth="0" data-slot="job-runs">
      {runs.map(runRef => <JobRun key={query(runRef)} runRef={runRef} />)}
    </Container>
  );
}

/** One job opened on its own: the run with a box for telling whoever has it more, beside the graph of the AI on it. */
export function JobRunScreen({ runRef }: { runRef: RunRef }) {
  const loaded = useJobRun(runRef);
  if (loaded.state) return <ScreenState state={loaded.state} />;
  const run = loaded.value;
  const root = run.jobs[0];
  const holder = root ? run.actors.find(actor => actor.id === (root.taken_by ?? root.to_agent)) : undefined;
  const followUp = async (draft: ComposerDraft) => {
    if (!root) throw new Error(words.failed);
    await postJson(FOLLOW_UP, { handoff_id: root.handoff_id, words: draft.text });
    await loaded.reload();
    return holder && holder.id !== PERSON_CARD ? fill(words.follow_up.sent, { name: holder.name }) : words.follow_up.sent_anyone;
  };
  const graph = agentGraph(run);
  return (
    <Container layout="horizontal" height="full" minHeight="0" minWidth="0" gap="none" data-slot="job-run-screen" className="flex-col md:flex-row">
      <Container layout="vertical" minHeight="0" minWidth="0" gap="sm" padding="md" className="md:w-[26rem] md:shrink-0 md:border-r md:border-[var(--glass-border)]">
        <Container layout="vertical" flex={1} minHeight="0" className="overflow-y-auto">
          <RunColumn run={run} reload={loaded.reload} />
        </Container>
        {root ? <Composer onSend={followUp} words={{ label: words.follow_up.label, placeholder: words.follow_up.placeholder, send: words.follow_up.send, busy: words.follow_up.busy }} /> : null}
      </Container>
      <Container layout="vertical" flex={1} minHeight="0" minWidth="0" aria-label={words.graph.label} data-slot="job-run-graph" className="min-h-[24rem]">
        <BoardOf boardId={`job:${root?.handoff_id ?? 'message'}`} title={words.graph.label} source={graphAsBoardSource(`job:${root?.handoff_id ?? 'message'}`, graph, graph.looks)} />
      </Container>
    </Container>
  );
}

/** The job screen: one job, opened on a handoff or on the message that started it. */
export function mountJobRunScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  const input = props.surfaceInput ?? {};
  const runRef: RunRef = typeof input.message === 'string' ? { message: input.message } : { handoff: String(input.handoff ?? '') };
  return mountReactSurface(element, <JobRunScreen runRef={runRef} />);
}
