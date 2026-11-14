// tools/show-the-signed-in-persons-message-inbox-and-tell/src/message-route.mjs
//
// PURPOSE
//   The web chat's message routes as one Workshop route tool the engine runs for the page's account (workshop-routes):
//   GET /messages and GET /messages/threads (the conversations, newest first), GET /messages/thread (one conversation's
//   messages), POST /messages/send (the person's words to one AI) and POST /messages/send-all (the person's words to all
//   their AIs, kept in the shared Trillion conversation). Old trillion answered them in src/work-messages.mjs and
//   src/send-to-all-ais.mjs over the person store; here each message the person sends is one `message` row in the
//   person's own records, the same row the hooks keep for an AI's turns (trillion-rust src/account/hooks.json messages:
//   id `message:<at>:<24 hex of the BLAKE3 of the canonical {app, at, conversation_id, speaker, text}>`), so every AI
//   reads it with read_messages.
//
//   input  { path, method, query, body, browser }      output { status, body }
//
// NON-NEGOTIABLE INVARIANTS
//   1. A message sent from the page is kept word for word, once: the sender's `client_id` is its place (source_ref
//      `client:<id>`, kept by a `message-source-key` row as src/messages.mjs sourceKeyOf names it), so the same id sent
//      again is the message already kept and answers its id with `recorded: 0`.
//   2. Every write goes through the records door, conditional on what was read (the door refuses a changed record).
//   3. A read looks through at most SCAN messages, newest first, and answers what it found with `next_before`; no read
//      walks the whole history.
//   4. An AI is woken the way the person's AIs take work (a waiting ai-job row, which an AI lists when it connects), kept
//      in the same write as the message: send with an agent_id hands it to that AI, send-all to any AI or to the AIs
//      @-mentioned. Nothing here reaches an AI's live session, so the answer says the message is kept and read on the AI's
//      next connection, never that it was delivered. Files ride by reference: each is one of the person's own (find_file),
//      linked in the message's `about` and in the job's refs.
//
import { mentionKind } from '../../send-one-message-to-all-of-my-ais-at-once/src/work-mentions.mjs';
import { partFrom } from '../../keep-and-wake-ai-sessions-on-this-computer/src/responses.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const TYPE = 'message';
const SOURCE_KEY_TYPE = 'message-source-key';
const SHARED = { app: 'Trillion', conversation_id: 'trillion:shared' };
const MAX_TEXT = 200_000;
const SCAN = 1000;
const PAGE = { default: 20, max: 100 };
const SENT_VIA = 'Trillion';
const JOB_TYPE = 'ai-job';
// An event's refs hold at most 20 ids, one of them the message's own (old src/send-to-all-ais.mjs).
const MOST_FILES = 19;
const MOST_MENTIONS = 20;

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const canonical = value => JSON.stringify(value, (key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value, chars) => makeHashCodeHexFromBytes(new TextEncoder().encode(canonical(value))).slice(3, 3 + chars);
const idOf = message => `${TYPE}:${message.at}:${digest({ conversation_id: message.conversation_id, app: message.app, speaker: message.speaker, at: message.at, text: message.text }, 24)}`;
const sourceKeyOf = message => `${SOURCE_KEY_TYPE}:${digest({ app: message.app, conversation_id: message.conversation_id, source_ref: message.source_ref }, 32)}`;
const answer = (body, status = 200) => ({ status, body });
const refuse = (error, status = 400) => answer({ error }, status);

class Refused extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// The one message the person sent, kept once (invariant 1) with the jobs that hand it to the AIs it is for, in the same
// write, so a message is never kept without its jobs. Answers { id, recorded }.
async function keep(door, { app, conversation_id, text, about, client_id }, now, jobsOf = () => []) {
  const at = new Date(now).toISOString();
  const source_ref = client_id ? `client:${client_id.trim()}` : undefined;
  const message = { conversation_id, app, speaker: 'person', at, text, ...(about?.length ? { about } : {}), ...(source_ref ? { source_ref } : {}) };
  const sourceKey = source_ref ? sourceKeyOf(message) : null;
  if (sourceKey) {
    const kept = await door.readRecord(SOURCE_KEY_TYPE, sourceKey);
    if (kept?.value?.message_id) return { id: kept.value.message_id, recorded: 0 };
  }
  const id = idOf(message);
  const rows = [{ id, type: TYPE, value: { ...message, recorded_at: at, captured_road: 'signed-in screen', recorded_app: SENT_VIA }, expected: null }];
  if (sourceKey) rows.push({ id: sourceKey, type: SOURCE_KEY_TYPE, value: { message_id: id }, expected: null });
  for (const job of jobsOf(id)) rows.push({ id: job.id, type: JOB_TYPE, value: job.value, expected: null });
  await door.write(rows, { key: id });
  return { id, recorded: 1 };
}

// The job that is an AI's wake (old trillion's `message.created` event and hand-off): a waiting ai-job row, which an AI
// takes when it connects (its bootstrap lists waiting ai-jobs). `agent_id` names the one AI it is for; none, any AI may take it.
const jobFor = ({ message_id, label, job, said, conversation_id, files, agent_id }) => ({
  id: `${JOB_TYPE}:message:${message_id}${agent_id ? `:${agent_id}` : ''}`,
  value: {
    kind: JOB_TYPE, status: 'waiting', label, job, ...(said ? { said: said.slice(0, 300) } : {}),
    input: { arrived: { message_id } }, once_per: message_id, ...(agent_id ? { to_agent: agent_id } : {}),
    refs: { message_id, ...Object.fromEntries(files.map((identity, index) => [`file_${index + 1}`, identity])) },
    next_call: { tool: 'read_messages', arguments: { conversation_id } },
  },
});

// The files a message names, each checked to be one of the person's own (old src/send-to-all-ais.mjs ownFiles); throws the first that is not.
async function ownFiles(door, files) {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files) || files.some(file => typeof file?.identity !== 'string' || !file.identity.trim())) throw new Refused('files is a list of { identity }, each one of your files.');
  if (files.length > MOST_FILES) throw new Refused(`Send at most ${MOST_FILES} files in one message.`);
  const identities = [...new Set(files.map(file => file.identity.trim()))];
  for (const identity of identities) {
    try { await door.files('find_file', { name_or_identity: identity }); }
    catch (error) {
      if (error?.code === 'no_files') throw new Refused('Files cannot be sent from here.');
      throw new Refused(`${identity} is not one of your files.`, 403);
    }
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

async function send(door, body, now) {
  const { text, client_id } = checked(body);
  const app = nonempty(body.app) ? body.app.trim() : '';
  const conversation_id = nonempty(body.conversation_id) ? body.conversation_id.trim() : '';
  const agent_id = nonempty(body.agent_id) ? body.agent_id.trim() : '';
  const files = await ownFiles(door, body.files);
  if (!app || !conversation_id || (!text.length && !files.length)) throw new Refused('Choose an AI and write a message.');
  const about = files.map(identity => ({ kind: 'file', id: identity }));
  const summary = `New message from you in ${app}.`;
  let job = null;
  const kept = await keep(door, { app, conversation_id, text, about, client_id }, now, message_id => {
    if (!agent_id) return [];
    job = jobFor({ message_id, label: summary, job: summary, said: text, conversation_id, files, agent_id });
    return [job];
  });
  const delivery = { state: 'next_connection', message: `Saved. ${app} reads it the next time it connects to your Trillion.`,
    ...(agent_id ? { event_id: kept.recorded ? job.id : `${JOB_TYPE}:message:${kept.id}:${agent_id}` } : {}) };
  return answer({ message_id: kept.id, recorded: kept.recorded, delivery });
}

async function sendAll(door, body, now) {
  const { text, client_id } = checked(body);
  const files = await ownFiles(door, body.files);
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
  const jobs = message_id => (addressed.length ? addressed : [null]).map(agent_id => jobFor({
    message_id, label: summary, job: text.trim() ? text : files.join('\n'), said: text.trim() ? text : '', conversation_id: SHARED.conversation_id, files, agent_id }));
  const kept = await keep(door, { ...SHARED, text, about, client_id }, now, jobs);
  const handoff_id = jobs(kept.id)[0].id;
  return answer({ message_id: kept.id, handoff_id, recorded: kept.recorded, conversation_id: SHARED.conversation_id, files,
    delivery: addressed.map(agent_id => ({ agent_id, state: 'next_connection' })),
    message: `Saved for ${addressed.length ? `${addressed.length} of your ${addressed.length === 1 ? 'AI' : 'AIs'}` : 'your AIs'}. They read it the next time they connect to your Trillion.` });
}

// The newest messages, at most SCAN of them, older than `before` (a message id), as the door lists them.
async function* newest(door, before) {
  let looked = 0;
  for await (const record of door.list({ type: TYPE, reverse: true, ...(before ? { below: before } : {}) })) {
    if (looked++ >= SCAN) return;
    if (record?.value) yield record;
  }
}

async function threads(door, query) {
  const wanted = Math.min(Math.max(Math.floor(Number(query.limit) || PAGE.default), 1), PAGE.max);
  const conversations = new Map();
  let last = null;
  let more = false;
  for await (const record of newest(door, nonempty(query.before) ? query.before : null)) {
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

async function thread(door, query) {
  if (!nonempty(query.app) || !nonempty(query.conversation_id)) return refuse('Choose a conversation to read.');
  const wanted = Math.min(Math.max(Math.floor(Number(query.limit) || PAGE.default), 1), PAGE.max);
  const found = [];
  let last = null;
  let more = false;
  for await (const record of newest(door, nonempty(query.before) ? query.before : null)) {
    last = record.id;
    if (record.value.app !== query.app || record.value.conversation_id !== query.conversation_id) continue;
    if (found.length === wanted) { more = true; break; }
    found.push({ id: record.id, ...record.value });
  }
  return answer({ messages: found, next_before: more ? found.at(-1).id : null });
}

/** The page's message route, answered over the person's own records. */
export async function answerTheMessageRoute(input, { door, now = () => Date.now() }) {
  const { path, method = 'GET', query, body } = input && typeof input === 'object' ? input : {};
  const asked = object(query) ? query : {};
  try {
    if (method === 'GET' && (path === '/messages' || path === '/messages/threads')) return await threads(door, asked);
    if (method === 'GET' && path === '/messages/thread') return await thread(door, asked);
    if (method === 'POST' && path === '/messages/send') return await send(door, body, now());
    if (method === 'POST' && path === '/messages/send-all') return await sendAll(door, body, now());
    return refuse('Not found', 404);
  } catch (error) {
    if (error instanceof Refused) return refuse(error.message, error.status);
    return refuse(String(error?.message ?? error), 500);
  }
}
