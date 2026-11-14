// A caller's latest complete value, kept in order. Moving controls updates the
// preview immediately; writes settle briefly, serialize, and flush on departure.
// A failed write stays pending and can be retried with the latest value.
export function createSettledWrite({ write, delay = 600, onError = () => {}, onSaved = () => {} }) {
  let pending;
  let timer;
  let flight;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  async function drain() {
    while (pending !== undefined) {
      const value = pending;
      pending = undefined;
      try {
        await write(value);
        onSaved();
      } catch (error) {
        if (pending === undefined) pending = value;
        onError(error);
        throw error;
      }
    }
  }
  function flush() {
    clear();
    if (!flight && pending !== undefined) flight = drain().finally(() => { flight = undefined; });
    return flight ?? Promise.resolve();
  }
  return {
    put(value) {
      pending = structuredClone(value);
      clear();
      timer = setTimeout(() => { void flush().catch(() => {}); }, delay);
    },
    flush,
    get pending() { return pending !== undefined || Boolean(flight); },
  };
}
