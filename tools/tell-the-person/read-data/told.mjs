// tools/tell-the-person/read-data/told.mjs
//
// What Trillion told the person, read from their own records through the run's records door (tools/records-door).
// The told list is records of the kind `told-the-person`: one head record `told-the-person` naming the kept notices
// in order ({ seqs: [seq, ...] }) and one record `told-the-person:<seq>` per notice ({ item }). A head written by an
// earlier version holds the whole list as `items` and is read as it is.
export const KIND = 'told-the-person';
const HEAD = KIND;
const MOST = 100;
const USUAL = 20;
const WHY_CHARACTERS = 200;

async function keptNotices(door) {
  const held = new Map();
  for await (const record of door.list({ type: KIND })) held.set(record.id, record.value);
  const head = held.get(HEAD) ?? {};
  if (Array.isArray(head.items)) return head.items;
  return (head.seqs ?? []).map(seq => held.get(`${HEAD}:${seq}`)?.item).filter(Boolean);
}

/**
 * tool:my-notices: the newest notices, optionally of one kind (the kind is applied before the newest are taken), with
 * where the person saw each one, how far each way got, and why each way that did not carry it did not.
 */
export async function myNotices({ limit = USUAL, kind = null } = {}, { door }) {
  const most = Math.max(1, Math.min(MOST, Number(limit) || USUAL));
  const notices = (await keptNotices(door)).filter(item => !kind || item.kind === kind).slice(-most).reverse().map(item => {
    const results = item.results ?? {};
    const told = Object.fromEntries(Object.entries(results).map(([channel, result]) => [channel, result.sent ? 'sent' : result.stage ?? 'not-sent']));
    const why = Object.fromEntries(Object.entries(results).filter(([, result]) => !result.sent && result.said).map(([channel, result]) => [channel, String(result.said).slice(0, WHY_CHARACTERS)]));
    return {
      id: `told:${item.seq}`, kind: item.kind, title: item.title ?? null, at: item.at ?? null, open: item.open ?? null, read: Boolean(item.read),
      ...(item.read_on ? { read_on: item.read_on } : {}), told, ...(Object.keys(why).length ? { why } : {}),
    };
  });
  const seen = notices.filter(item => item.read).length;
  return { notices, said: `${notices.length} ${notices.length === 1 ? 'notice' : 'notices'}, newest first; ${seen} seen.` };
}
