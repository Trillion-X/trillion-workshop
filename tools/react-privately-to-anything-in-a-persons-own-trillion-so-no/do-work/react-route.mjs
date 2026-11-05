// tools/react-privately-to-anything-in-a-persons-own-trillion-so-no/do-work/react-route.mjs
//
// PURPOSE
//   The page route POST /work/api/responses/react as a Workshop route tool (the engine's `@workshop-routes` family runs
//   this row for the page's account with { path, method, query, body, browser } and answers the page with the result's
//   { status, body }). Old trillion answered it in the person's store (src/person-store.mjs:8446, reached from
//   src/worker.mjs:288 through src/work-responses.mjs, tag old-trillion-before-worker-retire):
//   privateResponses(records).react(body), 200 with what it answered, 400 { error } when it refused.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The decision is the moved code's (src/private-responses.mjs react, unchanged): this file only lends it the
//      person's records through the run's door and writes back what it wrote.
//   2. private-responses.mjs reads synchronously. A record it asks for that was not read yet stops the run (Missing);
//      the record is read through the door and the reaction decided again from the start. It writes nothing before its end.
//   3. The write stands on what was read (`expected`); a reaction another page changed meanwhile is decided again on
//      the record as it is now, at most MOST_TRIES times.
//   4. Any other path or method answers 404 { error: 'Not found.' }, as src/work-responses.mjs answered.
//
import { privateResponses } from '../src/private-responses.mjs';

const TYPE = 'private-response';
const CONFLICT = 'original_command_conflict';
const MOST_TRIES = 4;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

class Missing { constructor(id) { this.id = id; } }

/** One decision over the records read so far: its answer and the writes it made, or Missing. */
function decide(held, body) {
  const writes = [];
  // What this decision wrote reads back as written, as the store's own read after its write did.
  const written = new Map();
  const eeaf = {
    read: id => { if (written.has(id)) return written.get(id); if (!held.has(id)) throw new Missing(id); return held.get(id); },
    write: rows => { for (const row of rows) { writes.push(row); written.set(row.id, row.value); } },
  };
  return { answer: privateResponses(eeaf).react(body), writes };
}

async function react(body, door) {
  for (let tries = 1; ; tries += 1) {
    const held = new Map();
    let run;
    for (;;) {
      try { run = decide(held, body); break; } catch (error) {
        if (!(error instanceof Missing)) throw error;
        const read = await door.readRecord(TYPE, error.id);
        held.set(error.id, read && read.value !== null && read.value !== undefined ? read.value : null);
      }
    }
    if (!run.writes.length) return run.answer;
    const writes = run.writes.map(({ id, type, value }) => {
      const before = held.get(id) ?? null;
      return { id, type, value, expected: before === null ? null : { type, value: before } };
    });
    try {
      await door.write(writes, { key: `responses-react:${writes[0].id}:${JSON.stringify(writes[0].value.rows).length}:${Date.now()}:${tries}` });
      return run.answer;
    } catch (error) {
      if (error?.code !== CONFLICT || tries >= MOST_TRIES) throw error;
    }
  }
}

/** tool:answer-the-react-privately-route */
export async function answerReactRoute(input = {}, { door } = {}) {
  const path = String(input?.path ?? '');
  const method = String(input?.method ?? 'GET').toUpperCase();
  if (!(method === 'POST' && path === '/responses/react')) return { status: 404, body: { error: 'Not found.' } };
  try {
    const body = typeof input.body === 'string' ? JSON.parse(input.body || '{}') : object(input.body) ? input.body : {};
    return { status: 200, body: await react(body, door) };
  } catch (error) {
    if (error?.code) throw error;
    return { status: 400, body: { error: error.message } };
  }
}
