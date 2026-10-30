// tools/social-posts/read-data/publisher-substack.mjs
//
// Purpose: the publisher bound to the name `substack` (read-data/send-a-post.mjs PUBLISHERS), shaped like the @opencoredev/social-sdk
// publishers so read-data/send-a-post.mjs drives it the same way: one approved post becomes one Substack post on the
// person's own publication. Substack has no API key, so it is reached with the person's signed-in session, which the
// post-place row (read-data/post-places.json, platform substack) hands in as a stand-in that only the held fetch
// turns into the real value, and only for the hosts that row allows.
//
//   1. GET  https://substack.com/api/v1/user/profile/self           who is signed in, for the post's byline
//   2. POST https://<publication>/api/v1/drafts                       the post as a Substack draft
//   3. POST https://<publication>/api/v1/drafts/<id>/publish          that draft published (and emailed when `send`)
//
// The words arrive as Markdown (## and ### headings, paragraphs, - and 1. lists, > quotes, **bold**, *italic*,
// [links](https://...)) and are sent as Substack's post document.
//
// Non-Negotiable Invariants:
//   1. Nothing is published unless social-posts.mjs was asked to publish an approved post; this file never decides that.
//   2. It holds no session value: `auth.session` is a stand-in, and every request goes through the fetch it is handed.
//   3. A post needs a title (target options `title`); the subtitle, audience and whether subscribers are emailed come
//      from the options too, with the place row's default_settings filling what the post leaves out.
//   4. A Substack post here carries words only; a post with a video or picture is refused before anything is sent.
//
import { SocialError, platformPostRef } from '@opencoredev/social-sdk';

const PLATFORM = 'substack';
const fail = (operation, message, code = 'upstream_failure', extra = {}) => {
  throw new SocialError({ code, operation, message, retryDisposition: { kind: code === 'invalid_input' ? 'never' : code === 'unauthorized' ? 'after-reconnect' : 'reconcile-first' }, ...extra });
};

// Inline Markdown: **bold**, *italic* and [words](https://address).
function inline(text) {
  const out = [];
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
    if (found.index > last) out.push({ type: 'text', text: text.slice(last, found.index) });
    if (found[1]) out.push({ type: 'text', text: found[1], marks: [{ type: 'strong' }] });
    else if (found[2]) out.push({ type: 'text', text: found[2], marks: [{ type: 'em' }] });
    else out.push({ type: 'text', text: found[3], marks: [{ type: 'link', attrs: { href: found[4] } }] });
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out.filter(item => item.text.length);
}
const paragraph = text => ({ type: 'paragraph', content: inline(text) });

/** Markdown words as Substack's post document (the JSON its editor keeps). */
export function substackDocument(markdown) {
  const content = [];
  for (const block of String(markdown ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0]);
    if (heading && lines.length === 1) { content.push({ type: 'heading', attrs: { level: Math.min(Math.max(heading[1].length, 2), 4) }, content: inline(heading[2]) }); continue; }
    if (lines.every(line => /^[-*]\s+/.test(line))) { content.push({ type: 'bullet_list', content: lines.map(line => ({ type: 'list_item', content: [paragraph(line.replace(/^[-*]\s+/, ''))] })) }); continue; }
    if (lines.every(line => /^\d+[.)]\s+/.test(line))) { content.push({ type: 'ordered_list', attrs: { start: Number(/^\d+/.exec(lines[0])[0]), order: 1 }, content: lines.map(line => ({ type: 'list_item', content: [paragraph(line.replace(/^\d+[.)]\s+/, ''))] })) }); continue; }
    if (lines.every(line => line.startsWith('>'))) { content.push({ type: 'blockquote', content: [paragraph(lines.map(line => line.replace(/^>\s?/, '')).join(' '))] }); continue; }
    content.push(paragraph(lines.join(' ')));
  }
  return { type: 'doc', content: content.filter(node => node.type !== 'paragraph' || node.content.length) };
}

/**
 * @param {object} options
 * @param {{ session: string }} options.auth   the signed-in session (a stand-in the held fetch fills)
 * @param {string} options.publication         the publication's address, like https://name.substack.com
 * @param {typeof fetch} options.fetch          the held fetch
 */
export function substack({ auth, publication, fetch: send, backend = 'default' }) {
  const origin = new URL(publication).origin;
  const cookie = `substack.sid=${auth.session}`;
  // `goesPublic`: a request whose failure after sending may still have published, so it is never sent again by itself.
  async function call(operation, url, { method = 'GET', body, goesPublic = false } = {}) {
    let response;
    try {
      response = await send(url, {
        method,
        headers: { accept: 'application/json', cookie, origin, referer: `${origin}/publish/home`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (error instanceof SocialError || !goesPublic) throw error;
      fail(operation, 'The publish request was cut off, so it is not known whether Substack published the post.', 'ambiguous_outcome', { cause: error });
    }
    const text = await response.text();
    let reply = null;
    try { reply = text ? JSON.parse(text) : null; } catch { reply = null; }
    if (response.status === 401 || response.status === 403) fail(operation, 'Substack no longer accepts this sign-in.', 'unauthorized', { upstreamStatus: response.status });
    if (response.status === 429) fail(operation, 'Substack is busy and asked to try again later.', 'rate_limited', { upstreamStatus: 429 });
    if (!response.ok) fail(operation, `Substack answered ${response.status}: ${String(reply?.error ?? reply?.errors?.[0]?.msg ?? text).slice(0, 200)}`, response.status < 500 ? 'invalid_input' : goesPublic ? 'ambiguous_outcome' : 'upstream_failure', { upstreamStatus: response.status });
    return reply ?? {};
  }
  const mine = account => account.backend === backend && account.platform === PLATFORM && account.accountId === publication;
  return {
    capabilities: {
      backend,
      apiRevision: 'Substack web API',
      runtime: ['workerd', 'node>=22.12'],
      capabilities: [{ operation: 'posts.publish', platform: PLATFORM, availability: 'available', formats: ['text'] }],
    },
    posts: {
      prepareTarget(target) {
        const issues = [];
        const add = (code, message) => issues.push({ code, message, severity: 'error', targetIndex: target.targetIndex });
        if (!mine(target.account)) add('target.account_mismatch', 'This post is not for the connected Substack publication.');
        if (!String(target.content.text ?? '').trim()) add('content.empty', 'A Substack post needs words.');
        if (target.content.media?.length) add('media.unsupported', 'A Substack post sent here carries words only.');
        if (!String(target.options?.title ?? '').trim()) add('options.title', 'A Substack post needs a title.');
        if (target.schedule) add('schedule.unsupported', 'A Substack post is sent at its time by its own run.');
        return issues;
      },
      async publishTarget(target) {
        const options = target.options ?? {};
        const profile = await call('substack.profile.read', 'https://substack.com/api/v1/user/profile/self');
        const draft = await call('substack.drafts.create', `${origin}/api/v1/drafts`, {
          method: 'POST',
          body: {
            draft_title: String(options.title).trim(),
            draft_subtitle: String(options.subtitle ?? '').trim(),
            draft_body: JSON.stringify(substackDocument(target.content.text)),
            draft_bylines: Number.isSafeInteger(profile.id) ? [{ id: profile.id, is_guest: false }] : [],
            audience: options.audience ?? 'everyone',
            type: 'newsletter',
            section_chosen: false,
          },
        });
        if (draft.id === undefined || draft.id === null) fail('substack.drafts.create', 'Substack kept no draft for this post.');
        const published = await call('substack.drafts.publish', `${origin}/api/v1/drafts/${encodeURIComponent(draft.id)}/publish`, {
          method: 'POST',
          body: { send: options.send !== false, share_automatically: false },
          goesPublic: true,
        });
        const url = published.canonical_url ?? (published.slug ? `${origin}/p/${published.slug}` : null);
        return {
          state: 'published', targetIndex: target.targetIndex, account: target.account, observedAt: new Date().toISOString(),
          ...(url ? { url } : {}),
          post: platformPostRef({ backend, platform: PLATFORM, accountId: target.account.accountId, postId: String(published.id ?? draft.id) }),
        };
      },
    },
  };
}
