import { writeClassOf } from './tool-write-class.mjs';
import {aiProjectionOf,aiSpaceProjectionQueue,initAiSpaceProjectionQueue} from './ai-space-projection.mjs';
// One person's side of spaces (src/spaces.mjs), inside their own store: which spaces they are in, what is
// there, and the one road by which anything of theirs reaches a space, an explicit share of one record.
//
//   GET  /spaces?archived                        the spaces this person is in (only those the caller may reach), each
//                                                with description, picture, member names, item counts, unread, last activity;
//                                                the ones they archived are left out, and archived=true lists only those
//                                                (each with archived_at)
//   POST /spaces/<id>/archive                    { archived }   hide a space from this person's own lists of spaces, or put
//                                                it back (archived false): { space_id, archived, archived_at }
//   POST /spaces                                 { title, label?, members? }   start a space with this person as its owner
//                                                (label "project" unless given; the same createMembership every road
//                                                uses) and invite each of members ({ name?, email?, phone? }) as
//                                                invite-person does: { space_id, invited: [...] }
//   GET  /spaces/<id>                            one space: the same, plus members by the name they show there and agents
//   GET  /spaces/<id>/board-member               who you are on the space's board: { space_id, relay, name, may_change } (src/board-members.mjs)
//   POST /spaces/<id>/seen                       the person has seen everything there: unread starts again from now
//   POST /spaces/<id>/about                      { description?, picture?, colour? }   picture: one of their files (name or identity); colour: an id of space-settings.json colours
//   GET  /spaces/<id>/picture                    where to read the space's picture's bytes, as for a shared file
//   POST /spaces/<id>/invites                    { days?, email?, phone? }   a one-time invite link: { invite_id, url,
//                                                expires_at }; with an address it also reaches that person once
//                                                their account proves it (nothing is sent)
//   GET  /spaces/<id>/invites                    the invite links this person made there, and what became of each
//   POST /spaces/<id>/invites/revoke             { invite_id }
//   POST /spaces/<id>/invite-person              { name?, email?, phone?, text_through?, days?, member_type? }   make an invite link for
//                                                one person and send it: the email through the one mail sender, the
//                                                text through their connected account (src/space-invitation.mjs)
//   GET  /spaces/join/<code>                     what an invite link opens: the space's name, words and size
//   GET  /spaces/join/<code>/preview             what the invite link's own page shows: its state, who made it, the space
//   POST /spaces/join/<code>                     join the space with it
//   GET  /spaces/<id>/items?kind&before&limit    items, newest first, each with its provenance
//   GET  /spaces/<id>/responses?record&part&before&limit    replies on an exact part; all_parts=true instead reads
//                                                bounded pages of replies across every part of one record
//   POST /spaces/<id>/items                      { items: [{ kind, body, title?, about?, reply_to?, part? }] }   made in the space;
//                                                part: the piece of what it replies to that it is about (src/responses.mjs)
//   POST /spaces/<id>/items/<item>/react         { symbol?, glyph?, on? }   a reaction on one thing: a palette symbol, or
//                                                the person's own emoji or https picture as glyph; on false takes it back
//   POST /spaces/<id>/share                      { record_id } | { file } for one private record;
//                                                { records?, items?, request_key? } for one bounded mixed selection
//   GET  /spaces/shareable?kind&after             the person's own things a share may copy in, one page (src/space-shareable.mjs)
//   POST /spaces/briefs                          { space_id?, when }   what an AI is handed in a space (src/space-brief.mjs)
//   POST /spaces/<id>/withdraw                   { item_id }                                   when the space's rules let you
//   POST /spaces/<id>/fill                       { item_id, title?, body }                     complete a thing you made there
//   POST /spaces/<id>/hide                       { item_id, hidden }                           hide a thing, or show it again
//   GET  /spaces/<id>/rules                      who can do what here, the member types, may_change
//   POST /spaces/<id>/rules                      { rules | null }   replace them; refused with { error, problems }
//   POST /spaces/<id>/members/type               { member_id, member_type }                    give a member a type
//   POST /spaces/<id>/members-are                { members_are }                               who its people are (src/space-membership-kinds.json)
//   POST /spaces/<id>/members/remove             { member_id }                                 take a member out
//   POST /spaces/<id>/member-types               { label }        add the space's own type
//   POST /spaces/<id>/member-types/remove        { member_type }  remove one of its own types
//   POST /spaces/<id>/name                       { name }                                      the name you show there
//   GET  /spaces/<id>/items/<item>/file          where to read a shared file's bytes
//   POST /spaces/<id>/import                     { conversation, attachments?, attachments_folder? } one chat archive
//   POST /spaces/<id>/agents/(publish|withdraw|capacity|find), /spaces/<id>/handoffs(/take|/finish|/read)
//   GET  /spaces/<id>/tools/added                the tools added to the space, each with its name and words from the
//                                                reader's own Marketplace (addedTools), whoever may add or remove them
//   POST /spaces/<id>/tools/grant                { tool_id, member_id?, operations? }   add any published tool; member_id
//                                                "*" adds it for everyone in the space, now and later
//   GET  /spaces/<id>/tools/impact?tool_id=&member_id=&operations=   what adding the tool would give each member (src/access-impact.mjs)
//   POST /spaces/<id>/tools/remove               { tool_id }   take a tool out of the space for everyone
//
// A space is the room of one of the person's pursuits (src/pursuit-rooms.mjs): every room route here also takes the
// pursuit's own id (`pursuit:...`), which opens its room and makes it the first time; GET /spaces lists the rooms of
// the person's pursuits, each with its pursuit_id; archiving a room archives its pursuit, the one place a person's
// archive is kept (the rooms of archived pursuits leave the new-things badge, src/person-store.mjs newWork).
// Membership, the room's rules, its items and what other members see do not change.
//
// Reach: the Worker sets x-trillion-reach from the key or app sign-in that made the request, never from the caller:
// { private, spaces: "all" | [space ids] }. A space outside it reads exactly like one the person is not in.
//
// Sharing copies one record, cut to the fields src/space-settings.json lets out for its kind; a kind not named there
// cannot be shared. Nothing is copied on leaving, on withdrawing, or at any other time.
import settings from './space-settings.json' with { type: 'json' };
import { EXECUTION_HEADER, completeExecutionCapture, providerObservation } from './execution-context.mjs';
import { recordSent } from './sent.mjs';
import { decideExternalEffectAttempt, recordExternalEffectResult } from '../parts/service-connections/do-work/external-effect-attempt.ts';
import { ruleProblems } from './space-permissions.mjs';
import { looksLikeSpaceId } from './space-names.mjs';
import { sendInvitation } from './space-invitation.mjs';
import { sendMail } from './mail-sender.mjs';
import { scopedRequestKey, workshopToolVersion } from './workshop.mjs';
import { readBoundedJson } from './read-bounded-json.mjs';
import { checkOutboundRecipient } from './outbound-recipient.mjs';
import { relate } from './record-model-tools.mjs';
import { failureOf } from './failure.mjs';
import { sharedPreviewItems } from './shared-record-preview.mjs';
import { sameSharedRecord } from './shared-record-references.mjs';
import { shareablePage } from './space-shareable.mjs';
import { accessImpact } from './access-impact.mjs';
import accessImpactData from './access-impact.json' with { type: 'json' };

const json = (value, status = 200) => Response.json(value, { status });
// A fault in the code (these are the kinds an engine throws for one, and they keep their kind across a call between
// stores) is never answered as a refusal: a screen reads a refusal as "you are not in this space", so a fault read that
// way tells a member they are not in a space they are in. It is answered as a failure to try again.
const FAULTS = [TypeError, ReferenceError, RangeError, SyntaxError, EvalError, URIError];
const FAILED = 'Trillion hit a problem on its side while reading this pursuit; your place in it did not change. Try again in a moment.';
const FULL_REACH = { private: true, spaces: 'all' };

/** A person's own list of rooms (src/person-store.mjs mixes these in): the rooms of their pursuits. */
export const personSpaceMethods = {
  // Every one of the person's current pursuits (archived true: their archived ones), in the list's own order. A pursuit
  // shared with people carries its room's facts; one only the person has is addressed by its pursuit id, which every
  // room route takes (its room is made the first time it is shared, written in or opened), so the list never splits
  // into pursuits with people and pursuits without.
  async listedSpaces({ archived = false, reach = FULL_REACH } = {}) {
    // A sign-in reaching no private data and no rooms has no source to list.
    // Decide this before room discovery, pursuit hydration or reconciliation.
    if (!reach.private && reach.spaces !== 'all' && !reach.spaces?.length) return [];
    const rooms = new Map((await this.roomsOfThisPerson()).map(room => [room.space_id, room]));
    return (await this.pursuitList({ archived })).map(item => {
      const room = item.space_id ? rooms.get(item.space_id) : null;
      const kept = room
        ? { ...room, title: item.title }
        : { space_id: item.id, label: null, title: item.title, description: item.after ?? null, picture: null, colour: null, member_names: [], members: 1, others: [], items: 0, items_by_kind: {}, unread: 0, last_activity_at: item.changed_at ?? item.recorded_at ?? null };
      return { ...kept, pursuit_id: item.id, depth: item.depth ?? 0, ...(archived ? { archived_at: item.archived_at ?? null } : {}) };
    });
  },
};

export const isSpacesPath = path => path === '/spaces' || path.startsWith('/spaces/');

/** The reach a request carries (x-trillion-reach, set by the Worker); a request with none is the account itself. */
export function reachOf(request) {
  const raw = request.headers.get('x-trillion-reach');
  if (!raw) return FULL_REACH;
  try {
    const reach = JSON.parse(raw);
    return { private: reach.private === true, spaces: reach.spaces === 'all' ? 'all' : Array.isArray(reach.spaces) ? reach.spaces.map(String) : [] };
  } catch { return { private: false, spaces: [] }; }
}
export const reaches = (reach, spaceId) => reach.spaces === 'all' || reach.spaces.includes(spaceId);

// Where a shared file's bytes are read, asked of the store of the member who shared it.
const fileAddress = (person, { person_ref: personRef, identity }, grant) => typeof person.readSpaceFile === 'function'
  ? person.readSpaceFile({ ...grant, identity, person_ref: personRef })
  : person.env.PERSON.get(person.env.PERSON.idFromString(personRef)).sharedFileAddress(identity, grant);
const fileTranscript = async (person, { person_ref: personRef, identity }, grant) => {
  const answer = typeof person.readSpaceFile === 'function'
    ? await person.readSpaceFile({ ...grant, identity, person_ref: personRef, part: 'transcript' })
    : await person.env.PERSON.get(person.env.PERSON.idFromString(personRef)).sharedFileTranscript(identity, grant);
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
  if (answer?.busy) return Response.json({ error: 'The words are busy. Try again in a second.' }, {
    status: 429, headers: { ...headers, 'retry-after': String(answer.retry_after_seconds ?? 1) },
  });
  return typeof person.readSpaceFile === 'function' ? Response.json(answer, { headers }) : new Response(answer, { headers });
};

/** The tools added to one space (src/spaces.mjs spaceAddedTools), each named and described from the reader's own
 *  Marketplace read of it; a tool that cannot be read there (withdrawn, or not reachable) keeps its id as its name. */
const GONE_TOOL = 'A tool that is no longer in the Marketplace';
export async function addedTools(person, relay, spaceId) {
  const added = await person.network().spaceAddedTools({ relay, space_id: spaceId });
  const tools = await Promise.all(added.tools.map(async tool => {
    const descriptor = await person.workshop().describe({ tool_id: tool.tool_id }).then(found => found.descriptor, error => {
      // A failed Marketplace read is not evidence that this installed tool was removed.
      if (failureOf(error).tries_again_later) throw error;
      return null;
    });
    // A tool whose description can no longer be read (taken out of the Marketplace) is named in words, never by its id;
    // it stays listed so whoever started the space can take it out, and it is never a place (community-places.ts).
    return { ...tool, label: descriptor?.label ?? GONE_TOOL, about: descriptor?.description ?? descriptor?.job ?? null, icon: descriptor?.space_capability?.icon ?? descriptor?.screen?.icon ?? null, readable: Boolean(descriptor) };
  }));
  return { ...added, tools };
}

const pick = (value, path) => path.reduce((at, key) => (at && typeof at === 'object' ? at[key] : undefined), value);

/** One private record cut to what its kind lets out, less the fields its owner leaves out (`leave_out`), with each
 *  field it shares to match only (`match_only`) as `match(field, value)` gives it (src/share-match.mjs: a keyed mark,
 *  never the value), or an error naming why it cannot be shared. The sharing sheet's preview is this same copy
 *  (src/record-sharing.mjs). */
export function shareableCopy(type, id, value, { leave_out: leaveOut = [], match_only: matchOnly = [], match } = {}) {
  const rule = settings.share_from_private[type];
  if (!rule) throw new Error(`A ${type ?? 'record'} cannot be shared into a space. What can: ${Object.keys(settings.share_from_private).join(', ')}, and files.`);
  const project = (given, nested) => {
    if (nested?.items && Array.isArray(given)) return given.map(item => project(item, nested.items));
    if (!nested?.fields || !given || typeof given !== 'object' || Array.isArray(given)) return given;
    return Object.fromEntries(nested.fields.filter(field => given[field] !== undefined).map(field => [field, project(given[field], nested.nested?.[field])]));
  };
  if (matchOnly.some(field => rule.fields.includes(field) && value[field] !== undefined && !leaveOut.includes(field)) && typeof match !== 'function') {
    throw new Error('Sharing a field to match only is not set up, so it was not shared.');
  }
  const body = Object.fromEntries(rule.fields.filter(field => value[field] !== undefined && !leaveOut.includes(field))
    .map(field => [field, matchOnly.includes(field) ? match(field, value[field]) : project(value[field], rule.nested?.[field])]));
  // The preview title is another copy of its source field. A hidden or match-only field cannot reappear there.
  const title = leaveOut.includes(rule.title?.[0]) || matchOnly.includes(rule.title?.[0]) ? null : pick(value, rule.title);
  return { kind: type, private_ref: id, title: typeof title === 'string' ? title.slice(0, 300) : null, body };
}

// The invite link for a code, on the address the request came in on (src/space-settings.json invites.join_address).
const inviteLink = (origin, code) => {
  if (!origin) throw new Error('An invite link needs the address this service answers on.');
  const link = new URL(settings.invites.join_address.path, origin);
  link.searchParams.set(settings.invites.join_address.code_parameter, code);
  return link.toString();
};
// A code as given: the code itself, or the whole invite link it is in.
const codeOf = given => {
  const raw = String(given ?? '').trim();
  try { return new URL(raw).searchParams.get(settings.invites.join_address.code_parameter) ?? raw; } catch { return raw; }
};

// A member's AI put to work in a space is one of their AIs (src/ais.mjs). What the space shows of it (its name, what it
// can do, whether it is working) is its ai record's, never words the publisher sends, and it is pushed again whenever
// that record changes (pushAiToSpaces). The space keeps only the role and capacity it was given. Which spaces an AI is
// in is a relation in the member's own store (ai:<key> "in space" space:<id>), so the push reads no other store.
export {aiProjectionOf,AI_SPACE_PROJECTION_TABLE,initAiSpaceProjectionQueue,aiSpaceProjectionQueue} from './ai-space-projection.mjs';
const IN_SPACE = 'in space';

async function publishFromAi(person, network, at, body) {
  const ais = person.aisOf();
  const key = String(body.ai ?? body.agent_id ?? body.name ?? '').trim().replace(/^ai:/, '');
  if (!key) throw new Error('Name the AI to put to work here: ai (one of your AIs) or agent_id.');
  let ai = ais.get(key);
  // An AI not on the list yet is put on it first, from what it published, so the list stays the one source.
  if (!ai) {
    // Putting an AI to work here names it: it is put on the list under that name, never folded as one chat of another.
    ais.upsert({ key, label: body.name ?? key, live: { seen_at: new Date().toISOString(), how: 'heartbeat', trouble: null } }, { actor: { by: 'space-publish' } });
    ai = ais.get(key);
  }
  if (!ai) throw new Error('That AI could not be put on your list of AIs.');
  const { name: _name, can: _can, live: _live, ai_id: _aiId, ...rest } = body;
  const agent_id = ai.id.slice(ai.id.indexOf(':') + 1);
  const answer = await network.spaceAgents({ ...at, verb: 'publish', input: { ...rest, agent_id, name: ai.label } });
  // A card keeps only what publishing reads; the rest of what the space shows of the AI is pushed as for any change.
  await network.spaceAgents({ ...at, verb: 'project', input: { agent_id, ...aiProjectionOf(ai) } });
  relate(person.store.eeaf, { relations: [{ subject: ai.id, role: IN_SPACE, object: `space:${at.space_id}` }] }, { actor: { by: 'space-publish' } });
  return answer;
}

/** Pushes what spaces show of one AI from its ai record to every space it was put to work in; the space ids pushed. */
export async function pushAiToSpaces(person, ai) {
  const ids = [];
  let after = null;
  do {
    const page = person.store.eeaf.holdersOf(ai.id, { role: 'subject', ...(after ? { after } : {}), limit: 25 });
    const holders = page.holders ?? [];
    for (const holder of holders) {
      const relation = person.store.eeaf.read(holder.id);
      if (relation?.type !== 'relation' && holder.type !== 'relation') continue;
      if (relation?.role !== IN_SPACE || !String(relation.object).startsWith('space:')) continue;
      const space_id = relation.object.slice('space:'.length);
      await person.network().spaceAgents({ relay: person.relay(), space_id, verb: 'project', input: { agent_id: ai.id.slice(ai.id.indexOf(':') + 1), ...aiProjectionOf(ai) } });
      ids.push(space_id);
    }
    after = page.next ?? page.next_after ?? (holders.length === 25 ? holders.at(-1)?.id ?? null : null);
  } while (after);
  return ids;
}

async function withdrawAiFromSpace(person, spaceId, agentId) {
  const answer = await person.network().spaceAgents({ relay: person.relay(), space_id: spaceId, verb: 'withdraw', input: { agent_id: agentId } });
  const key = String(agentId ?? '').trim().replace(/^ai:/, '');
  if (key) {
    const aiId = `ai:${key.toLowerCase()}`;
    const records = person.store.eeaf;
    let after = null;
    while (true) {
      const page = records.holdersOf(aiId, { role: 'subject', ...(after ? { after } : {}), limit: 25 });
      const holder = (page.holders ?? []).find(item => {
        const relation = records.read(item.id);
        return relation?.role === IN_SPACE && relation.object === `space:${spaceId}`;
      });
      if (holder) { records.write([{ id: holder.id, type: 'relation', value: null }], { actor: { by: 'space-withdraw' } }); break; }
      const nextAfter = page.next ?? page.next_after ?? ((page.holders?.length ?? 0) === 25 ? page.holders.at(-1)?.id ?? null : null);
      if (!nextAfter) break;
      after = nextAfter;
    }
  }
  return answer;
}

export async function handleSpacesRequest(person, request) {
  try {
    const url = new URL(request.url);
    const reach = reachOf(request);
    const network = person.network();
    const relay = person.relay();
    const parts = url.pathname.split('/').slice(2).map(decodeURIComponent);
    // A space may be named by its name as well as its id (src/space-names.mjs); an id is used as it is.
    // A room is named by its id, its pursuit's id (which makes the room the first time), or its name.
    const snapshotting = request.method === 'POST' && parts.length === 3 && parts[1] === 'workshop' && parts[2] === 'snapshot';
    const spaceIdOf = async given => {
      if (String(given ?? '').startsWith('pursuit:')) {
        if (!snapshotting) return (await person.pursuitRoom(given, { reach })).space_id;
        // A diagnostic read may use an existing room, but must never create or reconcile one.
        const saved = (await person.engine.allPursuits()).find(item => item.id === given && item.status !== 'ended');
        if (!saved?.space_id) throw new Error('This pursuit has no saved room to inspect.');
        return saved.space_id;
      }
      return looksLikeSpaceId(given) ? given : (await network.spaceNamed({ relay, name: given, within: reach.spaces })).space_id;
    };
    const body = request.method === 'GET' ? {} : request.method === 'POST' && parts.length === 2 && parts[1] === 'share'
      ? await readBoundedJson(request, 2_000_000, new Error('Share request is too large. Send fewer items at once.'))
      : await request.json().catch(() => ({}));
    // One person invited into a space and told, by email and by text (src/space-invitation.mjs sendInvitation).
    const invitePerson = (at, invite) => {
      const origin = request.headers.get('x-trillion-origin');
      return sendInvitation({
        invite, origin,
        makeLink: async (days, addressed) => { const { code, ...made } = await network.makeSpaceInvite({ ...at, days, addressed, ...(invite.member_type ? { member_type: String(invite.member_type) } : {}) }); return { ...made, code, url: inviteLink(origin, code) }; },
        preview: code => network.invitePreview({ relay, code }),
        mail: async (message, sender, { invite_id }) => {
          const parent = person.executionOf?.(request);
          const source = await person.beginExecution?.({ operation: 'space_invitation_email', capture_kind: 'internal_dispatch',
            ...(parent?.call_id ? { parent_call_id: parent.call_id } : {}), claimed: parent?.claimed ?? {} },
            parent?.recorder ?? { reader: request.headers.get('x-trillion-reader'), app: request.headers.get('x-trillion-app') });
          const ref = `invite:${invite_id}:email`;
          const prior = person.workshopValue?.(`effect:${ref}`);
          const decision = decideExternalEffectAttempt({ effectRef: ref, actionRef: 'space_invitation_email',
            authorizationRef: ref, executionRef: source?.execution_ref, prior });
          if (!decision.dispatch) {
            if (source) person.finishExecution(source.execution_ref, { phase: 'failed', error_code: 'already_dispatched', links: { effect_ref: ref } });
            return { sent: false, effect: decision.attempt, execution_ref: decision.attempt.execution_ref ?? null, error: 'This invitation may already have been sent. Read its receipt without sending it again.' };
          }
          await person.addWorkshopValue?.(`effect:${ref}`, decision.attempt);
          let sent;
          try { sent = await sendMail(person.env, sender, message); }
          catch (error) {
            person.addWorkshopValue?.(`effect:${ref}`, recordExternalEffectResult(decision.attempt, { outcome: 'timeout-after-dispatch' }));
            if (source) person.finishExecution(source.execution_ref, { phase: 'unknown', links: { effect_ref: ref, record_ref: invite_id } });
            throw error;
          }
          let observation = null;
          let source_capture = null;
          const finalize = async finish => {
            const captured = await completeExecutionCapture(source?.execution_ref ?? null, null, finish);
            if (captured.source_capture) source_capture = { ...captured.source_capture, effect_ref: ref };
          };
          await finalize(async () => {
            observation = providerObservation({ provider: sent.rendered?.provider, object_id: sent.id, route: 'space_invitation_email' },
              { basis: 'provider_response', origin: sent.kept_for_proof ? 'synthetic' : sent.sent ? 'real' : 'unknown' });
            const effect = recordExternalEffectResult(decision.attempt, { outcome: sent.sent ? 'succeeded' : sent.unknown ? 'timeout-after-dispatch' : 'rejected-before-dispatch', remoteEffectRef: sent.id ?? undefined, observation });
            await person.addWorkshopValue?.(`effect:${ref}`, effect);
          });
          let sent_ref = null;
          if (source && sent.sent) {
            await finalize(() => {
              const kept = recordSent(person.store.eeaf, { id: source.call_id, kind: 'email', to: message.to, subject: message.subject,
                body_markdown: sent.rendered?.text ?? '', body_text: sent.rendered?.text, body_html: sent.rendered?.html,
                from: sent.rendered?.from, reply_to: sent.rendered?.reply_to, provider: sent.rendered?.provider, provider_id: sent.id,
                execution_ref: source.execution_ref, effect_ref: ref, observation, origin: observation?.origin,
                by: { tool_id: 'space_invitation_email', app: source.recorder?.app } });
              sent_ref = `record:sent:${kept.id}`;
            });
          }
          if (source) await finalize(() => person.finishExecution(source.execution_ref, { phase: sent.sent ? 'returned' : sent.unknown ? 'unknown' : 'failed', observation,
            links: { effect_ref: ref, record_ref: invite_id, ...(sent_ref ? { sent_ref } : {}) } }));
          if (parent && sent_ref) await finalize(() => person.finishExecution(parent.execution_ref, { links: { record_refs: [source.execution_ref, sent_ref] } }));
          return { ...sent, execution_ref: source?.execution_ref ?? null, sent_ref, ...(source_capture ? { source_capture } : {}) };
        },
        verifyRecipient: input => checkOutboundRecipient(person.store.eeaf, input),
        runTool: async ({ tool_id: toolId, input, key }) => {
          if (!reach.private) return { ok: false, error: 'This sign-in reaches only this pursuit, so it cannot use a private texting account.' };
          const answer = await person.fetch(new Request('https://person/tools/run', { method: 'POST', headers: { 'content-type': 'application/json', ...(request.headers.get(EXECUTION_HEADER) ? { [EXECUTION_HEADER]: request.headers.get(EXECUTION_HEADER) } : {}), ...(request.headers.get('x-trillion-reader') ? { 'x-trillion-reader': request.headers.get('x-trillion-reader') } : {}), ...(request.headers.get('x-trillion-app') ? { 'x-trillion-app': request.headers.get('x-trillion-app') } : {}) }, body: JSON.stringify({ tool_id: toolId, input, request_key: key, wait_seconds: 20 }) }));
          const reply = await answer.json().catch(() => ({}));
          return { ok: Boolean(answer.ok && reply.state === 'completed' && !reply.error), task_id: reply.task_id ?? null, execution_ref: reply.execution_ref ?? null, source_capture: reply.source_capture ?? null, effect: reply.effect ?? null, error: reply.error ?? null };
        },
      });
    };
    if (!parts.length) {
      if (request.method === 'POST') {
        // A new space belongs to no list of spaces a narrower sign-in was given, so only one reaching every space starts one.
        if (reach.spaces !== 'all') throw new Error('This sign-in reaches only the pursuits it was given, so it cannot start another.');
        const members = Array.isArray(body.members) ? body.members : [];
        const { membership_id: spaceId } = await network.createMembership({ relay, person_ref: person.ctx.id.toString(), label: body.label ?? 'project', title: body.title, ...(body.members_are !== undefined ? { config: { members_are: body.members_are } } : {}) });
        // It is one of the person's pursuits from the moment it exists (src/pursuit-rooms.mjs invariant 1).
        person.forgetRooms();
        const pursuit = await person.pursuitOfRoom(spaceId);
        const invited = [];
        for (const member of members) invited.push(await invitePerson({ relay, space_id: spaceId }, member ?? {}));
        return json({ space_id: spaceId, pursuit_id: pursuit?.id ?? null, invited });
      }
      if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
      const spaces = await person.listedSpaces({ archived: url.searchParams.get('archived') === 'true', reach });
      return json({ spaces: spaces.filter(space => reaches(reach, space.space_id)) });
    }
    // An invite link lets the person into a space they are not in yet, so only a sign-in reaching every space follows it.
    if (parts[0] === 'join' && parts.length === 2) {
      if (reach.spaces !== 'all') throw new Error('This sign-in reaches only the pursuits it was given, so it cannot join another.');
      if (request.method === 'GET') return json(await network.spaceInvite({ relay, code: codeOf(parts[1]) }));
      if (request.method === 'POST') return json(await network.joinWithInvite({ relay, person_ref: person.ctx.id.toString(), code: codeOf(parts[1]) }));
    }
    if (parts[0] === 'join' && parts.length === 3 && parts[2] === 'preview' && request.method === 'GET') return json(await network.invitePreview({ relay, person_ref: person.ctx.id.toString(), code: codeOf(parts[1]) }));
    // Invitations into a space waiting for this person's answer, and the answer. Answering is part of opening the space it
    // invites to (the notice's Accept and Decline, src/person-notifications.json), so it is not the paid Network screen's
    // route, and like following an invite link it needs a sign-in reaching every space.
    if (parts[0] === 'invitations' && (parts.length === 1 && request.method === 'GET' || parts.length === 2 && parts[1] === 'answer' && request.method === 'POST')) {
      if (reach.spaces !== 'all') throw new Error('This sign-in reaches only the pursuits it was given, so it cannot answer an invitation into another.');
      if (parts.length === 2) return json(await network.answer({ relay, request_id: String(body.request_id ?? ''), accept: body.accept === true }));
      // Reading them is where an invitation's address is learnt, so from then on an invitation to it reaches this person.
      await network.remember(relay, person.ctx.id.toString());
      const { incoming = [] } = await network.inbox(relay);
      return json({ invitations: incoming.filter(item => item.invites_to).map(item => ({ request_id: item.request_id, why: item.why ?? null, asked_at: item.asked_at,
        space: { title: item.invites_to.title, label: item.invites_to.label } })) });
    }
    // The person's own things the share picker may offer (src/space-shareable.mjs): the private Trillion, so only for a
    // sign-in that reaches it.
    if (parts[0] === 'shareable' && parts.length === 1 && request.method === 'GET') {
      if (!reach.private) throw new Error('This sign-in reaches only your pursuits, so it cannot list what to share from the private Trillion.');
      const page = shareablePage({ screen: await person.workScreen(), messagesPage: input => person.shareableMessages(input) },
        { kind: url.searchParams.get('kind'), after: url.searchParams.get('after') });
      return json(page.body, page.status);
    }
    // What an AI working in a space is handed with its tool reply (src/space-brief.mjs): only for the reader the Worker
    // named, and only of the spaces this sign-in reaches.
    if (parts[0] === 'briefs' && parts.length === 1 && request.method === 'POST') {
      const reader = request.headers.get('x-trillion-reader');
      const named = typeof body.space_id === 'string' && body.space_id ? await spaceIdOf(body.space_id).catch(() => undefined) : null;
      if (!reader || named === undefined || (named && !reaches(reach, named))) return json({ briefs: [] });
      return json(await network.spaceBriefs({ relay, reader, space_id: named, when: body.when === 'always' ? 'always' : 'new', within: reach.spaces }));
    }
    const [named, section, ...rest] = parts;
    const spaceId = await spaceIdOf(named);
    if (!reaches(reach, spaceId)) throw new Error('You are not a member of that pursuit.');
    const route = `${request.method} ${section ?? ''}${rest.length ? `/${rest.join('/')}` : ''}`;
    const at = { relay, space_id: spaceId };
    const canonicalSpaceTool = async toolId => {
      const { descriptor, made_by: madeBy } = await person.workshop().describe({ tool_id: toolId });
      const { tools = [] } = await person.workshop().list({ tool_id: toolId });
      if (madeBy === 'this account' && !tools[0]?.published_by_you) throw new Error('A private tool cannot be granted to a space. Publish it first so each member can resolve the same definition in their own Marketplace.');
      return { descriptor, tool_version: workshopToolVersion(descriptor) };
    };
    const resolveSpaceGrant = async ({ grant_id, tool_id, operation }) => {
      const grant = await network.spaceToolGrant({ ...at, grant_id, tool_id, operation });
      const current = await canonicalSpaceTool(grant.tool_id);
      if (current.tool_version !== grant.tool_version) throw new Error('This pursuit tool grant no longer matches the current Marketplace tool definition. The pursuit owner must grant the current version.');
      // Whether the tool changes things is derived from its descriptor (src/tool-write-class.mjs); the pursuit's own rules may refuse that.
      if (operation === 'run' && writeClassOf(current.descriptor) === 'write') await network.spaceToolGrant({ ...at, grant_id, tool_id, operation, write: true });
      return { ...grant, descriptor: current.descriptor };
    };
    if (route === 'GET ') {
      const space = await network.space(at);
      const pursuit = await person.pursuitOfRoom(spaceId);
      return json({ ...space, ...(pursuit ? { pursuit_id: pursuit.id, title: pursuit.title, now: pursuit.now ?? null, after: pursuit.after ?? null } : {}), ...(pursuit?.status === 'archived' ? { archived_at: pursuit.archived_at ?? null } : {}) });
    }
    if (route === 'POST archive') {
      const pursuit = await person.pursuitOfRoom(spaceId);
      if (!pursuit) throw new Error('You are not a member of that pursuit.');
      const answer = await person.archivePursuit(pursuit.id, body.archived ?? true);
      return json({ space_id: spaceId, ...answer });
    }
    if (route === 'GET items') return json(await network.spaceItems({ ...at, item_id: url.searchParams.get('item_id'), kind: url.searchParams.get('kind'), before: url.searchParams.get('before'), limit: url.searchParams.get('limit'), anchor_record: url.searchParams.get('anchor_record'), anchor_part: url.searchParams.get('anchor_part') ? JSON.parse(url.searchParams.get('anchor_part')) : null, query: url.searchParams.get('query') }));
    if (section === 'records' && rest.length === 1 && request.method === 'GET') return json(await network.readSpaceRecord({ ...at, address: rest[0] }));
    if (section === 'records' && rest.length === 1 && request.method === 'POST') return json(await network.writeSpaceRecord({ ...at, address: rest[0], expected_revision: body.expected_revision, value: body.value }));
    if (section === 'records' && rest.length === 1 && request.method === 'DELETE') return json(await network.deleteSpaceRecord({ ...at, address: rest[0], expected_revision: body.expected_revision }));
    if (route === 'GET previews') {
      const previews = Object.create(null);
      const admittedPreviews = [];
      for (const itemId of sharedPreviewItems(JSON.parse(url.searchParams.get('item_ids') ?? '[]'))) {
        previews[itemId] = null;
        try {
          const associated = await network.spaceAssociatedFiles({ ...at, item_id: itemId, limit: 1 });
          const file = associated.references[0]?.available ? associated.references[0]?.file : null;
          if (!file) continue;
          const grant = { ...at, item_id: file.item_id };
          const admitted = await network.spaceFile(grant);
          if (admitted.identity !== file.identity) continue;
          const saved = typeof person.readSpaceFile === 'function'
            ? await person.readSpaceFile({ ...grant, identity: file.identity, person_ref: admitted.person_ref, part: 'preview' })
            : await person.env.PERSON.get(person.env.PERSON.idFromString(admitted.person_ref)).sharedFilePreview(file.identity, grant);
          if (saved?.busy) return Response.json(saved, { status: 429, headers: { 'cache-control': 'private, no-store', 'retry-after': String(saved.retry_after_seconds ?? 1) } });
          if (!saved || (!saved.poster && !saved.peaks?.length && !saved.lines)) continue;
          // Recheck the parent as well as the source: an earlier association cannot serve a withdrawn record.
          const current = await network.spaceAssociatedFiles({ ...at, item_id: itemId, limit: 1 });
          const still = current.references[0]?.available ? current.references[0]?.file : null;
          if (still?.identity === file.identity && still.item_id === file.item_id && sameSharedRecord(associated.record, current.record)) {
            previews[itemId] = { file, ...saved };
            admittedPreviews.push({ itemId, record: current.record, file });
          }
        } catch (error) {
          if (failureOf(error).tries_again_later || FAULTS.some(kind => error instanceof kind)) throw error;
          // A refused association never permits a private original-file fallback.
        }
      }
      // Later source reads may outlive an earlier grant. Recheck every populated
      // result after the batch has finished reading, before returning saved bytes.
      for (const { itemId, record, file } of admittedPreviews) {
        try {
          const current = await network.spaceAssociatedFiles({ ...at, item_id: itemId, limit: 1 });
          const still = current.references[0]?.available ? current.references[0]?.file : null;
          if (still?.identity !== file.identity || still.item_id !== file.item_id || !sameSharedRecord(record, current.record)) previews[itemId] = null;
        } catch (error) {
          if (failureOf(error).tries_again_later || FAULTS.some(kind => error instanceof kind)) throw error;
          previews[itemId] = null;
        }
      }
      return Response.json({ previews }, { headers: { 'cache-control': 'private, no-store' } });
    }
    if (route === 'GET responses') return json(await network.spaceResponses({ ...at, record: url.searchParams.get('record'), part: url.searchParams.get('part') ? JSON.parse(url.searchParams.get('part')) : null, all_parts: url.searchParams.get('all_parts') === 'true', before: url.searchParams.get('before'), limit: url.searchParams.get('limit') }));
    if (route === 'GET responses/summaries') return json(await network.spaceResponseSummaries({ ...at, after: url.searchParams.get('after'), limit: url.searchParams.get('limit') }));
    if (request.method === 'GET' && section === 'items' && rest.length === 2 && rest[1] === 'reactions') return json(await network.spaceItemReactions({ ...at, item_id: rest[0] }));
    if (route === 'POST items') return json(await network.addSpaceItems({ ...at, items: body.items, app: request.headers.get('x-trillion-app') }));
    if (route === 'POST responses/react') return json(await network.reactToSpaceAnchor({ ...at, record: body.record, part: body.part, symbol: body.symbol, glyph: body.glyph, on: body.on }));
    if (route === 'POST responses/resolve') return json(await network.setSpaceResponseResolved({ ...at, record: body.record, part: body.part, resolved: body.resolved }));
    // A reaction on one thing there, given, taken back or turned over (src/responses.mjs, src/spaces.mjs reactToSpaceItem).
    if (request.method === 'POST' && section === 'items' && rest.length === 2 && rest[1] === 'react') return json(await network.reactToSpaceItem({ ...at, item_id: rest[0], symbol: body.symbol, glyph: body.glyph, on: body.on }));
    // Who the person is on the space's board, asked by the Worker before it opens a board socket (src/board-room.mjs).
    if (route === 'GET board-member') return json(await network.boardMember(at));
    if (route === 'POST withdraw') return json(await network.withdrawSpaceItem({ ...at, item_id: body.item_id }));
    if (route === 'POST fill') return json(await network.fillSpaceItem({ ...at, item_id: body.item_id, title: body.title, body: body.body }));
    if (route === 'POST facts') return json(await network.setSpaceItemFacts({ ...at, item_id: body.item_id, facts: body.facts }));
    if (route === 'POST name') return json(await network.nameInSpace({ ...at, name: body.name }));
    if (route === 'POST seen') return json(await network.markSpaceSeen({ ...at, through: body.through, unread_from: body.unread_from }));
    if (route === 'POST about') {
      // A picture is read from the person's own files, which needs the private reach.
      if (body.picture !== undefined && body.picture !== null && !reach.private) throw new Error('This sign-in reaches only your pursuits, so it cannot take a picture from your files.');
      const picture = body.picture === undefined || body.picture === null ? body.picture : await person.shareableRecord({ file: String(body.picture) });
      const described = await network.describeSpace({ ...at, title: body.title, description: body.description, picture, colour: body.colour });
      await person.titleFromRoom(spaceId, body.title);
      return json(described);
    }
    if (route === 'GET picture') {
      const picture = await network.spacePicture(at);
      return json(await fileAddress(person, picture, { ...at, item_id: picture.item_id }));
    }
    if (route === 'POST invites') {
      const { code, ...invite } = await network.makeSpaceInvite({ ...at, days: body.days, addressed: body.email || body.phone ? { email: body.email, phone: body.phone } : null, ...(body.member_type ? { member_type: String(body.member_type) } : {}) });
      return json({ ...invite, url: inviteLink(request.headers.get('x-trillion-origin'), code) });
    }
    if (route === 'GET invites') return json(await network.spaceInvites(at));
    if (route === 'POST tools/grant') {
      const current = await canonicalSpaceTool(body.tool_id);
      if (body.tool_version && body.tool_version !== current.tool_version) throw new Error('tool_version does not match the current Marketplace definition.');
      return json(await network.grantSpaceTool({ ...at, tool_id: body.tool_id, tool_version: current.tool_version, member_id: body.member_id, operations: body.operations }));
    }
    // What adding a tool would give each member beyond what they hold, before the owner grants it (src/access-impact.mjs). Reads only.
    if (route === 'GET tools/impact') {
      const current = await canonicalSpaceTool(url.searchParams.get('tool_id'));
      const { members } = await network.space(at);
      const held = {};
      for (const member of members.slice(0, accessImpactData.max_members)) held[member.member_id] = (await network.spaceToolGrants({ ...at, tool_id: current.descriptor.id, member_id: member.member_id })).grants.flatMap(grant => grant.operations ?? []);
      const operations = url.searchParams.get('operations');
      return json(accessImpact({ descriptor: current.descriptor, toolVersion: current.tool_version, operations: operations ? operations.split(',') : null, memberId: url.searchParams.get('member_id') ?? undefined, members, held }));
    }
    if (route === 'GET tools') return json(await network.spaceToolGrants({ ...at, tool_id: url.searchParams.get('tool_id'), member_id: url.searchParams.get('member_id') ?? relay, operation: url.searchParams.get('operation') }));
    if (route === 'POST tools/revoke') return json(await network.revokeSpaceTool({ ...at, grant_id: body.grant_id }));
    if (route === 'GET tools/added') return json(await addedTools(person, relay, spaceId));
    if (route === 'POST tools/remove') return json(await network.removeSpaceTool({ ...at, tool_id: body.tool_id }));
    if (route === 'POST tools/resolve') {
      const grant = await resolveSpaceGrant({ grant_id: body.grant_id, tool_id: body.tool_id, operation: 'describe' });
      return json({ grant_id: grant.grant_id, space_id: grant.space_id, tool_id: grant.tool_id, tool_version: grant.tool_version });
    }
    if (route === 'POST workshop/find') {
      const grants = await network.spaceToolGrants({ ...at, operation: 'discover' });
      const active = [];
      for (const grant of grants.grants) {
        try { const resolved = await resolveSpaceGrant({ grant_id: grant.grant_id, operation: 'discover' }); active.push(resolved); } catch {}
      }
      const found = await person.workshop().find({ job: body.job, limit: body.limit, allowed_tool_ids: active.map(grant => grant.tool_id) });
      const allowed = new Set(active.map(grant => grant.tool_id));
      const candidates = (found.candidates ?? []).filter(card => allowed.has(card.tool_id));
      return json({ job: found.job, candidates: candidates.map(card => ({ ...card, grant_id: active.find(grant => grant.tool_id === card.tool_id)?.grant_id })) });
    }
    // The screen's read uses the same grant authority as the MCP read. GET keeps this
    // read separate from mutations, so opening a tool does not invalidate page answers.
    if (route === 'GET workshop/describe' || route === 'POST workshop/describe') {
      const input = request.method === 'GET' ? { grant_id: url.searchParams.get('grant_id'), tool_id: url.searchParams.get('tool_id') } : body;
      const grant = await resolveSpaceGrant({ grant_id: input.grant_id, tool_id: input.tool_id, operation: 'describe' });
      return json({ grant_id: grant.grant_id, tool_id: grant.tool_id, tool_version: grant.tool_version, descriptor: grant.descriptor });
    }
    if (route === 'POST workshop/run') {
      const grant = await resolveSpaceGrant({ grant_id: body.grant_id, tool_id: body.tool_id, operation: 'run' });
      const task = await person.workshop().run({ tool_id: grant.tool_id, input: body.input ?? {}, request_key: scopedRequestKey(`space:${spaceId}:${grant.grant_id}`, body.request_key), job: body.job, wait_seconds: body.wait_seconds, run_at: body.run_at, execution: person.executionOf?.(request) ?? null, caller_app: request.headers.get('x-trillion-app'), space_authorization: { space_id: spaceId, grant_id: grant.grant_id, tool_version: grant.tool_version } });
      return json(task);
    }
    if (route === 'POST workshop/read') {
      const grant = await resolveSpaceGrant({ grant_id: body.grant_id, tool_id: body.tool_id, operation: 'read' });
      const task = await person.workshop().read({ task_id: body.task_id });
      if (task.tool_id !== grant.tool_id || task.space_authorization?.space_id !== spaceId || task.space_authorization?.grant_id !== grant.grant_id || task.space_authorization?.tool_version !== grant.tool_version) throw new Error('That task is not a run through this pursuit tool grant.');
      return json(task);
    }
    if (route === 'POST workshop/snapshot') {
      // Authorize the current member/grant without describe(), which can refresh live tool sources.
      // snapshot() checks the kept definition and current task grant before exposing its safe view.
      const grant = await network.spaceToolGrant({ ...at, grant_id: body.grant_id, tool_id: body.tool_id, operation: 'read' });
      const task = await person.workshop().snapshot({ task_id: body.task_id });
      if (task.tool_id !== grant.tool_id || task.space_authorization?.space_id !== spaceId || task.space_authorization?.grant_id !== grant.grant_id || task.space_authorization?.tool_version !== grant.tool_version) throw new Error('That task is not a run through this pursuit tool grant.');
      return json({ ...task, next_call: { tool: 'snapshot_space_task', arguments: { space_id: spaceId, grant_id: grant.grant_id, task_id: task.task_id } } });
    }
    if (route === 'POST invite-person') return json(await invitePerson(at, body));
    // Who may do what here (src/space-permissions.mjs): read by members, replaced by whoever the rules let.
    if (route === 'GET rules') return json(await network.readSpaceRules(at));
    // A refused set of rules names each reason with the rule it is about, so a screen can show it there.
    if (route === 'POST rules') return json(await network.setSpaceRules({ ...at, rules: body.rules }).catch(error => { throw Object.assign(error, { problems: Array.isArray(body.rules) ? ruleProblems(body.rules) : [] }); }));
    // Member types (src/space-member-types.mjs): give a member a type, add or remove the space's own type.
    if (route === 'POST members/type') return json(await network.setMemberType({ ...at, member_id: body.member_id, member_type: body.member_type }));
    if (route === 'POST members/joining-type') return json(await network.setJoiningType({ ...at, member_type: body.member_type }));
    if (route === 'POST members-are') return json(await network.setMembersAre({ ...at, members_are: body.members_are ?? null }));
    if (route === 'POST members/remove') return json(await network.removeMember({ ...at, member_id: body.member_id }));
    if (route === 'POST member-types') return json(await network.addMemberType({ ...at, label: body.label, inherits: body.inherits }));
    if (route === 'PUT member-types') return json(await network.updateMemberType({ ...at, member_type: body.member_type, label: body.label, inherits: body.inherits }));
    if (route === 'POST member-types/remove') return json(await network.removeMemberType({ ...at, member_type: body.member_type }));
    if (route === 'POST hide') return json(await network.hideSpaceItem({ ...at, item_id: body.item_id, hidden: body.hidden }));
    if (route === 'POST invites/revoke') return json(await network.revokeSpaceInvite({ ...at, invite_id: body.invite_id }));
    if (route === 'POST share') {
      // Reading the private record needs the private reach: an agent held to spaces cannot reach into it.
      if (!reach.private) throw new Error('This sign-in reaches only your pursuits, so it cannot share from the private Trillion.');
      if (body.records !== undefined || body.items !== undefined) {
        if (['record', 'record_id', 'file', 'tool'].some(field => body[field] !== undefined)) throw new Error('Choose one record or an ordered selection, without mixing the two.');
        // Preserve supplied values for the sharing owner's validation. Replacing a malformed selection with []
        // could claim success while silently omitting what the caller asked to share.
        return json(await person.shareIntoMany(spaceId, { records: body.records === undefined ? [] : body.records, items: body.items === undefined ? [] : body.items, request_key: body.request_key ?? null }, request.headers.get('x-trillion-app')));
      }
      return json(await person.shareInto(spaceId, body, null, request.headers.get('x-trillion-app')));
    }
    if (request.method === 'GET' && section === 'items' && rest.length === 2 && rest[1] === 'file') return json(await fileAddress(person, await network.spaceFile({ ...at, item_id: rest[0] }), { ...at, item_id: rest[0] }));
    // reads-ok: spaceAssociatedFiles validates 1..24 against shared-record-references.json before paging; each exact admitted file lookup has LIMIT 2.
    if (request.method === 'GET' && section === 'items' && rest.length === 2 && rest[1] === 'references') return Response.json(await network.spaceAssociatedFiles({ ...at, item_id: rest[0], after: url.searchParams.get('after'), ...(url.searchParams.has('limit') ? { limit: url.searchParams.get('limit') } : {}) }), { headers: { 'cache-control': 'private, no-store' } });
    if (request.method === 'GET' && section === 'items' && rest.length === 2 && rest[1] === 'transcript') return await fileTranscript(person, await network.spaceFile({ ...at, item_id: rest[0] }), { ...at, item_id: rest[0] });
    if (route === 'POST import') return json(await person.importConversations({ ...body, space_id: spaceId, reach }));
    const agentVerbs = { 'POST agents/publish': 'publish', 'POST agents/withdraw': 'withdraw', 'POST agents/capacity': 'setCapacity', 'POST agents/find': 'find', 'POST handoffs': 'handOff', 'POST handoffs/take': 'take', 'POST handoffs/finish': 'finish', 'POST handoffs/read': 'read' };
    if (route === 'POST agents/publish') return json(await publishFromAi(person, network, at, body));
    if (route === 'POST agents/withdraw') return json(await withdrawAiFromSpace(person, spaceId, body.agent_id ?? body.ai_id));
    if (agentVerbs[route]) return json(await network.spaceAgents({ ...at, verb: agentVerbs[route], input: body }));
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    // The Worker owns the shared HTTP/MCP failure response. Do not turn infrastructure failures
    // into a 400 permission refusal or lose their retry/resource policy here.
    if (failureOf(error).tries_again_later) throw error;
    if (FAULTS.some(kind => error instanceof kind)) {
      console.error('spaces request failed', error);
      return json({ error: FAILED }, 500);
    }
    return json({ error: error.message, ...(error.problems?.length ? { problems: error.problems } : {}) }, 400);
  }
}
