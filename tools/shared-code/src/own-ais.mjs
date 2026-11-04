import { teamReviewActorProblem } from './team-review.mjs';
// src/own-ais.mjs
//
// The person's own AIs and computers, as rows: one place that says which of them can take waiting work now.
//
// Purpose
//   Trillion's waiting work (a voice memo at night, a share from their phone) goes to the first of the person's own AIs
//   and computers, in their order, that is live and can do the job. A row is one such AI or computer, kept as a record
//   of kind `ai` (src/record-model.json). This file reads and writes those rows and picks one for a job; it never runs
//   anything (src/own-ais-routing.mjs routes, src/own-ais-work.mjs works a job under a model row).
//
// Non-negotiable invariants
//   1. A row's kind, its liveness window, what it can do by default, whether it spends, and every name it is found by
//      are DATA (src/own-ais.json kinds, card_kind, card_prefix, legacy). Nothing here names a provider, a model, a
//      computer or a kind of row: code reads the kind a row holds and what that kind of row is.
//   2. pick() is pure: the first row, in the order given, that is live and whose `can` covers the job's needs. A job's
//      needs are input.needs when it names some, else its sender's DATA needs or default_needs; "any" in a row's `can`
//      covers ordinary skills, while execution needs must match its kind properties. A need of "any" is covered by
//      every row. A row that is not live, or cannot do the job, is skipped with its reason, so a
//      job no row fits says why each one was passed over (reasons), never silently.
//   3. A row is live when it was seen (live.seen_at) within its kind's live_minutes and no trouble still in force
//      (live.trouble, with an `until` that has not passed) stops it. Trouble is what made a row refuse work: a service
//      out of credit, a key it refuses, a taker card that said it cannot work right now.
//   4. migrate writes rows through makeAis (src/ais.mjs); it never runs a job and never deletes a row. A row's order is
//      kept when it is written again: the person's order (order_your_ais) is theirs. A new row takes the next order after
//      the last one. Writing rows from the person's computers' taker cards is the data-model lane's (src/ais.mjs).
//   5. migrate reads what the person chose before this change (the earlier choice fact, read once by the store) and turns each
//      service or computer they chose into a row in their order. It never adds a row for a service they did not choose.
//   6. Trillion never pays for an AI: a row spends only what its kind's `spends` names (the person's own connection or
//      their own computer), and only the person's own rows are ever read here.
//

import settings from './own-ais.json' with { type: 'json' };
import { cardSkillFor, formerAgentIds } from './renamed-tools.mjs';
import { effective, refusal } from './delegation-ceilings.mjs';

export const OWN_AIS_PATH = '/own-ais';

const ms = iso => (typeof iso === 'string' && iso ? Date.parse(iso) : NaN);
const kindOf = row => settings.kinds[row?.kind] ?? null;

/** What a job needs: explicit input.needs, then sender DATA, then the data default. */
export function needsOf(job) {
  const named = job?.input?.needs;
  return Array.isArray(named) && named.length ? named.map(String) : settings.needs_from?.[job?.from_agent] ?? settings.default_needs;
}

/** Whether a row's `can` covers every need, and its ceiling (src/delegation-ceilings.mjs, tightened by `job`'s own) permits them. */
export function covers(row, needs, job = null) {
  if (refusal(effective(row, job), needs) !== null) return false;
  const can = Array.isArray(row?.can) ? row.can : [];
  // Execution capabilities describe how an AI is reached, not what its model claims it can do. An `any` model
  // cannot become a connected subscription by claiming that skill. The required kind properties are DATA.
  return needs.every(need => {
    const properties = settings.need_properties?.[need];
    return properties ? Object.entries(properties).every(([key, values]) => Array.isArray(values) && values.includes(kindOf(row)?.[key]))
      : need === 'any' || can.includes('any') || can.includes(need);
  });
}

/** Why a row is not live now, or null when it is live. */
export function liveProblem(row, now = new Date()) {
  const kind = kindOf(row);
  if (!kind) return 'its kind is not one this account can use';
  const seen = ms(row.live?.seen_at);
  if (!Number.isFinite(seen)) return 'it has not been seen';
  // A row from a published card holds for the minutes its card names (src/ais.mjs fromCard live.minutes).
  const windowMinutes = Number.isFinite(row.live?.minutes) ? row.live.minutes : kind.live_minutes;
  if (now.getTime() - seen > windowMinutes * 60_000) return `it was last seen ${row.live.seen_at}`;
  // Trouble is the card's own words (a text) or what refused work here ({ why, until? }).
  const trouble = typeof row.live?.trouble === 'string' ? { why: row.live.trouble } : row.live?.trouble;
  if (trouble && (!trouble.until || !(ms(trouble.until) <= now.getTime()))) return trouble.why ?? 'it has trouble';
  return null;
}

/** Whether a row is live now (liveProblem is null). */
export const isLive = (row, now = new Date()) => liveProblem(row, now) === null;

/**
 * Whether a computer row is connected: its tool is the shipped local one for this placement, the placement's agent has a
 * live card that takes work, keeps the tool and has capacity, and the agent is reached. `data` is the workshop rows.
 */
export function deviceRowConnected(row, { data, card, reach, now = new Date() }) {
  if (!row?.tool_id || !row.runs_on?.place) return false;
  const tool = data.tools.find(item => item.id === row.tool_id);
  const place = data.placements.find(item => item.id === row.runs_on.place);
  if (!tool || tool.status !== 'active' || tool.invoke?.kind !== 'computer-tool' || tool.needs?.network_egress !== false ||
      tool.price_ref || tool.billing || !tool.placements?.length || tool.placements.some(id => id !== row.runs_on.place) ||
      place?.executor !== 'agent' || !place.settings?.agent_id) return false;
  // A device app published before the rename advertises the former agent id.
  const found = [place.settings.agent_id, ...formerAgentIds(place.settings.agent_id)].find(id => card(id));
  const agent = found ? card(found) : null, capacity = agent?.capacity_claim;
  if (!agent || agent.agent_id !== found) return false;
  const keeps = cardSkillFor(agent, row.tool_id) !== null;
  const reached = reach(agent.agent_id);
  const present = reached?.live || (reached?.route === 'next_connection' && reached.present);
  return Boolean(agent.takes_work && keeps && capacity?.max_concurrent > 0 &&
    Date.parse(capacity.expires_at) > now.getTime() && present);
}

/** Each skip reason of one row for one job, or null when the row can take it now. */
function skipReason(row, needs, now, job = null) {
  if (!kindOf(row)) return 'its kind is not one this account can use';
  // An MCP sign-in proves that a client is connected, not that it published a
  // recipient for waiting work. Both addressed and model-run jobs need that
  // actual identity; never manufacture one from the client or record name.
  if (typeof row.agent_id !== 'string' || !row.agent_id.trim()) return 'it has no registered work recipient';
  // A row that runs by model is asked through its tool; one with none (a published card, src/ais.mjs fromCard) is
  // reached through its own card, never asked here.
  if (kindOf(row).runs === 'model' && !row.tool_id) return 'it names no model Trillion can ask for it';
  const limited = refusal(effective(row, job), needs);
  if (limited !== null) return limited;
  if (!covers(row, needs)) return `it cannot do ${needs.filter(need => need !== 'any' && !(row.can ?? []).includes(need)).join(', ') || 'this work'}`;
  return liveProblem(row, now);
}

/**
 * The first row, in the order given, that is live and can do the job: { row, reasons }. Nothing fits: row is null and
 * reasons says why each row was passed over ({ id, label, agent_id, why }). Pure: nothing is read or written here.
 */
export function pick(job, rows, now = new Date()) {
  const needs = needsOf(job);
  const reasons = [];
  for (const row of rows) {
    const why = teamReviewActorProblem(job, row) ?? skipReason(row, needs, now, job);
    if (why === null) return { row, reasons: [] };
    reasons.push({ id: row.id, label: row.label ?? row.agent_id, agent_id: row.agent_id, why });
  }
  return { row: null, reasons };
}

/** The words a job with no fitting row is marked with: each row and why it was passed over (data words). */
export function noTakerWords(reasons, words = settings.words) {
  if (!reasons.length) return words.none_yet;
  return words.no_taker.replace('{reasons}', reasons.map(item => words.reason.replace('{label}', item.label).replace('{why}', item.why)).join('; '));
}

/**
 * Writes the rows an earlier choice becomes, in the order the person chose them, after every row already kept. `ais` is
 * makeAis({ eeaf }) (src/ais.mjs). `fact` is what that choice was kept as: { providers: [{ provider, model? }] } or
 * { provider, model? }. A service this code no longer knows is skipped, and a row already kept is not written again.
 * Returns the rows written. The store calls this once and keeps the fact that it did.
 */
export function migrate(ais, fact, now = new Date()) {
  const picked = Array.isArray(fact?.providers) ? fact.providers : fact?.provider ? [fact] : [];
  const existing = ais.list();
  const taken = new Set(existing.map(row => row.id));
  let order = existing.reduce((top, row) => Math.max(top, Number(row.order) || 0), -1) + 1;
  const out = [];
  for (const item of picked) {
    const legacy = settings.legacy.providers[item?.provider];
    if (!legacy) continue;
    const id = `ai:${item.provider}`;
    if (taken.has(id)) continue;
    taken.add(id);
    const kind = legacy.kind;
    out.push(ais.upsert({
      key: item.provider, label: legacy.label, kind, agent_id: id, order, can: [...(settings.kinds[kind]?.can ?? [])],
      live: { seen_at: now.toISOString(), how: 'migrated' }, runs_on: { ...legacy.runs_on },
      model: typeof item.model === 'string' && item.model ? item.model : legacy.model, tool_id: legacy.tool_id,
    }, { actor: { by: 'own-ais' } }));
    order += 1;
  }
  return out;
}

// The facts an earlier version kept its choice and its runs under. Read only by the one-time migration (migrate).
const LEGACY_CHOICE_FACT = 'always_on_ai';
const LEGACY_RUNS_FACT = 'always_on_runs';
/** The earlier choice, read through readFact (the store) for migrate. */
export const legacyChoice = readFact => readFact(LEGACY_CHOICE_FACT) ?? null;
/** The earlier run state, read through readFact for the one-time copy. */
export const legacyRuns = readFact => readFact(LEGACY_RUNS_FACT) ?? null;
/** The harness the earlier agent published its card with: each card of that harness that no AI row names stops taking work. */
export const retiredHarness = () => settings.legacy.harness;
/**
 * The retirement of the earlier harness's cards (`ais` is makeAis, src/ais.mjs; `named` the agent ids an AI row of the
 * person's own names): { cards, rows }. cards are each card of that harness still taking work that no row names; rows
 * are the AI rows they made: each card's own, and the chat row its cards are one chat of (src/ais.mjs fromCard) when only
 * those cards make it, so no card that keeps taking work, and no sign-in, agent id or tool of the person's, holds it.
 */
export function retiring(cards, ais, named) {
  const retire = cards.filter(card => card.harness === settings.legacy.harness && card.takes_work && !named.has(card.agent_id));
  const leaving = new Set(retire.map(card => card.agent_id));
  const known = ais.list();
  const chatOf = card => ais.fromCard(card, known)?.key ?? null;
  const kept = new Set(cards.filter(card => card.takes_work && !leaving.has(card.agent_id)).map(chatOf));
  const rows = new Set(leaving);
  for (const card of retire) {
    const key = chatOf(card), row = key ? ais.get(key) : null;
    if (row && !kept.has(key) && !row.agent_id && !row.tool_id && !(row.sign_ins ?? []).length) rows.add(key);
  }
  return { cards: retire, rows: [...rows] };
}

/** The tools any of the person's AIs use to read and order their own AIs: { name, description, inputSchema, run }. */
export function ownAisTools(call) {
  return [
    {
      name: 'list_your_ais',
      description: 'Lists the AIs and computers that can take the person\'s waiting work when none of their own AIs took it in time, in their order: each with its label, kind, whether it is live now, what it can do, and any trouble (out of credit, a refused key, a computer that is asleep).',
      inputSchema: { type: 'object', properties: {} },
      run: () => call(OWN_AIS_PATH),
    },
    {
      name: 'order_your_ais',
      description: 'Sets the order the person\'s AIs take waiting work in: order is the list of AI ids (from list_your_ais), first to take it first. Ids not listed keep their place after the listed ones. Nothing runs until the person has AIs; this only changes the order.',
      inputSchema: { type: 'object', properties: { order: { type: 'array', items: { type: 'string' } } }, required: ['order'] },
      run: (input = {}) => call(OWN_AIS_PATH, { order: Array.isArray(input.order) ? input.order : [] }),
    },
    {
      name: 'limit_your_ai',
      description: 'Sets the ceiling on what one of the person\'s AIs may do on their behalf: id is an AI id from list_your_ais; deny lists work it must not be given (like "files"); allow, when given, lists the only work it may be given. Leave both out to remove the ceiling. A job an automation hands over can tighten this ceiling and never widen it.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, deny: { type: 'array', items: { type: 'string' } }, allow: { type: 'array', items: { type: 'string' } } }, required: ['id'] },
      run: (input = {}) => call(OWN_AIS_PATH, { limit: { id: input.id, deny: input.deny, allow: input.allow } }),
    },
  ];
}

export const ownAisAnnotations = {
  limit_your_ai: { title: 'Limit your AI', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_your_ais: { title: 'List your AIs', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  order_your_ais: { title: 'Order your AIs', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
