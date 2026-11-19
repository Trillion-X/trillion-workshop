// tools/tell-one-person-something-through-every-way-they/do-work/tell-routes.mjs
//
// PURPOSE
//   The page route GET /work/api/tell/notices as a Workshop route tool (the engine's `@workshop-routes` family runs this
//   row for the page's account with { path, method, query, body, browser } and answers the page with the result's
//   { status, body }). Old trillion answered it in the person's store through src/tell-the-person.mjs
//   handleTellRequest (tag old-trillion-before-worker-retire): the notices the open page shows (`recent`), or with
//   ?channel=<id> what that channel's devices read after `after` (`forDevice`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The request goes to the moved route, read-data/tell-the-person.mjs handleTellRequest, over makeTellThePerson
//      with the moved rows (read-data/tell-the-person.json); this file only reads the person's kept notices for it.
//   2. The kept notices are the person's `told-the-person` records, given as input.stored.records ({ id, type, value }).
//      This file reads them in place: one head `told-the-person` naming the notices in order ({ seqs }), one record
//      `told-the-person:<seq>` per notice ({ item }), or an older head holding them all as `items`. Nothing is kept here.
//   3. Only GET /tell/notices is this row's: it writes nothing and tells no one, so no sender is wired. Any other path
//      or method answers 404 { error: 'Not found' }, as the moved route answers a path it has no row for.
//
import rows from '../read-data/tell-the-person.json' with { type: 'json' };
import { handleTellRequest, makeTellThePerson } from '../read-data/tell-the-person.mjs';

const KIND = 'told-the-person';
const HEAD = KIND;

/** The kept notices in order, read from the records the caller hands in; what is not given is not there. */
function keptNotices(records) {
  const held = new Map((Array.isArray(records) ? records : []).filter(record => record?.type === KIND).map(record => [record.id, record.value]));
  const head = held.get(HEAD) ?? {};
  if (Array.isArray(head.items)) return head.items;
  return (head.seqs ?? []).map(seq => held.get(`${HEAD}:${seq}`)?.item).filter(Boolean);
}

const queryText = query => new URLSearchParams(Object.entries(query && typeof query === 'object' ? query : {})
  .filter(([, value]) => value !== undefined && value !== null).map(([name, value]) => [name, String(value)])).toString();

/** tool:answer-the-tell-notices-route */
export async function answerTellNoticesRoute(input = {}, { now = () => new Date() } = {}) {
  const path = String(input?.path ?? '');
  const method = String(input?.method ?? 'GET').toUpperCase();
  if (!(method === 'GET' && path === '/tell/notices')) return { status: 404, body: { error: 'Not found' } };
  const kept = keptNotices(input.stored?.records);
  const store = {
    choices: () => null,
    notices: () => kept,
    putNotices: () => { throw new Error('Reading notices writes nothing.'); },
  };
  const tell = makeTellThePerson({ rows, store, senders: {}, now });
  const search = queryText(input.query);
  const response = await handleTellRequest({ tell }, new Request(`https://person${path}${search ? `?${search}` : ''}`));
  return { status: response.status, body: await response.json() };
}
