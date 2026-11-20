import { failureOf } from '../../shared-code/src/failure.mjs';
// The caller supplies account rows; no process-global opinion settings are retained.
export function createAttention(data, { broughtIn, wordsAgeMinutes }) {
// src/attention.mjs
//
// What an arriving item gets before anything is opened for it: act (its decision opens and the person's AIs are handed
// it), context (its words are kept and nothing else happens) or classify (a small classifier on the person's own
// computer is asked, and its answer picks act or context).
//
// Purpose
//   A carrier that hears a room (src/inbound.mjs, computer/listen.mjs) brings every sentence said there. Opening a
//   decision and a job for each one asked a large model about chatter: on 2026-10-05 4,342 overheard sentences were
//   waiting for an AI and the judge of their decisions spent $103 of the person's Gemini key in a few hours. Deciding
//   what deserves an AI must cost nothing: rules first, then a classifier on the person's own device, never a metered
//   model.
//
// Non-negotiable invariants
//   1. Rules are DATA (src/attention.json, or the person's own `attention_rules`): the formula engine's rule tree over
//      an item's facts, first rule that holds decides, `otherwise` when none does. Nothing here names a carrier.
//   2. Context keeps the words exactly as any message is kept; only the decision and the job are left out.
//   3. Classify never costs the person money: it asks only the classifier route (src/model-routes.json `classify`), and
//      an item no classifier answered is kept as context, never escalated to a paid model.
//   4. The carrier's own verdict (`verdict`, from a classifier it ran itself) is one more fact, decided by the rules.
//   5. Heard words are the person's only when the carrier's voice check named the person AND said how sure it was
//      (`voice: { me, named, score }`) above the starting rule's bar. A request belongs to whoever said it: someone
//      else's (or an unsure voice's) is handed on as theirs, with the person asked who said it when unsure; it is
//      never pinned on the person. A carrier that sends no voice gets context: it fails closed.
//   6. Brought-in history (words said long before they reached Trillion: an imported chat, a catch-up) is decided by the
//      one owner of that rule, src/brought-in.mjs, as the facts `brought_in` and `words_age_minutes`; the starting rules
//      keep it as context, so history is kept and searchable and opens nothing. The rule engine (src/automations.mjs)
//      and the weigher of what AIs leave the person (src/steps-ais-leave.mjs) read the same owner.
//
// Shapes
//   attentionFacts(arrival, now) -> { route, speaker, words, text, verdict, heard, voice_me, voice_score, voice_named,
//     voice_new, words_age_minutes, brought_in }: an arrival not kept yet counts as kept at `now`
//   attentionOpens(attention) -> boolean;  keptAs(arrival, decided) -> the arrival as it is kept
//   decideAttention({ rules, facts, matches(tree, facts), otherwise }) -> { attention, rule, from? }: an attention that
//     opens nothing comes back as `context` (with its `from` when it has one), so every caller that keeps context
//     keeps it, including a caller written before that attention existed
//   attentionRules(saved) -> the rules to use: the person's own when they kept some, else the starting rules
//

const ATTENTION_PATH = '/attention';

const wordsIn = text => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;

/** The facts the rules are written over, from what a carrier brought (src/inbound.mjs receive input). */
function attentionFacts(arrival = {}, now = Date.now()) {
  // When the words were said and when Trillion kept them; an arrival not kept yet is being kept now.
  const kept = { authored_at: arrival.authored_at, at: arrival.at, recorded_at: arrival.recorded_at ?? new Date(now).toISOString() };
  const age = wordsAgeMinutes(kept);
  return {
    route: String(arrival.route ?? ''),
    speaker: arrival.from_person === false ? 'someone' : 'person',
    words: wordsIn(arrival.text),
    text: String(arrival.text ?? ''),
    verdict: Object.hasOwn(data.attentions, arrival.verdict) ? arrival.verdict : '',
    heard: arrival.heard === true,
    voice_me: arrival.from_person !== false && arrival.voice?.me === true,
    voice_score: Number.isFinite(arrival.voice?.score) ? arrival.voice.score : null,
    voice_named: arrival.voice?.named === true || arrival.voice?.me === true,
    // A voice the carrier keeps apart under its own label (voice-3) and nobody has named: a person of its own.
    voice_new: arrival.voice?.me !== true && arrival.voice?.named !== true && typeof arrival.voice?.voice === 'string' && arrival.voice.voice.trim().length > 0,
    words_age_minutes: age === null ? null : Math.floor(age),
    brought_in: broughtIn(kept),
  };
}

/** Whether an attention opens a decision and a job (act, classify) or keeps the words only (context, unconfirmed). */
const attentionOpens = attention => data.attentions[attention]?.opens === true;

/**
 * The arrival as it is kept for a decided attention. One with `from` or `words_as` is someone else's: kept under the
 * carrier's own name for the voice (a first name, "Someone (voice-3)"), else `from`, never as the person's; `words_as` picks
 * the words its request is handed on in (src/inbound-words.json job_<words_as>).
 */
function keptAs(arrival, decided) {
  if (!decided?.from && !decided?.words_as) return arrival;
  const named = String(arrival.voice?.name ?? '').trim();
  const from = arrival.from_person === false && arrival.from ? arrival.from
    : named && decided.maybe_from ? decided.maybe_from.replace('{name}', named) : decided.from ?? arrival.from;
  const voice = String(arrival.voice?.voice ?? '').trim();
  const own = from ?? (voice && decided.new_voice ? decided.new_voice.replace('{voice}', voice) : null);
  return { ...arrival, from_person: false, ...(own ? { from: own } : {}), ...(decided.words_as ? { words_as: decided.words_as } : {}),
    ...(decided.person_record ? { person_record: true } : {}) };
}

// What a rule's attention comes back as: one that opens nothing is context, carrying its `from`.
const decidedAs = (attention, rule) => {
  const kind = data.attentions[attention];
  const as = { ...(kind?.from ? { from: kind.from } : {}), ...(kind?.maybe_from ? { maybe_from: kind.maybe_from } : {}), ...(kind?.words_as ? { words_as: kind.words_as } : {}),
    ...(kind?.new_voice ? { new_voice: kind.new_voice } : {}), ...(kind?.person_record ? { person_record: true } : {}) };
  if (!kind || kind.opens) return { attention, rule, ...as };
  return { attention: 'context', rule, ...as };
};

/** The rules a person's items are decided by: their own when they kept some, else everyone's starting rules. */
function attentionRules(saved) {
  return Array.isArray(saved?.rules) ? saved.rules : data.starting_rules;
}

/** Checks a person's rules before they are kept: each needs an id and an attention this file names. */
function checkAttentionRules(rules) {
  if (!Array.isArray(rules) || rules.length > data.most_rules) throw new Error(`rules is a list of at most ${data.most_rules} rules.`);
  return rules.map((rule, index) => {
    if (typeof rule?.id !== 'string' || !rule.id.trim()) throw new Error(`rules[${index}] needs an id.`);
    if (!Object.hasOwn(data.attentions, rule.attention)) throw new Error(`rules[${index}].attention is one of ${Object.keys(data.attentions).join(', ')}.`);
    if (rule.when !== null && rule.when !== undefined && rule.when?.kind !== 'group') throw new Error(`rules[${index}].when is a rule tree ({ kind: "group", ... }) or null.`);
    return { id: rule.id.trim().slice(0, 100), says: String(rule.says ?? '').slice(0, 300), when: rule.when ?? null, attention: rule.attention };
  });
}

/** The first rule that holds for these facts decides; `otherwise` when none does. */
async function decideAttention({ rules, facts, matches, otherwise = data.otherwise }) {
  for (const rule of rules) {
    if (!rule.when || await matches(rule.when, facts)) return decidedAs(rule.attention, rule.id);
  }
  return decidedAs(otherwise, null);
}

/** The classifier's question for an item's words, and whether its answer (a probability) means act. */
function classifyRequest(facts) {
  const { state, question, means } = data.classify;
  return { state: state.replace('{text}', facts.text), questions: { verdict: { type: 'noul', instructions: question, criteria: means } } };
}
/** What one classifier answered: 'act', 'context', 'defer' when its probability is a dead heat (within `defer_margin` of
 *  `act_at`, so another route should be asked), or null when it gave no number. */
function classifiedVerdict(answer, using = data.classify) {
  const probability = Number(answer?.answers?.verdict?.noul);
  if (!Number.isFinite(probability)) return null;
  const { act_at: actAt, defer_margin: margin = 0 } = using;
  if (margin > 0 && Math.abs(probability - actAt) < margin) return 'defer';
  return probability >= actAt ? 'act' : 'context';
}
/** The attention one classifier's answer settles on by itself: a dead heat settles on `defer_to` (DATA) when no other route is left to ask. */
function classifiedAttention(answer, using = data.classify) {
  const verdict = classifiedVerdict(answer, using);
  return verdict === 'defer' ? using.defer_to : verdict;
}

// Waiting jobs whose words the attention rules now keep as context are closed as handled, oldest first, up to `limit`
// looked at and at most `classified` of them asked of the classifier on the person's computer (src/close-many.mjs):
// the overheard sentences that were handed to AIs before the rules existed. next_after continues where it stopped.
//   openHandoffs({ after, limit })  the open-work page, oldest handed first
//   readHandoff(id)                 one handoff
//   readMessage(id)                 one kept message
//   byRules(arrival)                what the rules alone decide ({ attention, rule })
//   attention(arrival)              what the rules and, when they say classify, the classifier decide
//   close(items)                    closeMany over one batch of at most 50, { closed: [{ handoff_id }] }
async function retriageWaiting({ openHandoffs, readHandoff, readMessage, byRules, attention, close }, { limit = 200, after = '', classified = 10 } = {}) {
  // The open-work store orders by handed time and id. Use that same durable cursor instead of reading the entire
  // backlog to sort ids; one request examines at most one page, and the caller can resume with next_after.
  const size = Math.min(Math.max(Math.floor(Number(limit) || 200), 1), 50);
  const ids = openHandoffs({ after: after || null, limit: size }).map(item => item.handoff_id);
  const items = [];
  let asked = 0;
  let last = null;
  for (const handoff_id of ids) {
    const handoff = readHandoff(handoff_id);
    // A job handed on for words that arrived (input.arrived), or for words an AI left the person (input.said_by_ai,
    // src/steps-ais-leave.mjs): either is closed when attention now keeps those words as context.
    const arrived = handoff?.input?.arrived;
    const messageId = arrived?.message_id ?? handoff?.input?.said_by_ai?.message_id;
    const message = messageId && !handoff.taken_by && !handoff.to_agent ? readMessage(messageId) : null;
    if (message) {
      // heard and voice are the carrier's facts about how the words were heard: the rules that decide heard words need them.
      const arrival = { route: arrived?.route ?? message.app, from_person: arrived ? arrived.from_person : false, text: message.text, at: message.at, authored_at: message.authored_at, recorded_at: message.recorded_at, heard: arrived?.heard ?? message.heard, voice: arrived?.voice ?? message.voice };
      const ruled = await byRules(arrival);
      if (ruled.attention === 'classify' && asked >= Math.max(Number(classified) || 0, 0)) break;
      if (ruled.attention === 'classify') asked += 1;
      const decided = ruled.attention === 'classify' ? await attention(arrival) : ruled;
      if (decided.attention === 'context') items.push({ handoff_id, outcome: 'handled', reason: ruled.attention === 'classify' ? data.words.classified_context : data.starting_rules.find(rule => rule.id === decided.rule)?.says ?? data.words.kept_as_context });
    }
    last = handoff_id;
  }
  const closed = [];
  for (let start = 0; start < items.length; start += 50) closed.push(...(await close(items.slice(start, start + 50))).closed.map(item => item.handoff_id));
  return { looked_at: ids.length, closed: closed.length, classified: asked, next_after: last };
}

// The person's attention rules (attention:request in src/native-owner-routes.json): read them, replace them (rules null
// goes back to the starting rules), or close waiting jobs the rules now keep as context (retriage(input)).
//   fact() / setFact(value)  the account's attention_rules setting
async function handleAttentionRequest({ fact, setFact, retriage, now = () => new Date() }, request) {
  const path = new URL(request.url).pathname;
  try {
    if (path === ATTENTION_PATH) {
      if (request.method === 'POST') {
        const { rules } = await request.json();
        await setFact(rules === null ? null : { rules: checkAttentionRules(rules), set_at: now().toISOString() });
      }
      const saved = await fact();
      return Response.json({ rules: attentionRules(saved), own: Boolean(saved), facts: data.facts, attentions: data.attentions, otherwise: data.otherwise, classify: data.classify });
    }
    if (request.method === 'POST' && path === `${ATTENTION_PATH}/retriage`) return Response.json(await retriage(await request.json().catch(() => ({}))));
    return Response.json({ error: 'Not found' }, { status: 404 });
  } catch (error) {
    // Busy, interrupted or out-of-budget is the shared HTTP failure owner's to answer, never a refusal here.
    if (failureOf(error).tries_again_later) throw error;
    return Response.json({ error: error.message }, { status: 400 });
  }
}

return { attentionData: data, ATTENTION_PATH, attentionFacts, attentionOpens, keptAs, attentionRules, checkAttentionRules, decideAttention, classifyRequest, classifiedVerdict, classifiedAttention, retriageWaiting, handleAttentionRequest };
}
