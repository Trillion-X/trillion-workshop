// Stand-ins for the tests: a service that answers from a function, and the person's records door with exactly the rights a pull row declares.
import { after } from 'node:test';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

/** A fetch that asks `answer(url, init)` and wraps what it returns ({ status, body, headers }) as a response. It keeps every call. */
export function fakeService(answer) {
  const calls = [];
  const fetch = async (address, init) => {
    const url = new URL(address);
    calls.push({ url, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: init.headers });
    const said = await answer(url, init, calls.length);
    if (said instanceof Error) throw said;
    const { status = 200, body = {}, headers = {} } = said;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
  return { fetch, calls };
}

/** The pull rows' rights, as the row declares them. */
export const pullRights = rows.records.find(record => record.payload.id === 'tool:pull-my-discord-messages').payload.invoke.records.rights;

// Doors are closed when the file's tests end, so a failing test never keeps the process alive.
const closers = [];
after(() => Promise.all(closers.map(close => close())));

export async function openDoor({ rights = pullRights, records = [] } = {}) {
  const fake = await startFakeDoor({ rights, records });
  closers.push(fake.close);
  return { door: openRecordsDoor({ descriptor: fake.descriptor, wait: async () => {} }), kept: fake.kept, calls: fake.calls };
}

export const noWait = async () => {};
export const waits = () => { const asked = []; return { asked, wait: async ms => { asked.push(ms); } }; };
