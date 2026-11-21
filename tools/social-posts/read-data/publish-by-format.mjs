// tools/social-posts/read-data/publish-by-format.mjs
//
// Purpose: send a post whose format the format map (read-data/post-formats.json) names: its container with the format's own
// settings (a trial reel's trial_params, a story's STORIES media type), the wait for the container to be FINISHED (the shared
// loop in read-data/poll-until-finished.mjs), then media_publish. It runs inside tool:send-a-post after that tool's consent
// gates and place checks, and it is handed the same held-token fetch the SDK's publisher is handed, so the access token goes
// only to the place's own Graph origin, as the request leaves.
//
// Non-negotiable invariants:
// 1. Publishing happens only after the container is FINISHED. ERROR, EXPIRED and a cap reached answer failed, and nothing is
//    published.
// 2. The access token is never written anywhere: it reaches the request only through the fetch (a one-use stand-in in the
//    query string, put in place as the request leaves).
import formatMap from './post-formats.json' with { type: 'json' };
import { pollUntilFinished } from './poll-until-finished.mjs';

/** The format's spec from the map, or null when no format of that name is mapped (the caller keeps its own route). */
export function formatOf(name) {
  return typeof name === 'string' && Object.hasOwn(formatMap.formats, name) ? formatMap.formats[name] : null;
}

// The Graph error a request answered with, as its message.
async function graph(send, url, init) {
  const answer = await send(url, init);
  const text = await answer.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 200) }; }
  if (!answer.ok || body.error) throw new Error(`Instagram answered ${answer.status}${body.error?.message ? `: ${body.error.message}` : ''}`);
  return body;
}

/** The container for a format, made with its settings. Answers the container id. */
async function makeContainer({ spec, origin, igId, token, send, mediaUrl, mediaKind, caption }) {
  const body = { media_type: spec.container.media_type, caption };
  body[mediaKind === 'image' && spec.container.image_field ? spec.container.image_field : spec.container.video_field] = mediaUrl;
  if (spec.container.trial_params) body.trial_params = spec.container.trial_params;
  const made = await graph(send, `${origin}/${encodeURIComponent(igId)}/media?access_token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!made.id) throw new Error('Instagram made no container.');
  return String(made.id);
}

/** Send a post by its format. Answers {state: 'published', post: {postId}}, or {state: 'failed', message, retryDisposition} when
 *  the container is not FINISHED or Instagram refuses a request. */
export async function publishByFormat({ format, options, accountId, mediaUrl, mediaKind = 'video', caption = '', send = fetch, sleep, maxTries, everySeconds }) {
  const spec = formatOf(format);
  if (!spec) throw new Error(`No format ${String(format)} is mapped, so nothing was sent by its steps.`);
  const origin = formatMap.graph[spec.platform].origin;
  const token = options?.auth?.accessToken;
  if (typeof token !== 'string' || !token) throw new Error(`The ${spec.platform} connection holds no token for ${spec.label}.`);
  const wait = { maxTries: maxTries ?? spec.wait.max_tries, everySeconds: everySeconds ?? spec.wait.every_seconds };
  try {
    const containerId = await makeContainer({ spec, origin, igId: accountId, token, send, mediaUrl, mediaKind, caption });
    const status = await pollUntilFinished({
      readStatus: async () => {
        const state = await graph(send, `${origin}/${encodeURIComponent(containerId)}?fields=status_code,status&access_token=${token}`, { method: 'GET' });
        return state.status_code ?? null;
      },
      maxTries: wait.maxTries,
      everySeconds: wait.everySeconds,
      sleep,
    });
    if (!status.ok) {
      return { state: 'failed', code: 'media_error', message: `${spec.label} container ${containerId} is ${status.status_code ?? 'unknown'} after ${status.tries} status asks, so nothing was published.`, retryDisposition: { kind: 'never' } };
    }
    const published = await graph(send, `${origin}/${encodeURIComponent(accountId)}/media_publish?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creation_id: containerId }),
    });
    if (!published.id) return { state: 'unknown', reason: 'unmapped-state', diagnostic: `${spec.label} publish answered without an id.` };
    return { state: 'published', post: { kind: 'platform-post', postId: String(published.id) }, delivery: { container_id: containerId } };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { state: 'failed', code: 'media_error', message: error.message, retryDisposition: { kind: 'never' } };
  }
}
