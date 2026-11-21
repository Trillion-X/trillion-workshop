// tools/social-posts/read-data/publish-by-format.mjs
//
// Purpose: send a post whose format the format map (read-data/post-formats.json) names: its container (or, for a carousel, one
// container per item and a CAROUSEL container over them) with the format's own settings, the wait for each container to be
// FINISHED (the shared loop in read-data/poll-until-finished.mjs), then media_publish; and then, when the format names a
// follow_with, the cover story after the main post. It runs inside tool:send-a-post after that tool's consent gates and place
// checks, and it is handed the same held-token fetch the SDK's publisher is handed, so the access token goes only to the
// place's own Graph origin, as the request leaves.
//
// Non-negotiable invariants:
// 1. Publishing happens only after each container it depends on is FINISHED. ERROR, EXPIRED and a cap reached answer failed,
//    and nothing is published.
// 2. The access token is never written anywhere: it reaches the request only through the fetch (a one-use stand-in in the
//    query string, put in place as the request leaves).
// 3. The cover story is sent only after the main post is published, and its failure never turns the main post's outcome into
//    a failure: it is reported beside it.
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

/** A container made from a body, waited on until FINISHED. Answers {ok, id, status_code, message}. */
async function madeAndFinished({ origin, igId, token, send, body, wait, sleep }) {
  const made = await graph(send, `${origin}/${encodeURIComponent(igId)}/media?access_token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!made.id) throw new Error('Instagram made no container.');
  const id = String(made.id);
  const status = await pollUntilFinished({
    readStatus: async () => {
      const state = await graph(send, `${origin}/${encodeURIComponent(id)}?fields=status_code,status&access_token=${token}`, { method: 'GET' });
      return state.status_code ?? null;
    },
    maxTries: wait.maxTries,
    everySeconds: wait.everySeconds,
    sleep,
  });
  return { ok: status.ok, id, status_code: status.status_code, tries: status.tries };
}

const notFinished = (label, container) => `${label} container ${container.id} is ${container.status_code ?? 'unknown'} after ${container.tries} status asks, so nothing was published.`;

/** Send a post by its format. Answers {state: 'published', post: {postId}, delivery}, or {state: 'failed', message,
 *  retryDisposition} when a container is not FINISHED or Instagram refuses a request. `media` is [{url, kind}]: one item for a
 *  reel or story, two to ten for a carousel. `cover` is the https address of the cover image a follow_with story is made from. */
export async function publishByFormat({ format, options, media, cover, caption = '', send = fetch, sleep, maxTries, everySeconds }) {
  const spec = formatOf(format);
  if (!spec) throw new Error(`No format ${String(format)} is mapped, so nothing was sent by its steps.`);
  const origin = formatMap.graph[spec.platform].origin;
  const token = options?.auth?.accessToken;
  if (typeof token !== 'string' || !token) throw new Error(`The ${spec.platform} connection holds no token for ${spec.label}.`);
  // The Graph account is the place's own account id (its ig_user_id), not the connection's id.
  const accountId = options?.auth?.accountId;
  if (typeof accountId !== 'string' || !accountId) throw new Error(`The ${spec.platform} connection holds no account id for ${spec.label}.`);
  const wait = { maxTries: maxTries ?? spec.wait.max_tries, everySeconds: everySeconds ?? spec.wait.every_seconds };
  const request = { origin, igId: accountId, token, send, wait, sleep };
  try {
    let main;
    if (spec.children) {
      const children = [];
      for (const item of media) {
        const kind = item.kind === 'image' ? spec.children.image : spec.children.video;
        const child = await madeAndFinished({ ...request, body: { media_type: kind.media_type, [kind.image_field ?? kind.video_field]: item.url, is_carousel_item: true } });
        if (!child.ok) return { state: 'failed', code: 'media_error', message: notFinished(`${spec.label} item`, child), retryDisposition: { kind: 'never' } };
        children.push(child.id);
      }
      const carousel = await madeAndFinished({ ...request, body: { media_type: spec.container.media_type, children: children.join(','), caption } });
      if (!carousel.ok) return { state: 'failed', code: 'media_error', message: notFinished(spec.label, carousel), retryDisposition: { kind: 'never' } };
      main = carousel;
    } else {
      const body = { media_type: spec.container.media_type, caption };
      body[media[0].kind === 'image' && spec.container.image_field ? spec.container.image_field : spec.container.video_field] = media[0].url;
      if (spec.container.trial_params) body.trial_params = spec.container.trial_params;
      main = await madeAndFinished({ ...request, body });
      if (!main.ok) return { state: 'failed', code: 'media_error', message: notFinished(spec.label, main), retryDisposition: { kind: 'never' } };
    }
    const published = await graph(send, `${origin}/${encodeURIComponent(accountId)}/media_publish?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creation_id: main.id }),
    });
    if (!published.id) return { state: 'unknown', reason: 'unmapped-state', diagnostic: `${spec.label} publish answered without an id.` };
    const follow = spec.follow_with ? await followWith({ spec, request, cover }) : null;
    return { state: 'published', post: { kind: 'platform-post', postId: String(published.id) }, delivery: { container_id: main.id, ...(follow ? { cover_story: follow } : {}) } };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { state: 'failed', code: 'media_error', message: error.message, retryDisposition: { kind: 'never' } };
  }
}

// The cover story after a main post: its format from the map, its image from the caller's cover address. Its outcome is
// reported beside the main post, never as the main post's failure.
async function followWith({ spec, request, cover }) {
  const next = formatOf(spec.follow_with.format);
  if (!cover) return { state: 'not sent', message: `No cover image was given, so ${next.label} was not posted.` };
  try {
    const story = await madeAndFinished({ ...request, body: { media_type: next.container.media_type, [next.container.image_field]: cover } });
    if (!story.ok) return { state: 'failed', message: notFinished(next.label, story) };
    const published = await graph(request.send, `${request.origin}/${encodeURIComponent(request.igId)}/media_publish?access_token=${request.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creation_id: story.id }),
    });
    return published.id ? { state: 'published', post_id: String(published.id), link_sticker: false } : { state: 'unknown' };
  } catch (error) {
    return { state: 'failed', message: error.message };
  }
}
