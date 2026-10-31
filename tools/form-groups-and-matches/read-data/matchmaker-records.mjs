// tools/form-groups-and-matches/read-data/matchmaker-records.mjs
//
// Where a community's matchmaker keeps what it knows: one record kind per fact, ids under the community, and a book
// that holds the records one run loaded and every change it makes to them. Pure; the seam
// (do-work/community-matchmaker.mjs) loads and writes. With community C, person P, round R and match M:
//
//   match-community:C          the community's settings: { title, owner, created_at, matching }
//   match-member:C:P           one member: { person, name, state, on?, answers, categories, changed_at }
//   match-round:C:R            one round: { round_id, started_at, deadline_at, closed_at, formed }
//   match-ask:C:R:P            one member's job in a round: { round_id, person, answers, candidates, arms, scores, answered_at }
//   match:C:M                  one proposed match: { match_id, round_id, members, reasons, answer_by, space_id, introduced_at, followed_up }
//   match-answer:C:M:P         one person's own answer to a match: { person, yes, by_person, consent, at, topics, wrote }
//   ai-job:match:C:KEY         one job for one person's own AI, on the engine's job road: { status, for, said, job, input }
//   group:introduction:...     the one-to-one a match opens (read-data/group-records.mjs)
//
// Each record has one writer: a member's own answers go only to their own member, ask and answer records; a round and
// a match are written by the step that forms or introduces them, with the same value whichever run writes it, so two
// runs at once can only both write what one of them would have.
const part = value => encodeURIComponent(String(value));

export const KINDS = Object.freeze({
  community: 'match-community', member: 'match-member', round: 'match-round', ask: 'match-ask', match: 'match', answer: 'match-answer', job: 'ai-job',
});

export const ids = Object.freeze({
  community: c => `match-community:${part(c)}`,
  member: (c, p) => `match-member:${part(c)}:${part(p)}`,
  memberPrefix: c => `match-member:${part(c)}:`,
  roundIdAt: ms => `r${String(ms).padStart(15, '0')}`,
  round: (c, r) => `match-round:${part(c)}:${r}`,
  roundPrefix: c => `match-round:${part(c)}:`,
  ask: (c, r, p) => `match-ask:${part(c)}:${r}:${part(p)}`,
  askPrefix: (c, r) => `match-ask:${part(c)}:${r}:`,
  allAsksPrefix: c => `match-ask:${part(c)}:`,
  matchId: (r, n) => `${r}.${String(n).padStart(4, '0')}`,
  match: (c, m) => `match:${part(c)}:${m}`,
  matchPrefix: c => `match:${part(c)}:`,
  answer: (c, m, p) => `match-answer:${part(c)}:${m}:${part(p)}`,
  answerPrefix: (c, m) => `match-answer:${part(c)}:${m}:`,
  allAnswersPrefix: c => `match-answer:${part(c)}:`,
  job: (c, key) => `ai-job:match:${part(c)}:${part(key)}`,
  jobPrefix: c => `ai-job:match:${part(c)}:`,
});

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The records one run loaded, and every change it made: get and list read the book as changed so far, put and remove
 * change it, loaded(id) says whether the run read that record, writes() gives { id, type, value } for each record
 * changed (value null for one removed).
 */
export function makeBook(records = []) {
  const kept = new Map();
  for (const record of records) if (record?.value !== null && record?.value !== undefined) kept.set(record.id, { id: record.id, type: record.type, value: record.value });
  const changed = new Map();
  const read = new Set(kept.keys());
  return {
    has: id => kept.has(id),
    loaded: id => read.has(id),
    get: id => (kept.has(id) ? structuredClone(kept.get(id).value) : null),
    put(id, type, value) {
      const record = { id, type, value: structuredClone(value) };
      kept.set(id, record);
      changed.set(id, record);
    },
    remove(id) {
      const type = kept.get(id)?.type ?? changed.get(id)?.type;
      if (!type) return;
      kept.delete(id);
      changed.set(id, { id, type, value: null });
    },
    list: prefix => [...kept.values()].filter(record => record.id.startsWith(prefix)).sort(byId),
    writes: () => [...changed.values()].sort(byId),
  };
}
