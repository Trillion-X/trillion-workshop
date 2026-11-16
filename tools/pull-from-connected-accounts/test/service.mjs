// Stand-ins for the tests: a service that answers from a function, and the caller that keeps what pulls answer.

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

/**
 * Stands in for the caller, who keeps what pulls answer: threads replaced by id, items by id, the cursor and who the
 * account is. `held` is what it hands back to the next pull of the same source and account.
 */
export function keeper() {
  const kept = new Map();
  const keyOf = (source, account = 'default') => `${source}\u0000${account}`;
  const empty = () => ({ self_id: null, cursor: undefined, threads: [], collections: {} });
  const replaced = (list, item) => { const at = list.findIndex(held => String(held.id) === String(item.id)); if (at < 0) list.push(item); else list[at] = item; };
  return {
    held: (source, account) => (kept.has(keyOf(source, account)) ? structuredClone(kept.get(keyOf(source, account))) : undefined),
    keep(source, account, answer) {
      const held = structuredClone(kept.get(keyOf(source, account)) ?? empty());
      if (answer.status === 'pulled' || answer.status === 'partial') {
        held.self_id = answer.self_id;
        if (answer.cursor !== null && answer.cursor !== undefined) held.cursor = answer.cursor;
        for (const thread of answer.threads) replaced(held.threads, thread);
        for (const [name, items] of Object.entries(answer.collections)) { held.collections[name] ??= []; for (const item of items) replaced(held.collections[name], item); }
        kept.set(keyOf(source, account), held);
      }
    },
    snapshot: (source, account) => structuredClone(kept.get(keyOf(source, account)) ?? empty()),
  };
}

export const noWait = async () => {};
export const waits = () => { const asked = []; return { asked, wait: async ms => { asked.push(ms); } }; };
