// tools/decide-with-a-method/do-work/answer-the-pursuits-page.mjs
//
// The page's /work/api/pursuits route, answered as old trillion answered it (tag old-trillion-before-worker-retire):
// src/own-resource-compatibility.mjs lines 243-247 sent GET to pursuits:list and PUT to pursuits:replace, which
// src/native-record-consumers.mjs line 193-194 kept with the DecisionEngine (src/engine.mjs lines 410-444, `pursuits`
// and `recordPursuits`, moved here with their words). Each pursuit is one `pursuit` record, read and written through
// the run's records door, the same records tools/decide-with-a-method reads for a decision's cited pursuits. The engine
// runs this as a @workshop-routes tool: input { path, method, query, body, browser }, result { status, body }.
//
//   GET /pursuits                                   -> 200 { pursuits: [every current pursuit] }
//   PUT /pursuits { pursuits: [...], replace_all? } -> 200 [every current pursuit, after the write]
//   a refused request                               -> 400 { error }   (engine.mjs's own words)
//   any other route or method                       -> 404 { error: 'Not found' }
//
// A pursuit whose title or `after` speaks of the person in the third person is refused with the engine's words; the old
// engine threw that as a plain error, which no route answered as a refusal, so here too it is thrown and the engine's
// failure owner answers it.

/** The words that speak of someone in the third person; a pursuit's shown words never use them for the person. */
const ABOUT_SOMEONE = /\b(he|him|his|she|her|hers)\b/i;
// A pursuit the person is working toward now: not ended, and not one they archived out of their lists
// (src/pursuit-rooms.mjs). The one test every list of current pursuits uses.
export const currentPursuit = item => item?.status !== 'ended' && item?.status !== 'archived';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const TYPE = 'pursuit';

/** Every pursuit kept, as { id: value }, by id from the least (the order old trillion's store read them back in,
 *  test/pursuits.test.mjs); the door lists the greatest id first, so they are put in that order here. */
async function readPursuits(door) {
  const rows = [];
  for await (const row of door.list({ type: TYPE })) if (object(row.value)) rows.push(row);
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { pursuits: Object.fromEntries(rows.map(row => [row.id, row.value])) };
}

export function pursuitsOf(door) {
  return {
  // What the person is pursuing: the changes every decision is weighed against. An ended pursuit is marked ended
  // rather than erased, so its history stays.
  async pursuits() { return Object.values((await readPursuits(door)).pursuits ?? {}).filter(currentPursuit); },

  // Each pursuit sent is added or updated by its id (an id list_pursuits returned names the same pursuit). With
  // replace_all, the list is the whole current list and every pursuit left out is ended, as when one AI records
  // everything it found; without it, one AI adding a pursuit never ends the ones another AI recorded.
  async recordPursuits(list, { replace_all: replaceAll = false } = {}) {
    // Both are the caller's request refused (400 on every road, src/failure.mjs refusalStatus), never a failure of the store.
    if (!Array.isArray(list) || !list.length) throw Object.assign(new Error('pursuits needs at least one pursuit'), { status: 400 });
    const cleaned = list.map((item, index) => {
      if (!object(item) || !nonempty(item.title) || !nonempty(item.now) || !nonempty(item.after)) throw Object.assign(new Error(`Pursuit ${index + 1} needs a title, where it is now, and where it should get to`), { status: 400 });
      // A pursuit's title and where it is going are shown to the person on every screen and widget: they are written to
      // them ("your files"), never about them ("his files").
      const about = ['title', 'after'].find(part => ABOUT_SOMEONE.test(item[part]));
      if (about) throw new Error(`Pursuit ${index + 1}: write its ${about} to the person, as "you" and "your", never "he", "his", "she" or "her" (it is shown to them). When it is about someone else, name them: "Morgan's deck".`);
      const id = 'pursuit:' + (nonempty(item.id) ? item.id.replace(/^pursuit:/, '') : item.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return [id, { ...item, id, kind: 'pursuit', status: nonempty(item.status) ? item.status : 'active' }];
    });
    const state = await readPursuits(door);
    const before = structuredClone(state.pursuits);
    {
      state.pursuits ??= {};
      const at = new Date().toISOString();
      const next = new Map(cleaned);
      // A pursuit with a room (people or things kept with it) is never ended by a whole-list rewrite: ending it is its own
      // action (src/pursuit-rooms.mjs endPursuit), so an AI's list of what it found never drops a shared pursuit.
      if (replaceAll) for (const [id, item] of Object.entries(state.pursuits)) if (!next.has(id) && currentPursuit(item) && !item.space_id) state.pursuits[id] = { ...item, status: 'ended', ended_at: at };
      // The room a pursuit's people and shared things live in (src/pursuit-rooms.mjs) belongs to the pursuit, not to
      // what an AI sent: a rewrite that leaves it out keeps it, and only src/pursuit-rooms.mjs sets it (changePursuits).
      for (const [id, item] of next) {
        const { space_id: _sent, ...rest } = item;
        const room = state.pursuits[id]?.space_id;
        state.pursuits[id] = { ...rest, ...(room ? { space_id: room } : {}), recorded_at: at };
      }
    }
    // The old engine wrote its whole state at once; here every pursuit it changed is written in one door write, each on
    // the condition that it is still as it was read, so a pursuit another AI changed meanwhile is never written over.
    const changed = Object.entries(state.pursuits).filter(([id, value]) => JSON.stringify(before[id]) !== JSON.stringify(value));
    if (changed.length) await door.write(changed.map(([id, value]) => ({ id, type: TYPE, value, expected: before[id] === undefined ? null : { type: TYPE, value: before[id] } })));
    return Object.values(state.pursuits).filter(currentPursuit);
  },
  };
}

const json = (body, status = 200) => ({ status, body });

/** The page route { path, method, body } -> { status, body }, over the run's records door. */
export async function answerThePursuitsPage({ path, method = 'GET', body } = {}, { door }) {
  const route = String(path ?? '').split('?')[0];
  const verb = String(method).toUpperCase();
  const read = verb === 'GET';
  if (route !== '/pursuits' || !(read || verb === 'PUT')) return json({ error: 'Not found' }, 404);
  // src/own-resource-compatibility.mjs: a body that is not an object is refused before any owner is asked.
  if (!read && !object(body ?? {})) return json({ error: 'The request body must be an object.' }, 400);
  const engine = pursuitsOf(door);
  try {
    if (read) return json({ pursuits: await engine.pursuits() });
    const input = body ?? {};
    return json(await engine.recordPursuits(input.pursuits, { replace_all: input.replace_all === true }));
  } catch (error) {
    // A refusal answers its own status with its words (src/own-resource-compatibility.mjs refusalAnswer); anything else
    // is the engine's failure owner's to answer.
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return json({ error: error.message }, error.status);
    throw error;
  }
}
