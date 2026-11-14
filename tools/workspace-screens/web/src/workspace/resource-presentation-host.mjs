// The native workspace's supplied HTTP + WS/WSS carrier. An embedded/native host
// can install callable operations without teaching screens a provider switch.
// Every screen uses the same logical binding regardless of where its bytes live.
let installed;
const actionListeners = new Set();
/** Page-local invalidation after an accepted action; no rows or history are kept. */
export function onResourceAction(listener) { actionListeners.add(listener); return () => actionListeners.delete(listener); }
export function resourceActionReturned(envelope) { for (const listener of actionListeners) listener(envelope); }
const stopped = () => Object.assign(new Error('Resource subscription cancelled'), { name: 'AbortError' });

export function installResourcePresentationHost(host) {
  if (typeof host?.invoke !== 'function' || typeof host?.subscribe !== 'function') throw new TypeError('Callable invoke and subscribe supplies are required.');
  const previous = installed;
  installed = host;
  return () => { if (installed === host) installed = previous; };
}

export function nativeResourcePresentationHost({ readJson, openSocket = url => new WebSocket(url), origin = () => location.origin }) {
  return {
    invoke(envelope, { signal } = {}) {
      // Changes are dispatched once. A transport error is uncertainty, not a
      // reason to issue this effect again on a different host.
      return readJson('/work/api/resources/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope), signal }, false, { applyFocus: false });
    },
    async subscribe(envelope, { signal } = {}) {
      if (signal?.aborted) throw stopped();
      const url = new URL('/work/live/resources', origin());
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('binding', JSON.stringify(envelope));
      const socket = openSocket(url.href);
      let wake, dirty, error, ended = false;
      const close = () => { ended = true; wake?.(); try { socket.close(1000); } catch {} signal?.removeEventListener('abort', close); };
      let abortOpening;
      const ready = new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(new Error('Resource carrier could not open')), { once: true });
        socket.addEventListener('close', event => reject(Object.assign(new Error('Resource carrier closed'), { status: event.code === 4401 ? 403 : event.code === 4404 ? 404 : 503 })), { once: true });
        abortOpening = () => reject(stopped());
        signal?.addEventListener('abort', abortOpening, { once: true });
      });
      socket.addEventListener('message', event => {
        let frame;
        try { frame = JSON.parse(String(event.data)); } catch { return; }
        if (frame.address !== envelope.address || frame.generation !== envelope.generation) return;
        // Only invalidations are queued. The explicit current read determines
        // rendered data and cursor; bounded queue size is one regardless of load.
        dirty = { address: frame.address, generation: frame.generation };
        wake?.();
      });
      socket.addEventListener('close', event => {
        error = Object.assign(new Error('Resource carrier closed'), { status: event.code === 4401 ? 403 : event.code === 4404 ? 404 : 503 });
        ended = true; wake?.();
      });
      signal?.addEventListener('abort', close, { once: true });
      try { await ready; } catch (failure) { close(); throw failure; }
      finally { signal?.removeEventListener('abort', abortOpening); }
      return (async function* () {
        try {
          while (!signal?.aborted) {
            if (dirty) { const frame = dirty; dirty = undefined; yield frame; continue; }
            if (ended) { if (error) throw error; return; }
            await new Promise(resolve => { wake = resolve; });
            wake = undefined;
          }
        } finally { close(); }
      })();
    },
  };
}

export function resourcePresentationHost(native) { return installed ?? native; }

/** Request/reply hosts use the resource's parked change read through their
 * existing authenticated bridge. A timeout reopens that same subscription;
 * it never dispatches business effects or advances the rendered cursor. */
export function requestResourcePresentationHost({ readJson }) {
  const native = nativeResourcePresentationHost({ readJson });
  return {
    invoke: native.invoke,
    async subscribe(envelope, { signal } = {}) {
      const first = await native.invoke({ ...envelope, operation: 'subscribe-next', cursor: undefined }, { signal });
      return (async function* () {
        let cursor = first.cursor;
        yield first;
        while (!signal?.aborted) {
          const frame = await native.invoke({ ...envelope, operation: 'subscribe-next', cursor }, { signal });
          if (frame.idle) continue;
          cursor = frame.cursor;
          yield frame;
        }
      })();
    },
  };
}
