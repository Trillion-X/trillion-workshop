const abortError = () => new DOMException('The addressed presentation is closed', 'AbortError');
const keyOf = binding => JSON.stringify([binding.address, binding.generation, binding.state_key ?? null]);
const matches = (frame, binding) => frame?.address === binding.address && frame?.generation === binding.generation;
const terminal = error => error?.revoked === true || error?.code === 'revoked' || [401, 403, 404, 410, 4401, 4404].includes(error?.status ?? error?.statusCode);
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', cancel); resolve(); }
  function cancel() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(abortError()); }
  signal?.addEventListener('abort', cancel, { once: true });
});

export function createAddressedPresentationClient({ invoke, subscribe, paint, savedState, onError = () => {}, retry = attempt => Math.min(1000 * 2 ** Math.min(attempt, 5), 30000), delay = wait }) {
  let active;
  const report = error => { try { onError(error); } catch {} };
  async function clearOnTerminal(error, key, session) {
    if (!terminal(error)) return false;
    try { await savedState?.delete?.(key); } catch (stateError) { report(stateError); }
    if (!session.settled) { session.settled = true; session.rejectReady(error); }
    report(error);
    session.close();
    return true;
  }

  function open(binding, { signal: parentSignal, cursor: initialCursor } = {}) {
    active?.close();
    const controller = new AbortController(), { signal } = controller, key = keyOf(binding);
    let alive = true, dirty = false, reading = false, established = false, cursor = initialCursor, attempt = 0;
    const waiters = [];
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const session = {
      ready, binding, settled: false, rejectReady,
      close() {
        if (!alive) return;
        alive = false; controller.abort(); parentSignal?.removeEventListener('abort', parentAbort);
        for (const w of waiters.splice(0)) w.reject(abortError());
        if (!session.settled) { session.settled = true; rejectReady(abortError()); }
        if (active === session) active = undefined;
      },
      refresh() {
        if (!current()) return Promise.reject(abortError());
        dirty = true;
        const done = new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        void drain();
        return done;
      }
    };
    const current = () => alive && !signal.aborted && active === session;
    const parentAbort = () => session.close();
    active = session;
    parentSignal?.addEventListener('abort', parentAbort, { once: true });
    if (parentSignal?.aborted) parentAbort();

    const acceptSnapshot = async snapshot => {
      if (!current()) return;
      if (!matches(snapshot, binding) || snapshot.current !== true || !Object.hasOwn(snapshot, 'value')) throw new Error('Read did not return an explicit current snapshot for this binding');
      const painted = await paint(snapshot.value, { binding, snapshot, signal });
      if (!current()) return;
      if (painted?.current !== true) throw new Error('Painter did not confirm a meaningful current paint');
      cursor = snapshot.cursor;
      if (savedState?.set) await savedState.set(key, cursor);
      if (!current()) return;
      if (!session.settled) { session.settled = true; resolveReady(snapshot); }
    };
    async function drain() {
      if (reading || !established || !current()) return;
      reading = true;
      try {
        while (dirty && current()) {
          dirty = false;
          const snapshot = await invoke({ address: binding.address, generation: binding.generation, operation: binding.read?.operation ?? 'read-current', input: binding.read?.input, cursor }, { binding, signal });
          if (current()) await acceptSnapshot(snapshot);
        }
      } catch (error) {
        for (const w of waiters.splice(0)) w.reject(error);
        if (current()) {
          if (await clearOnTerminal(error, key, session)) return;
          if (!session.settled) { session.settled = true; rejectReady(error); }
          report(error);
        }
      } finally {
        reading = false;
        if (!dirty && current()) for (const w of waiters.splice(0)) w.resolve();
        else if (!current()) for (const w of waiters.splice(0)) w.reject(abortError());
        else if (dirty && established) queueMicrotask(() => { void drain(); });
      }
    }
    async function consume() {
      if (cursor === undefined && savedState?.get) {
        try { cursor = await savedState.get(key); } catch (error) { if (current()) report(error); }
      }
      while (current()) {
        try {
          const source = await subscribe({ address: binding.address, generation: binding.generation, operation: 'subscribe', input: binding.read?.input, cursor }, { binding, signal });
          if (!current()) return;
          established = true;
          attempt = 0;
          dirty = true;
          void drain();
          for await (const frame of source) {
            if (!current()) return;
            if (matches(frame, binding)) { dirty = true; void drain(); }
          }
          if (!current()) return;
          throw new Error('Addressed subscription ended');
        } catch (error) {
          if (!current()) return;
          established = false;
          if (await clearOnTerminal(error, key, session)) return;
          report(error);
          try { await delay(retry(attempt++), signal); } catch { return; }
        }
      }
    }
    if (current()) void consume();
    return session;
  }

  async function mutate(binding, { operation, input, request_key, signal } = {}) {
    if (signal?.aborted) throw abortError();
    if (typeof request_key !== 'string' || request_key.length === 0) throw new TypeError('mutate requires a stable request_key');
    let result;
    try { result = await invoke({ address: binding.address, generation: binding.generation, operation, input, request_key }, { binding, signal }); }
    catch (error) {
      if (terminal(error)) {
        try { await savedState?.delete?.(keyOf(binding)); } catch (stateError) { report(stateError); }
        const current = active;
        if (current && keyOf(current.binding) === keyOf(binding)) current.close();
        report(error);
      }
      throw error;
    }
    const session = active;
    if (session && keyOf(session.binding) === keyOf(binding)) await session.refresh();
    return result;
  }
  return { open, mutate, close() { active?.close(); } };
}
