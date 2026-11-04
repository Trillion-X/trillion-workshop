// src/pursuit-consolidate.mjs
//
// Purpose: keeps one person's pursuits consolidated after each awareness reading (src/awareness.mjs): duplicates are
// merged, related pursuits are set under a parent, and a short umbrella pursuit is made when no current pursuit can
// hold them. The model proposes; checkPlan checks every proposal against the pursuits as they stand, and only what
// passes is applied, through the owners that already write pursuits: mergePursuit (src/pursuit-rooms.mjs),
// setRecordScope (src/record-scope.mjs) and recordPursuits (src/engine.mjs).
//
// Non-Negotiable Invariants:
//   1. Every limit, word and sentence used here is a row of src/awareness.json `consolidate`; nothing here names one.
//   2. Nothing is applied until checkPlan has passed it. It drops an unknown id, an id that is not current (ended or
//      archived), a self-merge, a merge where both pursuits have a shared place, a change that would make a cycle, a
//      pursuit set under a second parent, an umbrella whose title is taken (current or ended) or that holds fewer than
//      umbrella_children top-level pursuits, and anything past max_changes_per_run. Each dropped item is returned with
//      its reason.
//   3. A pursuit that already sits under a parent is never moved: it is never merged away and never set under another.
//      A pair where one side was recorded by the person (found_by is not the reading) and the titles differ is set under
//      the other instead of merged, so the person's own record stays whole.
//   4. Nothing is deleted. A merge ends the duplicate through mergePursuit, which moves its links; a nest moves nothing.
//   5. At most one model call per every_hours per person (retry_hours after a run that left the top level over the
//      limit, which is never read back as consolidated). A run that asked the model is counted even when the answer
//      failed, so a broken model is not asked on every reading; a run no AI answered is not counted.
//   6. It never throws: a failure is returned as the run's reason and kept as the last run, and the reading goes on.
//
import awarenessSettings from './awareness.json' with { type: 'json' };

const HOUR = 3_600_000;
const list = value => (Array.isArray(value) ? value : []);
const text = (value, max = 600) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const fill = (line, values) => line.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
// A title read the way the engine makes a pursuit's id from it (src/engine.mjs recordPursuits), so the same title is the same pursuit.
const slug = title => String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const idOf = title => `pursuit:${slug(title)}`;
const forModel = item => ({
  id: item.id, title: item.title ?? '', now: text(item.now, 300), after: text(item.after, 300),
  parents: list(item.parents), children: list(item.children), space_id: item.space_id ?? null,
  status: item.status ?? 'active', found_by: item.found_by ?? null,
  // A shared place taken in as a pursuit has no words of its own; what the place is and who is in it are what the
  // model can place it by.
  ...(item.from_room ? { from_room: true } : {}),
  ...(item.label || item.people_count || item.items ? { room: { label: item.label ?? null, people: item.people_count ?? 1, items: item.items ?? 0 } } : {}),
});

/** The top-level pursuits: the ones not set under any other. */
export const topLevelOf = pursuits => pursuits.filter(item => !list(item.parents).length);

/** Whether the last run left more top-level pursuits than top_level_at_most: its tidy is not finished. */
export const unfinishedRun = (last, settings = awarenessSettings.consolidate) =>
  last?.reason === 'tidied' && Number.isFinite(last.top_level_left) && last.top_level_left > settings.top_level_at_most;

/**
 * Whether a run is due. Never within every_hours of the last run (retry_hours when the last run left the top level over
 * the limit); otherwise only when there are more current pursuits than min_pursuits or more top-level ones than
 * top_level_at_most.
 */
export function consolidationDue({ pursuits, settings = awarenessSettings.consolidate, last_run_at = null, unfinished = false, now = Date.now() }) {
  const hours = unfinished ? settings.retry_hours ?? settings.every_hours : settings.every_hours;
  if (last_run_at && now - Date.parse(last_run_at) < hours * HOUR) return { due: false, reason: 'throttled' };
  if (pursuits.length > settings.min_pursuits || topLevelOf(pursuits).length > settings.top_level_at_most) return { due: true, reason: 'due' };
  return { due: false, reason: 'tidy' };
}

/** The system words the model is given: its instructions with the limits filled in, then the JSON shape it returns. */
export function consolidationPrompt(settings = awarenessSettings.consolidate) {
  const shape = {
    merge: [{ from: 'id of the duplicate', into: 'id of the pursuit kept', why: 'short reason' }],
    nest: [{ child: 'id of the pursuit set under the other', parent: 'id of the pursuit it is set under', why: 'short reason' }],
    new_parents: [{ title: 'a few words, to the person as you', now: 'where it stands today, to the person as you', after: 'where it should get to, to the person as you', why: 'short reason', children: ['ids of top-level pursuits'] }],
  };
  const limits = { top_level_at_most: settings.top_level_at_most, max_changes_per_run: settings.max_changes_per_run };
  return `${fill(settings.instructions, limits)} The JSON shape:\n${JSON.stringify(shape)}`;
}

/** The JSON object in a model's reply: chat-completions text, or the reply itself when it already is an object. */
export function replyObject(reply) {
  const value = reply?.choices?.[0]?.message?.content ?? reply?.response ?? (typeof reply?.content === 'string' ? reply.content : reply);
  if (value && typeof value === 'object') return value;
  const said = String(value ?? '');
  const start = said.indexOf('{');
  const end = said.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The consolidation reply had no JSON.');
  return JSON.parse(said.slice(start, end + 1));
}

/**
 * The model's reply checked against the pursuits as they stand. `pursuits` are the current ones with their parents
 * (src/record-scope.mjs scopePursuitTree); `taken` is the id of every pursuit kept, ended ones included. Pure: nothing
 * is written. Returns the operations that pass, in the order they are applied (merges, nests, then umbrellas), and every
 * item dropped with its reason. Each change is tried on a copy of the pursuits and kept only when the copy has no cycle.
 */
export function checkPlan(reply, { pursuits, taken = [], settings = awarenessSettings.consolidate, foundBy = awarenessSettings.recording.found_by } = {}) {
  const dropped = [];
  const ops = [];
  const takenIds = new Set(taken);
  const known = new Set(pursuits.map(item => item.id));
  let state = new Map(pursuits.map(item => [item.id, {
    id: item.id, title: item.title ?? '', space_id: item.space_id ?? null, found_by: item.found_by ?? null,
    parents: new Set(list(item.parents).filter(id => known.has(id))),
  }]));
  let changes = 0;
  const drop = (kind, ref, reason) => { dropped.push({ kind, ref, reason }); return false; };
  const missing = id => (takenIds.has(id) ? 'not_current' : 'unknown');
  const copy = map => new Map([...map].map(([id, node]) => [id, { ...node, parents: new Set(node.parents) }]));
  const cyclic = map => [...map.values()].some(start => {
    const seen = new Set();
    const climb = [...start.parents];
    while (climb.length) {
      const id = climb.pop();
      if (id === start.id) return true;
      if (seen.has(id) || !map.has(id)) continue;
      seen.add(id);
      climb.push(...map.get(id).parents);
    }
    return false;
  });
  // Tries one change on a copy: refused with a reason, or kept and counted against the limit.
  const attempt = (kind, ref, cost, edit) => {
    if (changes + cost > settings.max_changes_per_run) return drop(kind, ref, 'over_limit');
    const working = copy(state);
    const reason = edit(working);
    if (reason) return drop(kind, ref, reason);
    if (cyclic(working)) return drop(kind, ref, 'cycle');
    state = working;
    changes += cost;
    return true;
  };
  const nestEdit = (child, parent) => working => {
    if (!working.has(child)) return missing(child);
    if (!working.has(parent)) return missing(parent);
    if (child === parent) return 'self';
    if (working.get(child).parents.size) return 'under_parent';
    working.get(child).parents.add(parent);
    return null;
  };
  const mergeEdit = (from, into) => working => {
    if (!working.has(from)) return missing(from);
    if (!working.has(into)) return missing(into);
    if (from === into) return 'self';
    if (working.get(from).space_id && working.get(into).space_id) return 'both_rooms';
    if (working.get(from).parents.size) return 'under_parent';
    for (const node of working.values()) if (node.parents.delete(from) && node.id !== into) node.parents.add(into);
    working.delete(from);
    return null;
  };
  const umbrellaEdit = (id, title, children) => working => {
    if (takenIds.has(id) || working.has(id) || [...working.values()].some(node => slug(node.title) === slug(title))) return 'title_taken';
    for (const child of children) if (!working.has(child)) return missing(child);
    if (children.some(child => working.get(child).parents.size)) return 'under_parent';
    working.set(id, { id, title, space_id: null, found_by: foundBy, parents: new Set() });
    for (const child of children) working.get(child).parents.add(id);
    return null;
  };

  for (const item of list(reply?.merge)) {
    const from = text(item?.from, 200);
    const into = text(item?.into, 200);
    if (!from || !into) { drop('merge', from || into, 'missing_id'); continue; }
    const a = state.get(from);
    const b = state.get(into);
    // The person's own record is not merged into a pursuit with another title: it is set under that pursuit instead.
    if (a && b && (a.found_by !== foundBy || b.found_by !== foundBy) && slug(a.title) !== slug(b.title)) {
      if (attempt('nest', from, 1, nestEdit(from, into))) ops.push({ kind: 'nest', child: from, parent: into, why: text(item?.why) });
    } else if (attempt('merge', from, 1, mergeEdit(from, into))) {
      ops.push({ kind: 'merge', from, into, why: text(item?.why) });
    }
  }
  for (const item of list(reply?.nest)) {
    const child = text(item?.child, 200);
    const parent = text(item?.parent, 200);
    if (!child || !parent) { drop('nest', child || parent, 'missing_id'); continue; }
    if (attempt('nest', child, 1, nestEdit(child, parent))) ops.push({ kind: 'nest', child, parent, why: text(item?.why) });
  }
  for (const item of list(reply?.new_parents)) {
    const title = text(item?.title, 160);
    const now = text(item?.now);
    const after = text(item?.after);
    const children = [...new Set(list(item?.children).map(id => text(id, 200)).filter(Boolean))];
    if (!slug(title) || !now || !after) { drop('new_parent', title || '(untitled)', 'missing_words'); continue; }
    if (children.length < settings.umbrella_children) { drop('new_parent', title, 'too_few_children'); continue; }
    const id = idOf(title);
    if (attempt('new_parent', title, 1 + children.length, umbrellaEdit(id, title, children))) {
      ops.push({ kind: 'new_parent', id, title, now, after, why: text(item?.why), children });
    }
  }
  return { ops, dropped };
}

/**
 * The consolidation run, over the owners that write pursuits (src/person-store.mjs wires them):
 *   state     { read(), write(value) }: the last run kept, { last_run_at, at, said, reason }
 *   pursuits  async () → the current pursuits with parents and children (scopePursuitTree of engine.pursuits())
 *   taken     async () → the id of every pursuit kept, ended ones included
 *   ask       async (system, user, { max_tokens }) → { reply, model }, the awareness model road; it throws
 *             no_chosen_ai when no AI answers
 *   merge(from, into), nest(child, parent), recordNew(pursuit): the owners; the new pursuit is recorded as found by
 *             the reading and grouped, so no reading ends it
 * runDue() → { ran, reason, said, dropped, refused } and never throws; last() → what the last run did, as sentences.
 */
export function pursuitConsolidator({ settings = awarenessSettings.consolidate, foundBy = awarenessSettings.recording.found_by, state, pursuits, taken, ask, merge, nest, recordNew, now = () => new Date() }) {
  const { words } = settings;
  const kept = () => state.read() ?? {};

  async function tidy() {
    const at = now().toISOString();
    const current = await pursuits();
    const due = consolidationDue({ pursuits: current, settings, last_run_at: kept().last_run_at ?? null, unfinished: unfinishedRun(kept(), settings), now: now().getTime() });
    if (!due.due) return { ran: false, reason: due.reason };
    const considered = current.slice(0, settings.max_pursuits);
    const titles = new Map(considered.map(item => [item.id, item.title]));
    let reply;
    try {
      ({ reply } = await ask(consolidationPrompt(settings), JSON.stringify({
        top_level_count: topLevelOf(current).length, top_level_at_most: settings.top_level_at_most,
        max_changes: settings.max_changes_per_run, pursuits: considered.map(forModel),
      }), { max_tokens: settings.max_tokens }));
    } catch (error) {
      if (error?.no_chosen_ai) return { ran: false, reason: 'no_ai' };
      state.write({ last_run_at: at, at, said: [], reason: 'failed' });
      return { ran: true, reason: 'failed' };
    }
    let plan;
    try {
      plan = checkPlan(replyObject(reply), { pursuits: considered, taken: await taken(), settings, foundBy });
    } catch {
      state.write({ last_run_at: at, at, said: [], reason: 'failed' });
      return { ran: true, reason: 'failed' };
    }
    const said = [];
    let refused = 0;
    for (const op of plan.ops) {
      try {
        if (op.kind === 'merge') {
          await merge(op.from, op.into);
          said.push(fill(words.merged, { from: titles.get(op.from), into: titles.get(op.into) }));
        } else if (op.kind === 'nest') {
          await nest(op.child, op.parent);
          said.push(fill(words.nested, { child: titles.get(op.child), parent: titles.get(op.parent) }));
        } else {
          await recordNew({ title: op.title, now: op.now, after: op.after, status: 'active', found_by: foundBy, found_at: at, grouped: true });
          const placed = [];
          for (const child of op.children) {
            try { await nest(child, op.id); placed.push(titles.get(child)); } catch { refused += 1; }
          }
          if (placed.length) said.push(fill(words.umbrella, { title: op.title, children: placed.join(', ') }));
        }
      } catch { refused += 1; }
    }
    // How many stay at the top level after the changes, read back from the owners, so the next reading knows whether
    // this tidy finished.
    const top_level_left = topLevelOf(await pursuits()).length;
    state.write({ last_run_at: at, at, said, reason: 'tidied', top_level_left });
    return { ran: true, reason: 'tidied', said, dropped: plan.dropped, refused, top_level_left };
  }

  return {
    async runDue() {
      try { return await tidy(); } catch { return { ran: false, reason: 'failed' }; }
    },
    // What the last run did, as the sentences the person's AI reads back (read_awareness).
    last() {
      const value = kept();
      if (!value.at) return null;
      if (value.reason !== 'tidied') return { at: value.at, said: [words[value.reason] ?? words.failed] };
      // A run that left the top level over the limit never reads as consolidated.
      if (unfinishedRun(value, settings)) return { at: value.at, said: [...(value.said ?? []), fill(words.unfinished, { count: value.top_level_left, at_most: settings.top_level_at_most })] };
      return { at: value.at, said: value.said?.length ? value.said : [words.none] };
    },
  };
}
