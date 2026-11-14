/* Source-owned sequence callback runtime. API behavior adapted from Showtime's
 * MIT stage.js (Copyright (c) 2026 Favio Vazquez), see sequence-stage-LICENSE.
 * It registers readiness and seek callbacks only. Page timers are owned by the
 * existing browser clock; there is no preview player, redirect or timer shim.
 */
(() => {
  'use strict';
  if (window.ST) throw new Error('A sequence callback owner is already installed.');
  const callbacks = new Set(), waits = [];
  let t = 0, seeking = false, failure = null;
  const api = {
    get t() { return t; },
    onSeek(callback) {
      if (typeof callback !== 'function') throw new TypeError('onSeek needs a function.');
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    waitFor(value, label = 'Sequence readiness') {
      const promise = Promise.resolve(typeof value === 'function' ? value() : value);
      promise.catch(() => {});
      waits.push(promise.catch(error => { throw new Error(`${label}: ${error?.message ?? error}`); }));
      waits.at(-1).catch(() => {});
      return value;
    },
    async ready() {
      if (failure) throw failure;
      if (document.fonts) await document.fonts.ready;
      try { while (waits.length) await Promise.all(waits.splice(0)); }
      catch (error) { failure = error; throw error; }
    },
    async seek(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError('Sequence time must be finite and nonnegative.');
      if (seeking) throw new Error('A sequence seek is already in progress.');
      seeking = true;
      try {
        await api.ready(); t = seconds;
        for (const callback of callbacks) await callback(t);
        await api.ready();
      } finally { seeking = false; }
      return t;
    },
  };
  window.ST = Object.freeze(api);
})();
