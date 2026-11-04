// src/ais.mjs
//
// PURPOSE
//   One list of the person's AIs and devices. Every AI that can do work for them (a chat, a CLI on one of their
//   computers, a model running on a device, an account connected to Trillion) is one record of kind `ai`, and every
//   computer or phone one record of kind `device`, in the person's own store under the EEAF model (src/record-model.json).
//   Setup's "Connect your AIs", the AI screens, find_agents and routing read this list and nothing else, so they can
//   never disagree about what the person has.
//
//   makeAis({ eeaf, now }) → { upsert(input, context), list(), get(key), remove(key, context), fromCard(card), fromClient(signIn, client), isLive(ai) }
//     upsert   merges what one writer knows into `ai:<key>` (a sign-in, a published agent card, a computer reporting in):
//              `can` from its kind when it names none, `order` kept once the person set it, a device it runs on made once;
//              writes nothing when nothing changed
//     list     every ai, the person's order first, then by label
//     fromCard the upsert a published agent card means (src/ais.json card_kinds)
//
// NON-NEGOTIABLE INVARIANTS
//   1. One record per AI, keyed by what identifies it to its writer (a sign-in's client name, an agent id, a computer's
//      model); writers merge into it, so two writers never make two rows for one AI.
//   2. What an AI can do, how liveness is known and the default place in the order are DATA (src/ais.json).
//   3. A write that changes nothing writes no row.
//   4. A device an AI runs on is a record of its own (`device:<key>`), linked from the AI (`runs_on.device`), so what
//      runs on a computer is what holds that device (participation, read_model holders).
//
import data from '../../shared-code/src/ais.json' with { type: 'json' };
import { settle } from '../../shared-code/src/delegation-ceilings.mjs';

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const keyOf = text => String(text ?? '').trim().toLowerCase().normalize('NFKD').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
const idOf = key => `${data.record_type}:${key}`;
const deviceIdOf = key => `${data.device_type}:${key}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Whether a name is one Trillion's own programs introduce themselves as (src/ais.json trillion_programs): Trillion
 *  working for the person, never one of their AIs. */
export const isTrillionProgram = name => data.trillion_programs.some(program => program.toLowerCase() === String(name ?? '').trim().toLowerCase());

const readerApp = card => (typeof card?.reader === 'string' && card.reader.startsWith('app:') ? card.reader.slice(4) : null);
/** Which of the person's AIs published a chat's card (src/ais.json _card_kinds): the AI whose sign-ins hold its reader, the
 *  app an app:<name> reader names, the client its source_id begins with, else its harness or name; null when none says. */
/** The person's AIs as the list shows them, from their `ai` rows ({ id, ...value }) in any order: the rows with a kind that are
 *  not one of Trillion's own programs, the person's order first, then by label. list() and a kept summary of the same rows
 *  (src/person-store.mjs own-ais-rows) answer the same list. */
export function listedAis(rows) {
  return rows.filter(ai => ai.kind && !isTrillionProgram(ai.label))
    .sort((a, b) => (a.order ?? data.order_default) - (b.order ?? data.order_default) || String(a.label).localeCompare(String(b.label)));
}

/** The name of the AI a sign-in belongs to (`key:<id>`, the `by` of a kept proposal or write), as the one list names it,
 *  or null when no AI on the list answers to it: a sign-in is never a name. */
export const aiNameOfSignIn = (ais, signIn) => (typeof signIn === 'string' && signIn
  ? ais.find(ai => typeof ai.label === 'string' && (ai.sign_ins ?? []).includes(signIn))?.label ?? null : null);

/** A kept proposal's answer (one proposal, or { proposals }) with `proposer_name`: the AI that wrote it, named by the one list
 *  (null when no AI answers to its sign-in), so a screen shows a name and never the sign-in. */
export function withProposerNames(answer, ais) {
  const named = proposal => (proposal && typeof proposal === 'object' && 'by' in proposal ? { ...proposal, proposer_name: aiNameOfSignIn(ais, proposal.by) } : proposal);
  return Array.isArray(answer?.proposals) ? { ...answer, proposals: answer.proposals.map(named) } : named(answer);
}

export function aiKeyOfCard(card, ais = []) {
  const reader = typeof card?.reader === 'string' ? card.reader : null;
  const signedIn = reader && ais.find(ai => (ai.sign_ins ?? []).includes(reader));
  if (signedIn) return signedIn.id.slice(signedIn.id.indexOf(':') + 1);
  const named = readerApp(card) ?? (typeof card?.source_id === 'string' && card.source_id.includes(':') ? card.source_id.slice(0, card.source_id.indexOf(':')) : null)
    ?? (card?.harness && card.harness !== 'unknown' ? card.harness : null) ?? card?.name ?? null;
  return named ? keyOf(named) || null : null;
}

export function makeAis({ eeaf, now = () => new Date().toISOString() }) {
  const get = key => {
    const value = eeaf.read(idOf(keyOf(key)));
    return value ? { id: idOf(keyOf(key)), ...value } : null;
  };

  function upsert(input, { actor = { by: 'ais' } } = {}) {
    const key = keyOf(input?.key);
    if (!key) throw new Error('An AI needs a key.');
    if (input.kind !== undefined && !data.kinds.includes(input.kind)) throw new Error(`An AI's kind is one of ${data.kinds.join(', ')}.`);
    const id = idOf(key);
    const before = eeaf.read(id);
    const kind = input.kind ?? before?.kind ?? 'account';
    const device = input.runs_on?.device ? deviceIdOf(keyOf(String(input.runs_on.device).replace(/^device:/, ''))) : before?.runs_on?.device;
    const runsOn = { ...(before?.runs_on ?? {}), ...(input.runs_on ?? {}), ...(device ? { device } : {}) };
    const value = {
      ...(before ?? {}),
      label: typeof input.label === 'string' && input.label.trim() ? input.label.trim() : before?.label ?? key,
      kind,
      ...(Object.keys(runsOn).length ? { runs_on: runsOn } : {}),
      ...(input.agent_id ? { agent_id: input.agent_id } : {}),
      can: Array.isArray(input.can) ? input.can.filter(word => typeof word === 'string') : before?.can ?? data.can_by_kind[kind] ?? [],
      // The person's order is theirs: a writer that names one only places an AI not placed yet.
      order: before?.order_set_by_person ? before.order : Number.isFinite(input.order) ? input.order : before?.order ?? data.order_default,
      ...(input.order_set_by_person === true ? { order: input.order, order_set_by_person: true } : {}),
      ...(isObject(input.live) ? { live: { ...(before?.live ?? {}), ...input.live } } : {}),
      ...(Array.isArray(input.sign_ins) ? { sign_ins: input.sign_ins.filter(item => typeof item === 'string') } : {}),
      // An AI that runs by model (src/own-ais.json kinds) names the tool and the model it is asked through.
      ...(typeof input.tool_id === 'string' && input.tool_id ? { tool_id: input.tool_id } : {}),
      ...(typeof input.model === 'string' && input.model ? { model: input.model } : {}),
    };
    // The person's ceiling on what this AI may do for them (src/delegation-ceilings.mjs): written again only when the writer names one; none removes it.
    if (input.ceiling !== undefined) { delete value.ceiling; const ceiling = settle(input.ceiling); if (ceiling) value.ceiling = ceiling; }
    // Liveness that only moved forward a little is not written again (src/ais.json live_write_minutes).
    const onlyLive = before && same({ ...before, live: null }, { ...value, live: null });
    const moved = Date.parse(value.live?.seen_at ?? '') - Date.parse(before?.live?.seen_at ?? '');
    if (onlyLive && before.live?.trouble === value.live?.trouble && Number.isFinite(moved) && moved >= 0 && moved < data.live_write_minutes * 60000) return { id, ...before };
    const writes = [];
    if (device && !eeaf.read(device)) writes.push({ id: device, type: data.device_type, value: { label: input.runs_on?.device_label ?? String(input.runs_on?.device ?? device).replace(/^device:/, ''), first_seen_at: now() } });
    if (!same(before, value)) writes.push({ id, type: data.record_type, value });
    if (writes.length) eeaf.write(writes, { actor });
    return { id, ...value };
  }

  // The AIs read a page of ids at a time: one record read probes each of the key store's runs, so reading them one by one
  // cost 7,410 statements and 200,005 rows in one call on the founder's store (2026-10-16). A page that holds a record past
  // its bounds is read again one by one, as a lone read does. Not point reads: those read each root alone, one statement
  // per AI again (800 AIs cold: 800 statements as points, 39 batched).
  function list() {
    const ids = eeaf.ids(data.record_type, { limit: 1000 }), found = new Map();
    for (let at = 0; at < ids.length; at += 100) {
      const page = ids.slice(at, at + 100);
      let read;
      try { read = typeof eeaf.readMany === 'function' ? eeaf.readMany(page) : null; } catch { read = null; }
      for (const id of page) found.set(id, read ? read.get(id) ?? null : eeaf.read(id));
    }
    return listedAis(ids.map(id => ({ id, ...found.get(id) })));
  }

  /** The upsert a published agent card means (src/ais.json card_kinds): a card that runs on a computer is an AI of its own,
   *  live from when it was last published and how long its capacity says it holds, trouble from the card's own words;
   *  any other card is one chat of the AI that published it (aiKeyOfCard), and moves only that AI's liveness forward. A
   *  card an AI published under its own record id (`ai:<key>`, src/own-ais-routing.mjs) is that AI already: null. */
  function fromCard(card, ais = null) {
    const agentId = String(card?.agent_id ?? '');
    if (agentId.startsWith(`${data.record_type}:`)) return null;
    const rule = data.card_kinds.find(item => agentId.startsWith(item.prefix));
    const seen = card?.published_at ?? card?.last_seen_at ?? null;
    if (rule?.chat_of_reader) {
      const key = aiKeyOfCard(card, ais ?? list());
      if (!key) return null;
      const before = get(key);
      const client = data.client_kinds.find(item => new RegExp(item.match, 'i').test(key));
      const newer = !before?.live?.seen_at || (seen && seen > before.live.seen_at);
      return { key, label: before?.label ?? readerApp(card) ?? (card?.harness && card.harness !== 'unknown' ? card.harness : card?.name) ?? key,
        kind: before?.kind ?? client?.kind ?? 'chat', ...(newer && seen ? { live: { seen_at: seen, how: 'heartbeat', minutes: card?.capacity?.ttl_minutes ?? data.live_minutes_default, trouble: null } } : {}) };
    }
    const device = rule?.device_from_suffix ? agentId.slice(rule.prefix.length) : card?.where?.computer ?? null;
    return {
      key: agentId,
      label: card?.name ?? agentId,
      kind: rule?.kind ?? 'account',
      agent_id: agentId,
      ...(device ? { runs_on: { device, place: 'placement:your-computer' } } : {}),
      live: { seen_at: seen, how: 'heartbeat', minutes: card?.capacity?.ttl_minutes ?? data.live_minutes_default, trouble: card?.trouble ?? null },
    };
  }

  /** The upsert an MCP client that introduced itself on a sign-in means: one AI by its client name, its kind from it. */
  /** A client seen at no known time (`at` null: a fill of a client stored before it kept its time) says nothing of liveness. */
  function fromClient(signIn, client, at = now()) {
    const name = String(client?.client_name ?? client?.name ?? '');
    const rule = data.client_kinds.find(item => new RegExp(item.match, 'i').test(name));
    const before = get(name);
    return { key: name, label: client?.name ?? name, kind: before?.kind ?? rule?.kind ?? 'chat', sign_ins: [...new Set([...(before?.sign_ins ?? []), signIn])], ...(at ? { live: { seen_at: at, how: 'stream', trouble: null } } : {}) };
  }

  /** Whether an AI was seen within the time its own liveness says it holds. */
  const isLive = (ai, at = Date.now()) => {
    const seen = Date.parse(ai?.live?.seen_at ?? '');
    return Number.isFinite(seen) && at < seen + (ai.live.minutes ?? data.live_minutes_default) * 60000 && !ai.live.trouble;
  };

  /** One bounded step of folding records made, before chats joined their AI, for cards that are one chat of another AI
   *  (src/ais.json _card_kinds): `limit` records after `before` (ids descending), each whose card is a chat moved into the
   *  AI that published it and removed. → { before, done, folded } */
  function foldChats({ cardOf, before = null, limit = 50, actor = { by: 'ais-fold' } } = {}) {
    const ids = eeaf.ids(data.record_type, { ...(before ? { before } : {}), limit });
    const known = list();
    let folded = 0;
    for (const id of ids) {
      const record = eeaf.read(id);
      const agentId = record?.agent_id;
      const card = agentId ? cardOf(agentId) : null;
      const rule = card ? data.card_kinds.find(item => agentId.startsWith(item.prefix)) : null;
      if (!rule?.chat_of_reader) continue;
      const input = fromCard(card, known.filter(ai => ai.id !== id));
      if (!input || idOf(keyOf(input.key)) === id) continue;
      upsert(input, { actor });
      eeaf.write([{ id, type: data.record_type, value: null }], { actor });
      folded += 1;
    }
    return { before: ids.length ? ids[ids.length - 1] : before, done: ids.length < limit, folded };
  }

  return {
    upsert, list, get, fromCard, fromClient, isLive, foldChats,
    remove(key, { actor = { by: 'ais' } } = {}) {
      const id = idOf(keyOf(key));
      if (eeaf.read(id)) eeaf.write([{ id, type: data.record_type, value: null }], { actor });
      return { removed: id };
    },
  };
}

/** Whether `introduced` is a client that introduced itself on a sign-in: a personal-key or OAuth credential (`key:<id>`)
 *  and the protocol name its client gave. Every road that keeps an introduction checks it here. */
export const isIntroduction = introduced => /^key:[^:]{1,200}$/.test(introduced?.sign_in ?? '')
  && typeof introduced?.client?.client_name === 'string' && Boolean(introduced.client.client_name);
export const INTRODUCTION_REFUSED = 'Name the sign-in and the client it introduced.';

/** The writes POST /ais makes, each kept with its reply under the command's receipt (src/native-local-command-receipts.mjs). */
export const AIS_RECEIPTED_WRITES = Object.freeze(['ais:upsert', 'ais:remove']);

/** GET /ais and POST /ais ({ upsert }, { introduced: { sign_in, client } } or { remove }) at the account's own records
 *  resource (src/native-owner-routes.json ais); any other path or method is Not found. `app` is the asking app the
 *  sign-in authenticated, kept as the change's actor. */
export async function handleAisRequest(ais, request, app = null) {
  const url = new URL(request.url);
  if (url.pathname !== '/ais' || !['GET', 'POST'].includes(request.method)) return Response.json({ error: 'Not found' }, { status: 404 });
  if (request.method === 'GET') return Response.json({ ais: ais.list().map(ai => ({ ...ai, live_now: ais.isLive(ai) })) });
  const body = await request.json().catch(() => null);
  try {
    if (body?.remove) return Response.json(ais.remove(body.remove, { actor: { by: 'ais', app } }));
    // A client that introduced itself on a sign-in (its name kept by the sign-in's gate) is one of the person's AIs.
    if (body?.introduced && !isIntroduction(body.introduced)) return Response.json({ error: INTRODUCTION_REFUSED }, { status: 400 });
    if (body?.introduced) return Response.json(ais.upsert(ais.fromClient(String(body.introduced.sign_in ?? ''), body.introduced.client), { actor: { by: 'ais', app: body.introduced.client?.name ?? null } }));
    return Response.json(ais.upsert(body?.upsert ?? {}, { actor: { by: 'ais', app } }));
  } catch (error) { if (error?.status) throw error; return Response.json({ error: error.message }, { status: 400 }); }
}

/** find_agents over the one list: the agents' cards that answered the job (`agents`, each with agent_id and match),
 *  kept only when their AI is on the person's list (`ais`, PersonStore.ais()), each carrying its ai_id and place in the
 *  person's order; then every AI on the list that publishes no card (`hasCard(agent id)` false), never left out, as not
 *  ready with why. Cards are ordered by how well they match the job, then by the person's order. */
export function agentsFromAis({ ais, agents = [], hasCard }) {
  const keyOf = ai => ai.agent_id ?? ai.id.slice(ai.id.indexOf(':') + 1);
  // A card is published under its agent id, or (a model row's, src/own-ais.mjs) under the ai record's own id.
  const byKey = new Map(ais.flatMap(ai => [[keyOf(ai), ai], [ai.id, ai]]));
  // A chat's card belongs to the AI that published it (aiKeyOfCard), so work can still be handed to that one chat.
  const aiOf = agent => byKey.get(agent.agent_id) ?? byKey.get(aiKeyOfCard(agent, ais));
  const carded = agents.filter(agent => aiOf(agent)).map(agent => {
    const ai = aiOf(agent);
    return { ...agent, ai_id: ai.id, order: ai.order ?? data.order_default };
  }).sort((a, b) => (b.match ?? 0) - (a.match ?? 0) || a.order - b.order);
  const withChats = new Set(carded.map(agent => agent.ai_id));
  const uncarded = ais.filter(ai => !withChats.has(ai.id) && !hasCard(keyOf(ai)) && !hasCard(ai.id)).map(ai => ({
    agent_id: keyOf(ai), ai_id: ai.id, name: ai.label, kind: ai.kind, can: ai.can ?? [], order: ai.order ?? data.order_default,
    ready_now: false, takes_work: false, live_now: ai.live_now === true, why: data.no_card_why,
  }));
  return [...carded, ...uncarded];
}
