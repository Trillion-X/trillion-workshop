// tools/show-the-signed-in-persons-message-inbox-and-tell/src/message-route.mjs
//
// PURPOSE
//   The web chat's message routes as one Workshop route tool the engine runs for the page's account (workshop-routes):
//   GET /messages and GET /messages/threads (the conversations, newest first), GET /messages/thread (one conversation's
//   messages), POST /messages/send (the person's words to one AI), POST /messages/send-all (the person's words to all
//   their AIs, kept in the shared Trillion conversation) and POST /messages/correct (the person's own words in one of
//   their messages, corrected in place). Old trillion answered them in src/work-messages.mjs and
//   src/send-to-all-ais.mjs over the person store. Here the tool holds no database: the caller reads the person's
//   message rows from the store in its own language and gives them as `stored.records`, and the rows a send makes come
//   back as `keep`, for the caller to write where the person keeps them. Each message is one `message` row, the same
//   row the hooks keep for an AI's turns (trillion-rust src/account/hooks.json messages: id
//   `message:<at>:<24 hex of the BLAKE3 of the canonical {app, at, conversation_id, speaker, text}>`), so every AI reads it.
//
//   input  { path, method, query, body, browser, stored: { records: [{ id, type, value }], file_identities: [identity] } }
//   output { status, body, keep: [{ id, type, value, replaces? }] }
//
// NON-NEGOTIABLE INVARIANTS
//   1. A message sent from the page is kept word for word, once: the sender's `client_id` is its place (source_ref
//      `client:<id>`, kept by a `message-source-key` row as src/messages.mjs sourceKeyOf names it), so the same id sent
//      again is the message already kept and answers its id with `recorded: 0` and an empty `keep`. The caller gives the
//      source-key rows and message rows it read for the send; a send with no matching row in `stored.records` is new.
//   2. The caller writes `keep` in one batch, each row as a new row (absent before the write), so a second write of the
//      same message cannot land twice. The one exception is a row marked `replaces` (a correction): the caller updates
//      the row with that id in one statement, and it must exist already.
//   3. A read looks through at most SCAN messages given, newest first, and answers what it found with `next_before`; no
//      read walks the whole history.
//   4. An AI is woken the way the person's AIs take work (a To do calendar-task row, which an AI lists when it connects), kept
//      in the same batch as the message: send with an agent_id hands it to that AI, send-all to any AI or to the AIs
//      @-mentioned. Nothing here reaches an AI's live session, so the answer says the message is kept and read on the AI's
//      next connection, never that it was delivered. Files ride by reference: each must be one of the person's own
//      (`stored.file_identities`), linked in the message's `about` and in the task's input refs.
//
import { mentionKind } from '../../send-one-message-to-all-of-my-ais-at-once/src/work-mentions.mjs';
import { partFrom } from '../../keep-and-wake-ai-sessions-on-this-computer/src/responses.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { prepareProducedTask } from '../../plan-tasks-and-todo-lists/task-moves.mjs';

const TYPE = 'message';
const SOURCE_KEY_TYPE = 'message-source-key';
const SHARED = { app: 'Trillion', conversation_id: 'trillion:shared' };
const MAX_TEXT = 200_000;
const SCAN = 1000;
const PAGE = { default: 20, max: 100 };
const SENT_VIA = 'Trillion';
// An event's refs hold at most 20 ids, one of them the message's own (old src/send-to-all-ais.mjs).
const MOST_FILES = 19;
const MOST_MENTIONS = 20;

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const canonical = value => JSON.stringify(value, (key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value, chars) => makeHashCodeHexFromBytes(new TextEncoder().encode(canonical(value))).slice(3, 3 + chars);
const idOf = message => `${TYPE}:${message.at}:${digest({ conversation_id: message.conversation_id, app: message.app, speaker: message.speaker, at: message.at, text: message.text }, 24)}`;
const sourceKeyOf = message => `${SOURCE_KEY_TYPE}:${digest({ app: message.app, conversation_id: message.conversation_id, source_ref: message.source_ref }, 32)}`;
const answer = (body, status = 200, keep = []) => ({ status, body, keep });
const refuse = (error, status = 400) => answer({ error }, status);

class Refused extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// The person's rows the caller gave, as { id, ...value } for each of one type, newest id first (the order the store lists
// them in, reversed), below `before` when a page is asked for, at most SCAN of them.
function newestOf(records, type, before) {
  const given = Array.isArray(records) ? records : [];
  return given
    .filter(one => one && one.type === type && typeof one.id === 'string' && object(one.value))
    .filter(one => !before || one.id < before)
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, SCAN);
}

// The one message the person sent, kept once (invariant 1) with the tasks that hand it to the AIs it is for, in the same
// batch, so a message is never kept without its tasks. Answers { id, recorded, keep }.
function keep(records, { app, conversation_id, text, about, client_id }, now, tasksOf = () => []) {
  const at = new Date(now).toISOString();
  const source_ref = client_id ? `client:${client_id.trim()}` : undefined;
  const message = { conversation_id, app, speaker: 'person', at, text, ...(about?.length ? { about } : {}), ...(source_ref ? { source_ref } : {}) };
  const sourceKey = source_ref ? sourceKeyOf(message) : null;
  if (sourceKey) {
    const kept = (Array.isArray(records) ? records : []).find(one => one?.id === sourceKey && one.type === SOURCE_KEY_TYPE);
    if (kept?.value?.message_id) return { id: kept.value.message_id, recorded: 0, keep: [] };
  }
  const id = idOf(message);
  const rows = [{ id, type: TYPE, value: { ...message, recorded_at: at, captured_road: 'signed-in screen', recorded_app: SENT_VIA } }];
  if (sourceKey) rows.push({ id: sourceKey, type: SOURCE_KEY_TYPE, value: { message_id: id } });
  for (const task of tasksOf(id)) rows.push({ id: task.id, type: task.type, value: task.value });
  return { id, recorded: 1, keep: rows };
}

// The task that is an AI's wake (old trillion's `message.created` event and hand-off): a To do calendar-task, which an AI
// takes when it connects (its bootstrap lists the To do tasks it can take). `agent_id` names the one AI it is for, as its
// one assignee; none leaves the task to anyone, so any AI may take it.
const taskFor = ({ message_id, label, job, said, conversation_id, files, agent_id }) => prepareProducedTask({
  key: `message:${message_id}${agent_id ? `:${agent_id}` : ''}`,
  source: { kind: 'message', ref: message_id },
  title: label,
  description: job,
  ...(agent_id ? { assignees: [agent_id] } : {}),
  source_task: message_id,
  input: {
    arrived: { message_id }, ...(said ? { said: said.slice(0, 300) } : {}),
    refs: { message_id, ...Object.fromEntries(files.map((identity, index) => [`file_${index + 1}`, identity])) },
    next_call: { tool: 'read_messages', arguments: { conversation_id } },
  },
});

// The files a message names, each checked to be one of the person's own (old src/send-to-all-ais.mjs ownFiles); throws the first that is not.
function ownFiles(owned, files) {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files) || files.some(file => typeof file?.identity !== 'string' || !file.identity.trim())) throw new Refused('files is a list of { identity }, each one of your files.');
  if (files.length > MOST_FILES) throw new Refused(`Send at most ${MOST_FILES} files in one message.`);
  const identities = [...new Set(files.map(file => file.identity.trim()))];
  if (!Array.isArray(owned)) throw new Refused('Files cannot be sent from here.');
  for (const identity of identities) {
    if (!owned.includes(identity)) throw new Refused(`${identity} is not one of your files.`, 403);
  }
  return identities;
}

// What `@` put in the message: each { kind, value, label } of a kind src/work-mentions.mjs admits, at most 20.
function mentionsOf(mentions) {
  if (mentions === undefined || mentions === null) return [];
  const shaped = Array.isArray(mentions) && mentions.every(one => mentionKind(one?.kind) && typeof one.value === 'string' && one.value.trim() && typeof one.label === 'string');
  if (!shaped) throw new Refused('mentions is a list of { kind, value, label }, each kind one @ offers.');
  if (mentions.length > MOST_MENTIONS) throw new Refused(`Mention at most ${MOST_MENTIONS} things in one message.`);
  return mentions.map(({ kind, value, label }) => ({ kind, value: value.trim(), label }));
}

// The thing a message is about and the piece of it, as kept in its `about`; none when the message names none.
function anchorOf(anchor) {
  if (anchor === undefined || anchor === null) return [];
  if (typeof anchor?.record !== 'string' || !anchor.record.trim() || anchor.record.length > 500) throw new Refused('anchor names the thing the words are about: { record, part? }.');
  let part;
  try { part = partFrom(anchor.part); } catch (error) { throw new Refused(error.message); }
  return [{ kind: 'record', id: anchor.record.trim(), ...(part ? { part } : {}) }];
}

function checked(body) {
  if (!object(body)) throw new Refused('Write a message and choose an AI.');
  const text = typeof body.text === 'string' ? body.text : '';
  if (text.length > MAX_TEXT) throw new Refused(`A message holds at most ${MAX_TEXT} characters; send a longer one in parts.`);
  if (body.client_id !== undefined && (typeof body.client_id !== 'string' || !body.client_id.trim() || body.client_id.length > 200))
    throw new Refused('client_id is the id the sender gave this message, so sending it again is the same message.');
  return { text, client_id: body.client_id };
}

function send(stored, body, now) {
  const { text, client_id } = checked(body);
  const app = nonempty(body.app) ? body.app.trim() : '';
  const conversation_id = nonempty(body.conversation_id) ? body.conversation_id.trim() : '';
  const agent_id = nonempty(body.agent_id) ? body.agent_id.trim() : '';
  const files = ownFiles(stored.file_identities, body.files);
  if (!app || !conversation_id || (!text.length && !files.length)) throw new Refused('Choose an AI and write a message.');
  const about = files.map(identity => ({ kind: 'file', id: identity }));
  const summary = `New message from you in ${app}.`;
  const taskOf = message_id => taskFor({ message_id, label: summary, job: summary, said: text, conversation_id, files, agent_id });
  const kept = keep(stored.records, { app, conversation_id, text, about, client_id }, now, message_id => (agent_id ? [taskOf(message_id)] : []));
  const delivery = { state: 'next_connection', message: `Saved. ${app} reads it the next time it connects to your Trillion.`,
    ...(agent_id ? { event_id: taskOf(kept.id).id } : {}) };
  return answer({ message_id: kept.id, recorded: kept.recorded, delivery }, 200, kept.keep);
}

function sendAll(stored, body, now) {
  const { text, client_id } = checked(body);
  const files = ownFiles(stored.file_identities, body.files);
  const named = mentionsOf(body.mentions);
  const pointed = anchorOf(body.anchor);
  const replyTo = body.reply_to;
  if (replyTo !== undefined && (typeof replyTo !== 'string' || !replyTo.trim() || replyTo.length > 500)) throw new Refused('Choose a comment to reply to.');
  if (!text.trim() && !files.length) throw new Refused('Write a message for your AIs.');
  const about = [...pointed, ...(replyTo ? [{ kind: 'message', id: replyTo.trim() }] : []), ...files.map(identity => ({ kind: 'file', id: identity })),
    ...named.map(one => ({ kind: mentionKind(one.kind).about, id: one.value }))];
  // Mentioning some of the person's AIs sends the message to those AIs only; otherwise any AI may take it.
  const addressed = [...new Set(named.filter(one => mentionKind(one.kind).wakes).map(one => one.value))];
  const summary = files.length ? `New message from you in Trillion, with ${files.length} ${files.length === 1 ? 'file' : 'files'}.` : 'New message from you in Trillion.';
  const tasks = message_id => (addressed.length ? addressed : [null]).map(agent_id => taskFor({
    message_id, label: summary, job: text.trim() ? text : files.join('\n'), said: text.trim() ? text : '', conversation_id: SHARED.conversation_id, files, agent_id }));
  const kept = keep(stored.records, { ...SHARED, text, about, client_id }, now, tasks);
  const handoff_id = tasks(kept.id)[0].id;
  return answer({ message_id: kept.id, handoff_id, recorded: kept.recorded, conversation_id: SHARED.conversation_id, files,
    delivery: addressed.map(agent_id => ({ agent_id, state: 'next_connection' })),
    message: `Saved for ${addressed.length ? `${addressed.length} of your ${addressed.length === 1 ? 'AI' : 'AIs'}` : 'your AIs'}. They read it the next time they connect to your Trillion.` }, 200, kept.keep);
}

// The person's own words in one message, corrected in place: the same row (same id, so every thread and reply that names
// it still finds it), its words replaced, and the words it had before kept in `corrected_from`, oldest first. The caller
// writes this one row over the one it has (`replaces`), in one update. Sending the same client_id again is the same
// correction, answered with `recorded: 0` and no row.
function correct(stored, body, now) {
  if (!object(body) || !nonempty(body.message_id)) throw new Refused('Choose a message to correct.');
  const { client_id } = checked({ text: body.text, client_id: body.client_id });
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw new Refused('A corrected message needs words.');
  const messageId = body.message_id.trim();
  const kept = (Array.isArray(stored.records) ? stored.records : []).find(one => one?.id === messageId && one.type === TYPE && object(one.value));
  if (!kept) throw new Refused('That message is not one of your messages.', 404);
  if (kept.value.speaker !== 'person') throw new Refused('Only your own words can be corrected here.', 403);
  if (client_id && kept.value.correction_client_id === client_id) return answer({ message_id: messageId, recorded: 0 });
  if (kept.value.text === text) return answer({ message_id: messageId, recorded: 0 });
  const at = new Date(now).toISOString();
  const value = { ...kept.value, text, corrected_at: at, corrected_from: [...(kept.value.corrected_from ?? []), kept.value.text],
    ...(client_id ? { correction_client_id: client_id } : {}) };
  return answer({ message_id: messageId, recorded: 1, corrected_at: at }, 200, [{ id: messageId, type: TYPE, value, replaces: true }]);
}

function threads(stored, query) {
  const wanted = Math.min(Math.max(Math.floor(Number(query.limit) || PAGE.default), 1), PAGE.max);
  const conversations = new Map();
  let last = null;
  let more = false;
  for (const record of newestOf(stored.records, TYPE, nonempty(query.before) ? query.before : null)) {
    const { app, conversation_id } = record.value;
    if (!nonempty(app) || !nonempty(conversation_id) || (nonempty(query.app) && app !== query.app)) continue;
    const key = canonical({ app, conversation_id });
    if (conversations.has(key)) continue;
    if (conversations.size === wanted) { more = true; break; }
    conversations.set(key, { id: `conversation:${digest({ app, conversation_id }, 24)}`, app, conversation_id, latest: { id: record.id, ...record.value } });
    last = record.id;
  }
  return answer({ conversations: [...conversations.values()], next_before: more ? last : null, backfill_pending: false });
}

function thread(stored, query) {
  if (!nonempty(query.app) || !nonempty(query.conversation_id)) return refuse('Choose a conversation to read.');
  const wanted = Math.min(Math.max(Math.floor(Number(query.limit) || PAGE.default), 1), PAGE.max);
  const found = [];
  let more = false;
  for (const record of newestOf(stored.records, TYPE, nonempty(query.before) ? query.before : null)) {
    if (record.value.app !== query.app || record.value.conversation_id !== query.conversation_id) continue;
    if (found.length === wanted) { more = true; break; }
    found.push({ id: record.id, ...record.value });
  }
  return answer({ messages: found, next_before: more ? found.at(-1).id : null });
}

/** The page's message route, answered over the rows the caller gave (stored) and the rows a send makes (keep). */
export async function answerTheMessageRoute(input = {}, { now = () => Date.now() } = {}) {
  const { path, method = 'GET', query, body } = input && typeof input === 'object' ? input : {};
  const asked = object(query) ? query : {};
  const stored = object(input?.stored) ? input.stored : {};
  try {
    if (method === 'GET' && (path === '/messages' || path === '/messages/threads')) return threads(stored, asked);
    if (method === 'GET' && path === '/messages/thread') return thread(stored, asked);
    if (method === 'POST' && path === '/messages/send') return send(stored, body, now());
    if (method === 'POST' && path === '/messages/send-all') return sendAll(stored, body, now());
    if (method === 'POST' && path === '/messages/correct') return correct(stored, body, now());
    return refuse('Not found', 404);
  } catch (error) {
    if (error instanceof Refused) return refuse(error.message, error.status);
    return refuse(String(error?.message ?? error), 500);
  }
}
