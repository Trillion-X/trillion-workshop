// harness/quiet-open-source-work.mjs
//
// Purpose
//   A source that got quieter (its row's default_rule now skips some events and batches the rest,
//   records/workshop-event-source-records.json) only changes what arrives from then on. Work it already handed to the
//   person's AIs keeps waiting, one job per event. This one-time pass puts that waiting work through the source's
//   current rule: a job the skip tests now leave out is closed as skipped, and the rest of each kind of event is folded
//   into one summary job, worded like the batched default (records/starting-rules.json each_connected_event.batch_job),
//   with each original closed saying which summary holds it.
//   Pure: foldPlan(open work, source rows, starting rules) → what to close and what to fold. Runner: runFold.
//   Standalone: node harness/quiet-open-source-work.mjs --once [--dry-run] [--origin <url>] [--keychain-item <name>]
//
// Non-negotiable invariants
//   1. Nothing here names a source, an event or a field: which work belongs to a source (arrived.source is its label
//      and arrived.event one of its events), what is left out and how often it is batched all come from the rows.
//   2. Only work handed to no agent by name and not held by anyone now is touched.
//   3. Running it again changes nothing: the summary job's request_key is made from the jobs it folds, and a job
//      already closed is no longer waiting.
//
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { skippedBy } from '../src/events.mjs';
import { accountCaller } from './take-open-work.mjs';
import { requireAccountKey } from './account-key.mjs';

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

/**
 * open:    the account's work rows (handoff_id, state, to_agent, input.arrived, handed_at, hold_until)
 * sources: event source rows;  shape: starting-rules.json each_connected_event;  now: ISO time
 * → { skip: [{ handoff_id, source }], fold: [{ source, event, ids, job, arrived, request_key }] }
 */
export function foldPlan({ open, sources, shape, now }) {
  const skip = [];
  const groups = new Map();
  const quiet = sources.filter(source => source.default_rule);
  for (const item of open) {
    const arrived = item.input?.arrived;
    if (item.to_agent || !arrived || (item.state === 'taken' && !(item.hold_until && item.hold_until <= now)) || !['open', 'taken'].includes(item.state)) continue;
    const source = quiet.find(row => row.label === arrived.source && row.events.some(event => event.name === arrived.event));
    if (!source) continue;
    if (skippedBy(source.default_rule.skip, arrived)) { skip.push({ handoff_id: item.handoff_id, source }); continue; }
    if (!source.default_rule.batch) continue;
    const key = `${source.id}\u0000${arrived.event}`;
    if (!groups.has(key)) groups.set(key, { source, event: arrived.event, items: [] });
    groups.get(key).items.push(item);
  }
  const fold = [...groups.values()].filter(group => group.items.length > 1).map(({ source, event, items }) => {
    const ordered = [...items].sort((a, b) => String(a.handed_at).localeCompare(String(b.handed_at)));
    const hours = String(Math.round(source.default_rule.batch.every_minutes / 60));
    const values = { source_id: source.id, source_label: source.label, event, hours };
    return {
      source, event, ids: ordered.map(item => item.handoff_id),
      job: fill(shape.batch_job, values),
      arrived: { source: source.label, count: ordered.length, first_at: ordered[0].handed_at, last_at: ordered.at(-1).handed_at, events: ordered.map(item => item.input.arrived) },
      request_key: `quiet-open-source-work:${source.id}:${event}:${ordered.map(item => item.handoff_id).join(',')}`.slice(0, 500),
    };
  });
  return { skip, fold };
}

// The work tree comes a page at a time (a page ends at its job count or its size in bytes, and says where the next begins
// in next_before): every page is followed while the cursor still walks open work; once it names finished work, no open job is left.
const PAGES_AT_MOST = 200;
export async function openWork({ call, settings, now }) {
  const open = [];
  let before;
  for (let page = 0; page < PAGES_AT_MOST; page += 1) {
    const tree = (await call('/tools/run', { tool_id: 'tool:read-work-tree', input: { limit: 50, ...(before ? { before } : {}) }, request_key: `${settings.agent_id}:${now().toISOString()}:${page}`, wait_seconds: 30 })).output;
    if (!tree?.work) throw new Error('The account did not return its work.');
    open.push(...tree.work.filter(item => item.state !== 'finished'));
    const next = tree.next_before;
    if (typeof next !== 'string' || !next.startsWith('open-work:') || next === before) break;
    before = next;
  }
  return open;
}

/** One pass on the account. call(path, body) reaches its /mcp/api routes. → { skipped, folded: [{ into, ids }], problems } */
export async function runFold({ call, settings, sources, shape, now = () => new Date(), dryRun = false, log = () => {} }) {
  const planned = foldPlan({ open: await openWork({ call, settings, now }), sources, shape, now: now().toISOString() });
  log({ did: 'planned', skip: planned.skip.length, fold: planned.fold.map(group => ({ source: group.source.id, event: group.event, count: group.ids.length })) });
  const done = { skipped: [], folded: [], problems: [] };
  if (dryRun) return { ...done, planned };
  // It takes work only while this pass runs, and says so again when it ends, so no other work waits for it.
  const card = takes_work => call('/agents/publish', { agent_id: settings.agent_id, name: settings.agent_name, description: settings.agent_description, takes_work, ...(takes_work ? { capacity: { max_concurrent: 1, ttl_minutes: 30 } } : {}) });
  await card(true);
  const close = async (handoff_id, result, summary) => {
    const taken = await call('/handoffs/take', { agent_id: settings.agent_id, handoff_id });
    if (!taken.handoff) throw new Error(taken.note ?? 'not taken');
    await call('/handoffs/finish', { handoff_id, agent_id: settings.agent_id, generation: taken.generation, result, summary });
  };
  for (const { handoff_id, source } of planned.skip) {
    const words = fill(settings.skipped, { source_label: source.label, rule: JSON.stringify(source.default_rule.skip) });
    try { await close(handoff_id, { state: 'skipped', because: words }, words); done.skipped.push(handoff_id); }
    catch (error) { done.problems.push({ handoff_id, problem: error.message }); }
  }
  for (const group of planned.fold) {
    let into;
    try { into = (await call('/handoffs', { job: group.job, request_key: group.request_key, from_agent: settings.agent_id, input: { arrived: group.arrived } })).handoff.handoff_id; }
    catch (error) { done.problems.push({ fold: group.request_key, problem: error.message }); continue; }
    const words = fill(settings.folded, { count: group.ids.length, event: group.event, source_label: group.source.label, into });
    const closed = [];
    for (const handoff_id of group.ids) {
      try { await close(handoff_id, { state: 'folded', into }, words); closed.push(handoff_id); }
      catch (error) { done.problems.push({ handoff_id, problem: error.message }); }
    }
    done.folded.push({ into, ids: closed });
  }
  await card(false).catch(error => done.problems.push({ card: settings.agent_id, problem: error.message }));
  return done;
}

async function main(argv) {
  const settings = readJson('./quiet-open-source-work.json');
  const pairs = Object.fromEntries(argv.flatMap((value, index) => (value.startsWith('--') ? [[value.slice(2), argv[index + 1]?.startsWith('--') ? 'true' : argv[index + 1] ?? 'true']] : [])));
  if (!pairs.once) throw new Error('Run one pass with --once (add --dry-run to only see what it would do).');
  const key = requireAccountKey({ item: pairs['keychain-item'] ?? settings.keychain_item, timeout: 0 });
  const log = entry => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  const result = await runFold({ call: accountCaller(pairs.origin ?? settings.origin, key), settings, sources: readJson('../records/workshop-event-source-records.json').records.map(row => row.payload).filter(row => Array.isArray(row?.events)),
    shape: readJson('../records/starting-rules.json').each_connected_event, dryRun: pairs['dry-run'] === 'true', log });
  log({ did: 'pass done', skipped: result.skipped?.length ?? 0, folded: result.folded, problems: result.problems, ...(result.planned ? { would_skip: result.planned.skip.length, would_fold: result.planned.fold.map(group => group.ids.length) } : {}) });
}

const isEntryScript = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntryScript()) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
}
