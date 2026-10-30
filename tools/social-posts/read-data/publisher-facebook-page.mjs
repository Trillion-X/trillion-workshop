// tools/social-posts/read-data/publisher-facebook-page.mjs
//
// Purpose: the publisher bound to the name `facebook-page` (read-data/send-a-post.mjs PUBLISHERS), shaped like the
// @opencoredev/social-sdk publishers so read-data/send-a-post.mjs drives it the same way: one approved post becomes one post
// on the person's own Facebook Page. The SDK has no Facebook Page publisher, so this is one of the publishers shaped like
// it for a place it does not reach (as read-data/publisher-substack.mjs is). The post-place row
// (read-data/post-places.json, platform facebook) hands in the Page's token as a stand-in that only the held fetch
// turns into the real value, and only for the hosts that row allows.
//
//   words only          POST https://graph.facebook.com/<version>/<page id>/feed     { message }
//   with a picture      POST https://graph.facebook.com/<version>/<page id>/photos   { url, caption }
//   with a video        POST https://graph.facebook.com/<version>/<page id>/videos   { file_url, description }
//
// Read 2026-10-05 from developers.facebook.com/docs/pages-api/posts (a Page token with pages_manage_posts and
// pages_read_engagement; the person needs the CREATE_CONTENT task on the Page).
//
// Non-Negotiable Invariants:
//   1. Nothing is published unless social-posts.mjs was asked to publish an approved post; this file never decides that.
//   2. It holds no token: `auth.accessToken` is a stand-in, and every request goes through the fetch it is handed.
//   3. A post goes only to the Page the connection was made for (`pageId`); a target for any other account is refused.
//   4. A request cut off after it was sent may have published the post, so its outcome is "not known", never retried here.
//
import { SocialError, platformPostRef } from '@opencoredev/social-sdk';

const PLATFORM = 'facebook';
const THROTTLED = new Set([4, 17, 32, 613]);
const fail = (operation, message, code = 'upstream_failure', extra = {}) => {
  throw new SocialError({ code, operation, message, retryDisposition: { kind: code === 'invalid_input' ? 'never' : code === 'unauthorized' ? 'after-reconnect' : 'reconcile-first' }, ...extra });
};

/**
 * @param {object} options
 * @param {{ accessToken: string }} options.auth   the Page's token (a stand-in the held fetch fills)
 * @param {string} options.pageId                  the Page the connection was made for
 * @param {string} [options.apiVersion]            the Graph API version
 * @param {typeof fetch} options.fetch              the held fetch
 */
export function facebookPage({ auth, pageId, apiVersion = 'v23.0', fetch: send, backend = 'default' }) {
  const graph = `https://graph.facebook.com/${apiVersion}`;
  async function call(operation, path, body) {
    let response;
    try {
      response = await send(`${graph}${path}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${auth.accessToken}` }, body: JSON.stringify(body) });
    } catch (error) {
      if (error instanceof SocialError) throw error;
      fail(operation, 'The request was cut off, so it is not known whether Facebook published the post.', 'ambiguous_outcome', { cause: error });
    }
    const text = await response.text();
    let reply = null;
    try { reply = text ? JSON.parse(text) : null; } catch { reply = null; }
    const problem = reply?.error;
    if (response.status === 401 || problem?.code === 190) fail(operation, 'Facebook no longer accepts this Page\'s sign-in.', 'unauthorized', { upstreamStatus: response.status });
    if (response.status === 429 || THROTTLED.has(problem?.code)) fail(operation, 'Facebook is busy and asked to try again later.', 'rate_limited', { upstreamStatus: response.status });
    if (!response.ok) fail(operation, `Facebook answered ${response.status}: ${String(problem?.message ?? text).slice(0, 200)}`, response.status < 500 ? 'invalid_input' : 'ambiguous_outcome', { upstreamStatus: response.status });
    return reply ?? {};
  }
  const mine = account => account.backend === backend && account.platform === PLATFORM && account.accountId === pageId;
  return {
    capabilities: {
      backend,
      apiRevision: `Graph API ${apiVersion}`,
      runtime: ['workerd', 'node>=22.12'],
      capabilities: [{ operation: 'posts.publish', platform: PLATFORM, availability: 'available', formats: ['text', 'image', 'video'] }],
    },
    posts: {
      prepareTarget(target) {
        const issues = [];
        const add = (code, message) => issues.push({ code, message, severity: 'error', targetIndex: target.targetIndex });
        const media = target.content.media ?? [];
        if (!mine(target.account)) add('target.account_mismatch', 'This post is not for the connected Facebook Page.');
        if (!String(target.content.text ?? '').trim() && !media.length) add('content.empty', 'A Facebook post needs words, a picture or a video.');
        if (media.length > 1) add('media.too_many', 'A Facebook post sent here carries one picture or one video.');
        if (media.some(item => item.source?.kind !== 'https-url')) add('media.address', 'A Facebook post\'s picture or video must be at a public address.');
        if (target.schedule) add('schedule.unsupported', 'A Facebook post is sent at its time by its own run.');
        return issues;
      },
      async publishTarget(target) {
        const text = String(target.content.text ?? '');
        const media = target.content.media?.[0] ?? null;
        const made = !media
          ? await call('facebook.feed.publish', `/${encodeURIComponent(pageId)}/feed`, { message: text })
          : media.kind === 'image'
            ? await call('facebook.photos.publish', `/${encodeURIComponent(pageId)}/photos`, { url: media.source.url, ...(text ? { caption: text } : {}) })
            : await call('facebook.videos.publish', `/${encodeURIComponent(pageId)}/videos`, { file_url: media.source.url, ...(text ? { description: text } : {}) });
        const postId = String(made.post_id ?? made.id ?? '');
        if (!postId) fail('facebook.publish', 'Facebook kept no post for this.', 'ambiguous_outcome');
        return {
          state: 'published', targetIndex: target.targetIndex, account: target.account, observedAt: new Date().toISOString(),
          url: `https://www.facebook.com/${postId}`,
          post: platformPostRef({ backend, platform: PLATFORM, accountId: target.account.accountId, postId }),
        };
      },
    },
  };
}
