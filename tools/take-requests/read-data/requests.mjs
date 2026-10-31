// tools/take-requests/read-data/requests.mjs
//
// Requests that arrive from people or from checks, each kept as a record, handed to the owner who can act on it, and
// closed by the receipt that owner gives back. Records go through the run's records door (tools/records-door).
// Nothing here names an owner, an action, an origin or a disposition: which origins count as a person asking, who the
// owners are, what the owner is asked to run and how a request was decided are the person's records and the caller's
// words.
//
// Records:
//   intake-origins   id intake-origins:accepted        { origins: [ref] }   the origins that count as someone asking
//   intake-owner     id intake-owner:<owner_ref>       { owner_ref, active }
//   intake-request   id intake-request:<request_id>    the request, how it was decided, who owns it, its receipts
//                    (kept only when it can be acted on; a request that must wait for an owner or a shorter text is not kept)
//   intake-receipt   id intake-receipt:<ref>           what an owner gave back for a request
//   owner-action-request  id owner-action-request:<operation_id>:<n>
//                    { kind, owner, actionRef, input, status, requested_at } the shape forms (tools/ask-questions-sort-answers-follow-up)
//                    also write when an answer hands work to an owner; the owner named reads its own requests.
export const REQUEST = 'intake-request';
export const ORIGINS = 'intake-origins';
export const OWNER = 'intake-owner';
export const RECEIPT = 'intake-receipt';
export const ACTION = 'owner-action-request';

// A text longer than this is kept cut to it, and a request that hands it to an owner is held back until it is shorter.
export const TEXT_BOUND = 65536;
const MOST = 100;
const USUAL = 20;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.length > 0 ? value : '');
const words = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const sorted = value => (Array.isArray(value) ? value.map(sorted) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value);
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

function readPath(context, path) {
  const [root, ...rest] = String(path).split('.').filter(Boolean);
  let current = root === 'request' ? context : root === 'answers' ? context.answers ?? {} : root === 'fields' ? context.field_values ?? {} : undefined;
  for (const part of rest) {
    if (!object(current)) return undefined;
    current = current[part];
  }
  return current;
}

function actionRefs(action) {
  const refs = Array.isArray(action.action_refs) && action.action_refs.length ? action.action_refs : text(action.action_ref) ? [action.action_ref] : [];
  if (!refs.length || !refs.every(text)) throw new Error('Name what the owner is asked to run: the action needs an action_ref, or action_refs.');
  return refs;
}

/**
 * The owner-action requests an action asks for, one per action ref, built from its fixed input, the context's answers,
 * and the values its copy rows read (`request.<path>`, `answers.<path>`, `fields.<path>`). Pure and repeatable: the same
 * action and context give the same requests.
 */
export function ownerActionRequests(action, context) {
  if (!object(action) || !text(action.owner)) throw new Error('Name the owner the request goes to: the action needs an owner.');
  const refs = actionRefs(action);
  if (!object(context) || !text(context.operation_id)) throw new Error('Give the request an operation_id, so asking again is the same request.');
  const copied = {};
  for (const entry of Array.isArray(action.copy) ? action.copy : []) {
    if (!object(entry) || !text(entry.key)) continue;
    const value = entry.from ? readPath(context, entry.from) : entry.value;
    if (value !== undefined) copied[entry.key] = value;
  }
  const input = {
    ...(object(action.input) ? action.input : {}),
    ...(object(context.answers) ? context.answers : {}),
    ...copied,
    action_id: text(action.id) || null,
    record_ref: context.record_ref ?? null,
    shape_ref: context.shape_ref ?? null,
    field_values: context.field_values ?? {},
    linked_receipt_refs: context.linked_receipt_refs ?? [],
    receipt_ref: context.receipt_ref ?? null,
  };
  const at = text(context.requested_at) || new Date().toISOString();
  return refs.map((actionRef, index) => ({
    id: `${ACTION}:${context.operation_id}:${index}`, type: ACTION,
    value: { kind: ACTION, owner: action.owner, actionRef, input, status: 'requested', requested_at: at },
  }));
}

async function handOff(door, requests) {
  const fresh = [];
  const already = [];
  for (const request of requests) ((await door.read(ACTION, request.id)) === null ? fresh : already).push(request);
  return { fresh, already };
}

/** tool:hand-a-request-to-its-owner: asks the owner the action names, once; asking again leaves the first request as it is. */
export async function handARequestToItsOwner(input, { door }) {
  const requests = ownerActionRequests(object(input) ? input.action : null, object(input) ? input.context : null);
  const { fresh, already } = await handOff(door, requests);
  if (fresh.length) await door.write(fresh, { key: `${ACTION}:${input.context.operation_id}` });
  return {
    handed: fresh.map(request => request.id), already: already.map(request => request.id),
    said: fresh.length ? `Asked ${input.action.owner}: ${words(fresh.length, 'request', 'requests')} kept.` : `${input.action.owner} was already asked.`,
  };
}

// What the owner is told success looks like when the decision does not say.
const DEFAULT_SUCCESS = 'The requested outcome is verified.';
const NEEDED = ['request_id', 'source_ref', 'atom_ref', 'text', 'origin_ref'];
const refused = (id, problems) => ({ status: 'refused', request_id: id, problems, owner_request: null, said: problems.map(problem => problem.said).join(' ') });

/**
 * tool:take-a-request: keeps one request as its own record and, when the decision hands it to an owner, asks that owner.
 * The request must come from an origin the person accepts and be whole. The same request again changes nothing; the
 * same id from another source, or with another message, content revision or place it was said, is refused. A request
 * that cannot be acted on yet (the owner is not on file, or the text is longer than the bound and is being handed over)
 * keeps nothing, so taking it again once that is fixed is a first take. The decision is the caller's: this checks it is
 * complete and acts on it, it does not make it. A decision that points at an existing task is refused: a task reference
 * alone says nothing about who is running it now.
 */
export async function takeARequest(input, { door }) {
  const request = object(input) ? input.request : null;
  const decision = object(input) ? input.decision : null;
  if (!object(request) || !object(decision)) throw new Error('Pass request (what arrived) and decision (what to do with it).');
  const bound = input.max_text_chars === undefined ? TEXT_BOUND : input.max_text_chars;
  if (!Number.isInteger(bound) || bound < 1) throw new Error('max_text_chars must be a whole number of at least 1.');
  const handing = decision.hand_to_owner === true;
  const handOffAction = object(input.hand_off) ? input.hand_off : {};
  if (handing) actionRefs(handOffAction);
  const missing = NEEDED.filter(key => !text(request[key]) || !text(request[key]).trim());
  const origins = await door.read(ORIGINS, `${ORIGINS}:accepted`);
  const accepted = object(origins) && Array.isArray(origins.origins) ? origins.origins.filter(text) : [];
  const problems = [];
  if (!accepted.length) problems.push({ code: 'no_accepted_origins', said: `No accepted origins are on file. Save a ${ORIGINS} record with id ${ORIGINS}:accepted and the origins that count as someone asking.` });
  else if (missing.length) problems.push({ code: 'request_incomplete', said: `The request lacks ${missing.join(', ')}.` });
  else if (!accepted.includes(request.origin_ref)) problems.push({ code: 'origin_not_accepted', said: `${request.origin_ref} is not an origin the person accepts.` });
  if (!text(decision.disposition) || !text(decision.reason).trim()) problems.push({ code: 'decision_incomplete', said: 'The decision needs a disposition and a reason.' });
  if (problems.length) return refused(text(request.request_id) || null, problems);

  const id = request.request_id;
  const existing = await door.read(REQUEST, `${REQUEST}:${id}`);
  if (object(existing)) {
    const same = ['source_ref', 'message_ref', 'atom_ref', 'content_revision'].every(key => existing[key] === (request[key] ?? null));
    if (!same) return refused(id, [{ code: 'source_identity_conflict', said: `${id} was already taken from a different source, message, place or version.` }]);
    return { status: 'already-taken', request_id: id, problems: [], owner_request: existing.owner_request ?? null, said: `${id} was already taken.` };
  }

  const owner = handing ? await door.read(OWNER, `${OWNER}:${text(decision.owner_ref)}`) : null;
  const ownerKnown = object(owner) && owner.active === true;
  const chars = [...request.text];
  const waiting = [];
  if (handing && !ownerKnown) waiting.push({ code: 'owner_not_resolved', said: `${text(decision.owner_ref) || 'No owner'} is not an active owner on file, so ${id} was not kept; take it again once the owner is on file.` });
  if (handing && chars.length > bound) waiting.push({ code: 'text_too_long', said: `The text of ${id} is longer than ${bound} characters, so it was not kept or handed over; give a shorter view of it.` });
  if (waiting.length) return { status: 'deferred', request_id: id, problems: waiting, owner_request: null, said: waiting.map(problem => problem.said).join(' ') };
  if (text(decision.existing_task_ref)) {
    return refused(id, [{ code: 'current_task_executor_not_verified', said: `${decision.existing_task_ref} says nothing about who is running it now, so ${id} was not kept; give the decision without an existing task.` }]);
  }

  const record = {
    kind: REQUEST, request_id: id, source_ref: request.source_ref, message_ref: request.message_ref ?? null, atom_ref: request.atom_ref,
    content_revision: request.content_revision ?? null, at: request.at ?? null, text: chars.slice(0, bound).join(''),
    disposition: decision.disposition, reason: decision.reason, owner_ref: handing ? decision.owner_ref : null,
    status: handing ? 'handed' : 'recorded', owner_request: null, receipt_refs: [],
  };
  const writes = [];
  if (handing) {
    const [owned] = ownerActionRequests({ ...handOffAction, owner: decision.owner_ref }, {
      operation_id: `${REQUEST}:${id}`, record_ref: id, requested_at: request.at ?? undefined,
      field_values: { asked: record.text, asked_at: request.at ?? null, said_in: request.atom_ref, owner: decision.owner_ref, success: decision.acceptance_criteria ?? DEFAULT_SUCCESS },
      answers: { proof_links: [request.atom_ref] },
    });
    record.owner_request = owned.id;
    writes.push(owned);
  }
  writes.push({ id: `${REQUEST}:${id}`, type: REQUEST, value: record });
  await door.write(writes, { key: `${REQUEST}:${id}` });
  return {
    status: record.status, request_id: id, problems: [], owner_request: record.owner_request,
    said: handing ? `${id} is kept and ${decision.owner_ref} is asked.` : `${id} is kept.`,
  };
}

/** tool:record-the-owners-receipt: links what an owner gave back to the request it answers. */
export async function recordTheOwnersReceipt(input, { door }) {
  const id = object(input) ? text(input.request_id) : '';
  const receipt = object(input) && object(input.receipt) ? input.receipt : null;
  if (!id || !receipt || !['ref', 'owner_ref', 'title'].every(key => text(receipt[key]))) throw new Error('Pass request_id and receipt with ref, owner_ref and title.');
  const request = await door.read(REQUEST, `${REQUEST}:${id}`);
  if (!object(request)) return { request_id: id, receipt_ref: receipt.ref, linked: false, said: `There is no request ${id}, so nothing was linked. Take the request first.` };
  const held = await door.read(RECEIPT, `${RECEIPT}:${receipt.ref}`);
  if (object(held) && held.request_id !== id) throw new Error(`The receipt ${receipt.ref} already answers a different request.`);
  const linked = Array.isArray(request.receipt_refs) && request.receipt_refs.includes(receipt.ref);
  if (object(held) && linked) return { request_id: id, receipt_ref: receipt.ref, linked: false, said: `${receipt.ref} was already linked to ${id}.` };
  const value = {
    kind: RECEIPT, ref: receipt.ref, request_id: id, owner_ref: receipt.owner_ref, title: receipt.title,
    summary: receipt.summary ?? null, process_ref: receipt.process_ref ?? null, observed_at: receipt.observed_at ?? null, raw: receipt.raw ?? null,
  };
  await door.write([
    { id: `${RECEIPT}:${receipt.ref}`, type: RECEIPT, value },
    { id: `${REQUEST}:${id}`, type: REQUEST, value: { ...request, receipt_refs: linked ? request.receipt_refs : [...(request.receipt_refs ?? []), receipt.ref] } },
  ], { key: `${RECEIPT}:${receipt.ref}:${id}` });
  return { request_id: id, receipt_ref: receipt.ref, linked: true, said: `${receipt.ref} is linked to ${id}.` };
}

/** tool:my-requests: the requests taken, newest first, each with its receipts and whether an owner still owes an answer. */
export async function myRequests(input, { door }) {
  const most = Math.max(1, Math.min(MOST, Number(object(input) ? input.limit : 0) || USUAL));
  const owner = object(input) ? text(input.owner) : '';
  const waitingOnly = object(input) && input.waiting === true;
  const receipts = new Map();
  for await (const record of door.list({ type: RECEIPT })) if (object(record.value)) receipts.set(record.value.ref, record.value);
  const all = [];
  for await (const record of door.list({ type: REQUEST })) if (object(record.value)) all.push(record.value);
  const shown = all
    .filter(request => !owner || request.owner_ref === owner)
    .map(request => {
      const given = (request.receipt_refs ?? []).map(ref => receipts.get(ref)).filter(Boolean);
      return {
        request_id: request.request_id, text: request.text, at: request.at, status: request.status, disposition: request.disposition,
        reason: request.reason, owner_ref: request.owner_ref, owner_request: request.owner_request,
        receipts: given.map(({ ref, owner_ref, title, summary, observed_at }) => ({ ref, owner_ref, title, summary, observed_at })),
        waiting_on_owner: request.status === 'handed' && given.length === 0,
      };
    })
    .filter(request => !waitingOnly || request.waiting_on_owner)
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')) || String(a.request_id).localeCompare(String(b.request_id)));
  const requests = shown.slice(0, most);
  const waiting = requests.filter(request => request.waiting_on_owner).length;
  return { requests, said: `${words(requests.length, 'request', 'requests')}, newest first; ${waiting} waiting on an owner${shown.length > requests.length ? `; ${shown.length - requests.length} older not shown` : ''}.` };
}
