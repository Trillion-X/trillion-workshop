// The server-rendered adapter of MediaPreview's loading / ready / failed picture states.
// No record kind, route, replacement picture or original-file address belongs here.
import recovery from './picture-readiness.json' with { type: 'json' };
import quietRetry from '../request/quiet-retry.json' with { type: 'json' };

export const PICTURE_READINESS_POLICY = { ...recovery, busy_statuses: quietRetry.busy_statuses };

/** Watch one existing image. A type mark is a failed/absent fallback, never a loaded picture.
 * This function is self-contained so the same implementation runs in the small SSR page script. */
export function watchPictureReadiness(image, frame, rules, environment = globalThis) {
  const source = image.getAttribute('src');
  const waits = Array.isArray(rules?.waits_ms) ? rules.waits_ms.slice(0, 2).map(ms => Number.isFinite(ms) ? Math.min(2000, Math.max(0, ms)) : 0) : [];
  const timeout = Number.isFinite(rules?.head_timeout_ms) && rules.head_timeout_ms > 0 ? Math.min(5000, rules.head_timeout_ms) : 5000;
  let stopped = false, terminal = false, recovering = false, attempts = 0;
  let waitTimer = null, headTimer = null, pending = null;
  const current = () => !stopped && image.isConnected !== false && image.getAttribute('src') === source;
  const show = state => {
    frame.setAttribute('data-picture-state', state);
    frame.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
    // Keep a lazy image in layout while it loads. display:none can prevent its native request from starting.
    image.hidden = state === 'failed';
    const loading = frame.querySelector('[data-picture-loading]');
    const unavailable = frame.querySelector('[data-picture-unavailable]');
    if (loading) loading.hidden = state !== 'loading';
    if (unavailable) unavailable.hidden = state !== 'failed';
  };
  const cancel = () => {
    if (waitTimer !== null) environment.clearTimeout(waitTimer);
    if (headTimer !== null) environment.clearTimeout(headTimer);
    waitTimer = headTimer = null;
    pending?.abort();
    pending = null;
  };
  let sameOrigin = false;
  try {
    const at = new URL(source, environment.location.href);
    sameOrigin = at.origin === new URL(environment.location.href).origin && /^https?:$/.test(at.protocol);
  } catch {}
  const ready = () => {
    if (terminal || !current() || !image.complete || !(image.naturalWidth > 0)) return false;
    cancel();
    recovering = false;
    show('ready');
    return true;
  };
  const finish = () => { terminal = true; recovering = false; if (current()) show('failed'); };
  const recover = () => {
    if (terminal || !current() || recovering || ready()) return;
    if (!source || !sameOrigin || attempts >= waits.length || typeof environment.fetch !== 'function') { finish(); return; }
    recovering = true;
    show('loading');
    const delay = Math.max(0, Number(waits[attempts++]) || 0);
    waitTimer = environment.setTimeout(async () => {
      waitTimer = null;
      if (!current()) { recovering = false; return; }
      let status = 0, responseType = null, timedOut = false;
      const controller = new environment.AbortController();
      pending = controller;
      headTimer = environment.setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
      try {
        // An image error has no HTTP status. Check the same current grant before retrying its bytes.
        // Redirects, authorization, payment, missing files and all other permanent answers end here.
        const response = await environment.fetch(source, { method: 'HEAD', credentials: 'same-origin',
          redirect: 'manual', referrerPolicy: 'no-referrer', signal: controller.signal });
        status = response.status;
        responseType = response.type;
      } catch (error) {
        if (error?.name === 'AbortError' && !timedOut) { recovering = false; return; }
      } finally {
        if (headTimer !== null) environment.clearTimeout(headTimer);
        headTimer = null;
        if (pending === controller) pending = null;
      }
      if (!current() || ready()) return;
      recovering = false;
      if (responseType === 'opaqueredirect' || responseType === 'opaque') finish();
      else if (status >= 200 && status < 300) {
        // Reassign the exact supplied URL; no cache busting or alternate delivery is admitted.
        image.removeAttribute('src');
        image.setAttribute('src', source);
      } else if (status === 0 || rules.busy_statuses?.includes(status)) recover();
      else finish();
    }, delay);
  };
  const loaded = () => { if (!ready()) recover(); };
  const failed = () => { if (current()) recover(); };
  image.addEventListener('load', loaded);
  image.addEventListener('error', failed);
  if (!ready()) {
    show('loading');
    // A cached failure can be complete too. naturalWidth is the difference between bytes and a broken image.
    if (image.complete) recover();
  }
  return () => {
    if (current() && frame.getAttribute('data-picture-state') === 'loading') show('failed');
    stopped = true;
    cancel();
    image.removeEventListener('load', loaded);
    image.removeEventListener('error', failed);
  };
}

/** One observer admits later cards and cleans up removed ones. No healthy picture has a timer or extra request. */
export function bindPagePictureReadiness(document, watch, rules, environment = globalThis) {
  const pictures = new Map();
  const within = root => {
    const images = root.matches?.('img[data-picture-source]') ? [root] : [];
    images.push(...(root.querySelectorAll?.('img[data-picture-source]') ?? []));
    return images;
  };
  const admit = root => {
    for (const image of within(root)) {
      const frame = image.closest('[data-picture-frame]');
      if (!frame) continue;
      const source = image.getAttribute('src');
      const old = pictures.get(image);
      if (old?.source === source && old?.frame === frame) continue;
      old?.stop();
      pictures.set(image, { source, frame, stop: watch(image, frame, rules, environment) });
    }
  };
  const observer = typeof environment.MutationObserver === 'function' ? new environment.MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') admit(record.target);
      else {
        for (const node of record.addedNodes) admit(node);
        for (const node of record.removedNodes) for (const image of within(node)) {
          if (image.isConnected) continue;
          pictures.get(image)?.stop();
          pictures.delete(image);
        }
      }
    }
  }) : null;
  const start = () => {
    admit(document);
    observer?.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  };
  const pause = () => {
    observer?.disconnect();
    for (const held of pictures.values()) held.stop();
    pictures.clear();
  };
  start();
  environment.addEventListener?.('pagehide', pause);
  environment.addEventListener?.('pageshow', start);
  return () => {
    pause();
    environment.removeEventListener?.('pagehide', pause);
    environment.removeEventListener?.('pageshow', start);
  };
}

export const PICTURE_READINESS_SCRIPT = `(() => {
  const watch = ${watchPictureReadiness.toString()};
  (${bindPagePictureReadiness.toString()})(document, watch, ${JSON.stringify({ waits_ms: PICTURE_READINESS_POLICY.waits_ms, head_timeout_ms: PICTURE_READINESS_POLICY.head_timeout_ms, busy_statuses: PICTURE_READINESS_POLICY.busy_statuses }).replace(/</g, '\\u003c')});
})();`;
