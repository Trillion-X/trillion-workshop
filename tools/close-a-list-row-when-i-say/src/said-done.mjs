// src/said-done.mjs
//
// Ported from the old source tree src/said-done.mjs (commit b6ae0ebf8; the ruling that asked for
// it is 294267e9dc, 2026-10-09: "A waiting row closes once the person has done it: their own word that it is done").
//
// Purpose
//   The person's own word closes what they already did. When a message of theirs names one of their open list rows (a
//   Waiting on you step, a chore, any row of a list with a field that `settles`), the small classifier on their own
//   computer is asked whether they say that thing is already done; a clear yes settles the row, saying why in the
//   person's own words; an unsure answer, or none, hands the judgement to their AIs. DATA is src/said-done.json.
//
// Non-Negotiable Invariants
//   1. Blind: nothing here names a list, a field, an app or a word the person might use. Which field settles a row is
//      the list's own field declaration (`settles`); the question, the thresholds, the values filled in and the job
//      words are DATA. There is no list of "done" phrases: the classifier reads the words.
//   2. Only the person's own words are weighed (thePersonsWords). An AI's message, someone else's words heard in a room,
//      and history brought in long after it was said (broughtIn, owned by its own tool) close nothing.
//   3. The question goes only to the person's own computer (`ask`). No answer is never read as no: the judgement is
//      handed to the person's AIs, once per message and row (`once_per`).
//   4. A row already settled is left alone, and a row is settled only through the lists road (`settle`).
//   5. Only fields the row's list has are written, and a choice field only one of its choices.
//   6. The owners of the rules this needs are passed in, never re-derived here: `broughtIn` and `read`/`listFor`/`ask`/
//      `settle`/`handOff`. A missing owner is refused before any row is touched.
//
// Key concepts
//   rowsNamed(message, io)  pure over its reads: the open rows a message links (its entity_resolution mentions and its
//                           record links), each { record_id, row_id, list, field, values, mention }.
//   weighSaidDone(io)       one message: ask, settle or hand on. → { weighed: [{ record_id, verdict, probability?, handoff_id? }] }
//
// The caller (not in this folder yet, see README) must pass: ask = the classifier of tools/ask-a-small-model-for-a-verdict
// (ask-a-hosted-classifier.mjs `ask`, a noul question; returns the probability of yes or null), settle = the lists road
// (keep-and-wake-ai-sessions-on-this-computer src/lists.json putRows), handOff = tools/shared-code/src/agents.mjs handOff,
// broughtIn = tools/notice-what-needs-attention/src/brought-in.mjs broughtIn.
import settings from './said-done.json' with { type: 'json' };

export { settings as saidDoneSettings };

// Old src/message-decision.mjs:72, verbatim in meaning: only the person's own typed or spoken words count.
export const thePersonsWords = message => message?.speaker === 'person' && (message.origin === undefined || message.origin === 'human');

const fill = (text, values) => String(text ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const present = value => value !== undefined && value !== null && value !== '';
const settlingField = list => (Array.isArray(list?.fields) ? list.fields : []).find(field => Array.isArray(field.settles) && field.settles.length);

// The stretch of a long message around the words that name the row, or its opening.
function excerpt(text, mention) {
  const words = String(text ?? '');
  const most = settings.text_chars;
  if (words.length <= most) return words;
  const middle = Number.isInteger(mention?.start) ? Math.floor((mention.start + (mention.end ?? mention.start)) / 2) : 0;
  const from = Math.max(0, Math.min(words.length - most, middle - Math.floor(most / 2)));
  return `${from > 0 ? '…' : ''}${words.slice(from, from + most)}${from + most < words.length ? '…' : ''}`;
}

/**
 * The open rows a message names. listFor({ record_id, list_id }) → the list's definition ({ id, title_field,
 * row_type, fields }) or null; read(id, list) → the row's values or null (or a promise of them).
 */
export async function rowsNamed(message, { read, listFor }) {
  const mentions = message?.entity_resolution?.mentions ?? [];
  const links = (message?.about ?? []).filter(link => link?.kind === 'record' && typeof link.id === 'string');
  const seen = new Map();
  for (const named of [...mentions.filter(mention => mention?.kind === 'record' && typeof mention.id === 'string'), ...links]) {
    if (!seen.has(named.id)) seen.set(named.id, named);
  }
  const rows = [];
  for (const [record_id, named] of seen) {
    const list = listFor({ record_id, list_id: named.list_id ?? null });
    const field = settlingField(list);
    if (!list || !field || !list.row_type) continue;
    const prefix = `record:${list.row_type}:`;
    if (!record_id.startsWith(prefix)) continue;
    const values = await read(record_id, list);
    if (!values || field.settles.includes(values[field.id])) continue;
    rows.push({ record_id, row_id: record_id.slice(prefix.length), list, field, values, mention: named.start !== undefined ? named : null });
  }
  return rows;
}

// The values that settle one row: its settling field's value and each `also` field its list has.
function settlingValues(row, message, words, names) {
  const fields = new Map(row.list.fields.map(field => [field.id, field]));
  const values = { [row.field.id]: row.field.settles[0] };
  for (const [id, template] of Object.entries(settings.also)) {
    const field = fields.get(id);
    if (!field || id === row.field.id) continue;
    const value = fill(template, { words, app: message.app ?? '', message_id: message.id ?? '', finish: names.finish });
    if (Array.isArray(field.choices) && !field.choices.includes(value)) continue;
    values[id] = value;
  }
  return values;
}

/**
 * Step 1 of the split (pure): the classifier questions for one person's message and the open rows it names (rows from
 * rowsNamed, read by the caller). Nothing is asked when the words are not the person's own or are history brought in.
 * Each ask carries the row's settle plan (values) and its hand-off words, so the later steps need nothing else.
 */
export function saidDoneAsks({ message, rows, names, broughtIn }) {
  if (typeof names?.finish !== 'string' || !names.finish) throw new Error('saidDoneAsks needs names.finish: the words of the list choice that says the AIs did it.');
  if (typeof broughtIn !== 'function') throw new Error('saidDoneAsks needs the broughtIn owner; nothing is weighed without it.');
  if (!message || !thePersonsWords(message) || broughtIn(message)) return [];
  return rows.map(row => {
    const title = String(row.values[row.list.title_field] ?? row.row_id);
    const doneWhen = row.values[settings.classify.detail_field];
    const detail = present(doneWhen) && typeof doneWhen === 'string' ? fill(settings.classify.detail, { done_when: doneWhen }) : '';
    const text = excerpt(message.text, row.mention);
    const listName = row.list.label ?? row.list.id;
    const words = text.replace(/\s+/g, ' ').trim();
    return {
      record_id: row.record_id,
      row_id: row.row_id,
      list_id: row.list.id,
      title,
      question: {
        state: fill(settings.classify.state, { app: message.app ?? '', text, list: listName, title, detail }),
        questions: { verdict: { type: 'noul', instructions: settings.classify.question, criteria: settings.classify.means } },
      },
      values: settlingValues(row, message, words, names),
      filled: { app: message.app ?? '', message_id: message.id ?? '', record_id: row.record_id, row_id: row.row_id, list_id: row.list.id, title, text: words,
        detail, conversation_id: message.conversation_id ?? '', values: JSON.stringify(settlingValues(row, message, words, names)) },
    };
  });
}

/**
 * Step 2 of the split (pure): what one answer means for one ask. `probability` is the classifier's 0 to 1 yes, or null when no
 * computer answered. Returns { verdict, probability?, settle? } (a clear yes: settle the row) or { verdict, probability?, hand }
 * (between the thresholds, or no answer: the judgement goes to the person's AIs, once per message and row). A clear no is { verdict: 'not_said' }.
 */
export function saidDoneVerdict({ ask, probability, message }) {
  const known = probability !== null && probability !== undefined && Number.isFinite(Number(probability));
  const p = known ? Number(probability) : null;
  if (known && p >= settings.close_at) return { verdict: 'done', probability: p, settle: { list_id: ask.list_id, row_id: ask.row_id, values: ask.values } };
  if (known && p < settings.unsure_from) return { verdict: 'not_said', probability: p };
  const filled = { ...ask.filled, why: known ? fill(settings.why.unsure, { probability: p.toFixed(2) }) : settings.why.silent };
  const once = fill(settings.hand.once_per, filled);
  return {
    verdict: known ? 'unsure' : 'no_classifier',
    ...(known ? { probability: p } : {}),
    hand: {
      job: fill(settings.hand.job, filled), said: fill(settings.hand.said, filled), from_agent: settings.hand.from_agent,
      priority: settings.hand.priority, once_per: once, request_key: once,
      input: { said_done: { message_id: message.id ?? null, list_id: ask.list_id, row_id: ask.row_id, values: ask.values } },
    },
  };
}

/**
 * The whole weigh in one call (the owners passed in): saidDoneAsks, the question to ask, then saidDoneVerdict, settling or handing
 * on. message, read, listFor (as rowsNamed), broughtIn (the owner's rule: true for history brought in), names ({ finish }),
 * ask(input) → a probability 0 to 1 or null, settle({ list_id, row_id, values }), handOff(job) → agents.handOff's answer.
 */
export async function weighSaidDone({ message, read, listFor, broughtIn, names, ask, settle, handOff }) {
  if (typeof names?.finish !== 'string' || !names.finish) throw new Error('weighSaidDone needs names.finish: the words of the list choice that says the AIs did it.');
  if (typeof broughtIn !== 'function') throw new Error('weighSaidDone needs the broughtIn owner; nothing is weighed without it.');
  if (!message || !thePersonsWords(message) || broughtIn(message)) return { weighed: [] };
  const rows = await rowsNamed(message, { read, listFor });
  const weighed = [];
  for (const item of saidDoneAsks({ message, rows, names, broughtIn })) {
    const probability = await ask(item.question);
    const verdict = saidDoneVerdict({ ask: item, probability, message });
    if (verdict.settle) await settle(verdict.settle);
    if (verdict.hand) {
      const handed = await handOff(verdict.hand);
      weighed.push({ record_id: item.record_id, verdict: verdict.verdict, ...(verdict.probability !== undefined ? { probability: verdict.probability } : {}), handoff_id: handed?.handoff?.handoff_id ?? handed?.handoff_id ?? null });
      continue;
    }
    weighed.push({ record_id: item.record_id, verdict: verdict.verdict, ...(verdict.probability !== undefined ? { probability: verdict.probability } : {}) });
  }
  return { weighed };
}
