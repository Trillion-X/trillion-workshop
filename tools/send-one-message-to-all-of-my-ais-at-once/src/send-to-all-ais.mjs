// The one owner of "send this to all of my AIs": the web Home and Messages composers (/work/api/messages/send-all,
// the account resource's messages:request in src/native-message-account-owner.mjs), every AI app through the MCP tool send_to_all_ais (src/tools.mjs), which the iPhone
// Home composer calls too, and the Workshop tool tool:send-to-all-ais (records/workshop-account-tool-records.json,
// the account action 'send-to-all-ais' in src/person-store.mjs) that rules, schedules and run_tool reach. The message is kept once, word for word, in the shared Trillion conversation; then every
// AI on the account is woken with an event that points it at read_messages.
//
// `call(path, body)` reaches the person's store and returns its JSON answer, or throws (error.status when known).
// Files ride along by reference, never by bytes: each is one of the person's own files, named by its identity, which
// `locate(identity)` (the person's namespace) must find before anything is kept. The message links each in its
// `about`, and every AI's event carries each identity in its refs, so an AI reads the files from the person's Files.
// What the person mentioned with `@` (any kind src/work-mentions.mjs admits) is linked in `about` too; mentioning some
// of their AIs sends the message to those AIs only. `anchor` names the one thing the words are about, and the piece of
// it (src/responses.mjs: { record, part? }), as a comment on some words of any screen is sent: it is linked in `about`
// as { kind: 'record', id, part }, so every AI reads exactly what the person pointed at. `client_id` is the id the
// sender made for this message: it is the message's place (source_ref `client:<id>`), so the same id sent again (a
// connection that dropped after the send) is the message already kept, its handoff and every AI's event (all keyed by
// the message), while the same words under another id are a new message. Without one, the arrival-time guess of
// src/messages.mjs applies.

import { mentionKind } from './work-mentions.mjs';
import { partFrom } from '../../keep-and-wake-ai-sessions-on-this-computer/src/responses.mjs';

export const SHARED_CONVERSATION = 'trillion:shared';

const failure = (message, status) => Object.assign(new Error(message), { status });

// With no AI connected nothing is sent or kept; the answer says so and names the one next step (`next`, a button where
// the message was written). A caller with its own place to connect (a live showcase's visitor) passes `connect`.
export const NO_AI = { message: 'Your AI picks this up once it is connected to your Trillion.', next: { label: 'Connect your AI', href: '/ai' } };

// An event's refs hold at most 20 ids (src/agents.mjs idOnly), one of them the message's own.
export const MOST_FILES = 19;

// The files a message names, each checked to be one of the person's own; throws the first that is not.
export async function ownFiles(files, locate) {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files) || files.some(file => typeof file?.identity !== 'string' || !file.identity.trim())) throw failure('files is a list of { identity }, each one of your files.', 400);
  if (files.length > MOST_FILES) throw failure(`Send at most ${MOST_FILES} files in one message.`, 400);
  if (files.length && typeof locate !== 'function') throw failure('Files cannot be sent from here.', 400);
  const identities = [...new Set(files.map(file => file.identity.trim()))];
  for (const identity of identities) if (!(await locate(identity))) throw failure(`${identity} is not one of your files.`, 403);
  return identities;
}

// What `@` put in the message: each { kind, value, label } of a kind src/work-mentions.mjs admits, at most 20.
export const MOST_MENTIONS = 20;
function mentionsOf(mentions) {
  if (mentions === undefined || mentions === null) return [];
  const shaped = Array.isArray(mentions) && mentions.every(one => mentionKind(one?.kind) && typeof one.value === 'string' && one.value.trim() && typeof one.label === 'string');
  if (!shaped) throw failure('mentions is a list of { kind, value, label }, each kind one @ offers.', 400);
  if (mentions.length > MOST_MENTIONS) throw failure(`Mention at most ${MOST_MENTIONS} things in one message.`, 400);
  return mentions.map(({ kind, value, label }) => ({ kind, value: value.trim(), label }));
}

// The thing a message is about and the piece of it, as kept in its `about`; none when the message names none.
function anchorOf(anchor) {
  if (anchor === undefined || anchor === null) return [];
  if (typeof anchor?.record !== 'string' || !anchor.record.trim() || anchor.record.length > 500) throw failure('anchor names the thing the words are about: { record, part? }.', 400);
  let part;
  try { part = partFrom(anchor.part); } catch (error) { throw failure(error.message, 400); }
  return [{ kind: 'record', id: anchor.record.trim(), ...(part ? { part } : {}) }];
}

export async function sendToAllAis(call, text, { files, locate, mentions, anchor, reply_to: replyTo, client_id: clientId, connect = NO_AI } = {}) {
  const identities = await ownFiles(files, locate);
  const named = mentionsOf(mentions);
  const pointed = anchorOf(anchor);
  if (replyTo !== undefined && (typeof replyTo !== 'string' || !replyTo.trim() || replyTo.length > 500)) throw failure('Choose a comment to reply to.', 400);
  if (clientId !== undefined && (typeof clientId !== 'string' || !clientId.trim() || clientId.length > 200)) throw failure('client_id is the id the sender gave this message, so sending it again is the same message.', 400);
  if (typeof text !== 'string' || (!text.trim() && !identities.length)) throw failure('Write a message for your AIs.', 400);
  const found = await call('/agents/find', { all: true });
  const all = (found?.agents ?? []).filter(agent => typeof agent?.agent_id === 'string' && agent.agent_id.trim());
  if (!all.length) throw Object.assign(failure(connect.message, 409), { next: connect.next });
  // Mentioning some of the person's AIs sends the message to those AIs only; otherwise it goes to every AI.
  const addressed = new Set(named.filter(one => mentionKind(one.kind).wakes).map(one => one.value));
  const agents = addressed.size ? all.filter(agent => addressed.has(agent.agent_id)) : all;
  if (agents.length < addressed.size) throw failure('One of the AIs you mentioned is not connected to your account.', 400);
  // Kept as Trillion's own conversation whichever road it came by (the web page, the iPhone, an AI app, a rule).
  const about = [...pointed, ...(replyTo ? [{ kind: 'message', id: replyTo.trim() }] : []), ...identities.map(identity => ({ kind: 'file', id: identity })), ...named.map(one => ({ kind: mentionKind(one.kind).about, id: one.value }))];
  const kept = await call('/messages', { messages: [{ app: 'Trillion', conversation_id: SHARED_CONVERSATION, speaker: 'person', text, ...(about.length ? { about } : {}), ...(clientId ? { source_ref: `client:${clientId.trim()}` } : {}) }] });
  const message_id = kept?.ids?.[0];
  if (!message_id) throw failure('Your message could not be saved.', 502);
  // The message is also one job any of the AIs it went to may take (one AI it named takes it alone), so the box it was
  // sent from shows who took it and every step they take (src/workspace/job-run.tsx).
  const handed = await call('/handoffs', {
    job: text.trim() ? text : identities.join('\n'), ...(text.trim() ? { said: text.slice(0, 300) } : {}), once_per: message_id, input: { arrived: { message_id } },
    ...(kept.arrivals?.[0]?.decision_case_id ? { case_id: kept.arrivals[0].decision_case_id } : {}),
    ...(agents.length === 1 && addressed.size ? { to_agent: agents[0].agent_id } : {}),
  }).catch(() => null);
  const delivery = await Promise.all(agents.map(async agent => {
    try {
      const sent = await call('/agents/events', {
        type: 'message.created', to_agent: agent.agent_id, idempotency_key: message_id, subject_id: message_id,
        summary: identities.length ? `New message from you in Trillion, with ${identities.length} ${identities.length === 1 ? 'file' : 'files'}.` : 'New message from you in Trillion.',
        refs: { message_id, ...Object.fromEntries(identities.map((identity, index) => [`file_${index + 1}`, identity])) },
        next_call: { tool: 'read_messages', arguments: { conversation_id: SHARED_CONVERSATION } },
      });
      return { agent_id: agent.agent_id, name: agent.name, state: sent?.delivery?.state ?? 'waiting' };
    } catch {
      return { agent_id: agent.agent_id, name: agent.name, state: 'next_connection' };
    }
  }));
  return {
    message_id, handoff_id: handed?.handoff?.handoff_id ?? null, recorded: kept.recorded, conversation_id: SHARED_CONVERSATION, files: identities, delivery,
    message: `Saved for ${addressed.size ? agents.map(agent => agent.name).join(', ') : `${agents.length} ${agents.length === 1 ? 'AI' : 'AIs'}`}. Trillion has not confirmed that ${agents.length === 1 && addressed.size ? 'it' : 'they'} read it.`,
  };
}
