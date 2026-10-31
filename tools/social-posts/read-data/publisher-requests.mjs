// tools/social-posts/read-data/publisher-requests.mjs
//
// Purpose: the publisher bound to the name `requests` (read-data/send-a-post.mjs PUBLISHERS), shaped like the
// @opencoredev/social-sdk publishers so read-data/send-a-post.mjs drives it the same way. It knows no place: a place row
// (read-data/post-places.json) whose adapter is `requests` writes its requests as DATA in its options, and this file
// sends them in order through the held fetch it is handed. A place reached by a plain JSON API is then a row, not code.
//
//   options: { platform, account, formats?, steps: [step], post_id, url? }
//   step:    { id, operation, method?, url, headers?, body?, goes_public?, needs?: [path], same?: [[value, value]] }
//
// A value in a step's url, headers and body (and post_id, url) is a template, read when the post is sent:
//   "text"                                 itself
//   { "join": [value, ...] }               the values' text, one after another
//   { "post": "words", "markup"? }         the post's words for this place: as written, or in a markup of posts.json
//                                          `markup` (the Markdown read as Substack's post document is, then each part
//                                          wrapped as that markup's row says)
//   { "setting": name, "optional"? }       the post's setting for this place (target options); an optional one left out
//                                          drops its key
//   { "step": id, "at": path }             a field of an earlier step's reply (path "a.b.0.c")
//   arrays and objects                     each value read the same way
// The held, readable and fixed values of the person's connection ({held}, {plain}, {value}) are filled before this
// file sees them (send-a-post.mjs publisherFor): a held value arrives as a stand-in only the held fetch replaces.
//
// Non-Negotiable Invariants:
//   1. Nothing is published unless send-a-post.mjs was asked to send an approved post; this file never decides that.
//   2. It holds no held value: each is a stand-in, and every request goes through the fetch it is handed.
//   3. A step's `needs` are fields its reply must hold, and `same` pairs of values that must be equal (a read back of
//      the new post naming the post that was made); either missing refuses the send there, as not known.
//   4. A request cut off after it was sent, on a step that `goes_public`, may have published the post, so its outcome
//      is not known and it is never sent again by itself.
//   5. Nothing here names a place or a markup.
//
import { SocialError, platformPostRef } from '@opencoredev/social-sdk';
import settings from './posts.json' with { type: 'json' };
import { substackDocument } from './publisher-substack.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const DROP = Symbol('left out');
const fail = (operation, message, code = 'upstream_failure', extra = {}) => {
  throw new SocialError({ code, operation, message, retryDisposition: { kind: code === 'invalid_input' ? 'never' : code === 'unauthorized' ? 'after-reconnect' : 'reconcile-first' }, ...extra });
};
const fill = (words, values) => words.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');

/** The field at a dotted path ("a.b.0.c"), or undefined. */
const at = (value, path) => String(path).split('.').reduce((found, part) => (found === null || found === undefined ? undefined : found[part]), value);

/** Markdown words in a markup of posts.json `markup`: each part of the post document wrapped as the markup's row says. */
export function inMarkup(markdown, name) {
  const markup = settings.markup[name];
  if (!markup) throw new Error(`No markup ${name} is in posts.json.`);
  const plain = text => [...String(text)].map(character => markup.escape[character] ?? character).join('');
  const wrap = (row, inner, values = {}) => (row ? `${fill(row[0], values)}${inner}${fill(row[1], values)}` : inner);
  const write = node => {
    if (node.type === 'text') return (node.marks ?? []).reduce((inner, mark) => wrap(markup.marks[mark.type], inner, { href: plain(mark.attrs?.href ?? '') }), plain(node.text));
    return wrap(markup.nodes[node.type], (node.content ?? []).map(write).join(''), { level: String(node.attrs?.level ?? '') });
  };
  return write(substackDocument(markdown));
}

// One template value, read for this post and the replies so far.
function read(template, values) {
  if (Array.isArray(template)) return template.map(item => read(item, values)).filter(item => item !== DROP);
  if (!object(template)) return template;
  if ('join' in template) return template.join.map(item => read(item, values)).filter(item => item !== DROP).join('');
  if ('post' in template) return template.markup ? inMarkup(values.target.content.text, template.markup) : String(values.target.content.text ?? '');
  if ('setting' in template) {
    const found = values.target.options?.[template.setting];
    if (found === undefined || found === null || found === '') return template.optional ? DROP : '';
    return found;
  }
  if ('step' in template) return at(values.replies[template.step], template.at);
  return Object.fromEntries(Object.entries(template).map(([key, item]) => [key, read(item, values)]).filter(([, item]) => item !== DROP));
}

/**
 * @param {object} options
 * @param {string} options.platform             the place's platform, as its row names it
 * @param {string} options.account              the account the connection reaches
 * @param {object[]} options.steps              the requests, in order
 * @param {*} options.post_id                   where the new post's id is (a template)
 * @param {*} [options.url]                     where its public address is (a template)
 * @param {string[]} [options.formats]          what a post there carries
 * @param {typeof fetch} options.fetch          the held fetch
 */
export function requests({ platform, account: accountId, steps, post_id: postIdAt, url: urlAt, formats = ['text'], fetch: send, backend = 'default' }) {
  async function call(step, request) {
    let response;
    try {
      response = await send(request.url, { method: request.method, headers: { accept: 'application/json', ...request.headers, ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}) });
    } catch (error) {
      if (error instanceof SocialError || !step.goes_public) throw error;
      fail(step.operation, 'The request was cut off, so it is not known whether the post was published.', 'ambiguous_outcome', { cause: error });
    }
    const text = await response.text();
    let reply = null;
    try { reply = text ? JSON.parse(text) : null; } catch { reply = null; }
    if (response.status === 401 || response.status === 403) fail(step.operation, 'The place no longer accepts this connection.', 'unauthorized', { upstreamStatus: response.status });
    if (response.status === 429) fail(step.operation, 'The place is busy and asked to try again later.', 'rate_limited', { upstreamStatus: 429 });
    if (!response.ok) fail(step.operation, `The place answered ${response.status}: ${text.slice(0, 200)}`, response.status < 500 ? 'invalid_input' : step.goes_public ? 'ambiguous_outcome' : 'upstream_failure', { upstreamStatus: response.status });
    return reply ?? {};
  }
  const mine = account => account.backend === backend && account.platform === platform && account.accountId === accountId;
  return {
    capabilities: {
      backend,
      apiRevision: 'requests written in the place row',
      runtime: ['workerd', 'node>=22.12'],
      capabilities: [{ operation: 'posts.publish', platform, availability: 'available', formats }],
    },
    posts: {
      prepareTarget(target) {
        const issues = [];
        const add = (code, message) => issues.push({ code, message, severity: 'error', targetIndex: target.targetIndex });
        if (!mine(target.account)) add('target.account_mismatch', 'This post is not for the connected account.');
        if (!String(target.content.text ?? '').trim()) add('content.empty', 'This post needs words.');
        if (target.content.media?.length && formats.every(format => format === 'text')) add('media.unsupported', 'A post sent here carries words only.');
        if (target.schedule) add('schedule.unsupported', 'A post is sent at its time by its own run.');
        return issues;
      },
      async publishTarget(target) {
        const replies = {};
        const values = { target, replies };
        for (const step of steps) {
          const reply = await call(step, { method: step.method ?? 'GET', url: read(step.url, values), headers: read(step.headers ?? {}, values), ...(step.body !== undefined ? { body: read(step.body, values) } : {}) });
          replies[step.id] = reply;
          for (const path of step.needs ?? []) if ([undefined, null, ''].includes(at(reply, path))) fail(step.operation, `The place's answer holds no ${path}, so it is not known whether the post was made.`, 'ambiguous_outcome');
          for (const [left, right] of step.same ?? []) if (read(left, values) !== read(right, values)) fail(step.operation, 'The place did not confirm the new post.', 'ambiguous_outcome');
        }
        const url = urlAt === undefined ? null : read(urlAt, values);
        return {
          state: 'published', targetIndex: target.targetIndex, account: target.account, observedAt: new Date().toISOString(),
          ...(url ? { url: String(url) } : {}),
          post: platformPostRef({ backend, platform, accountId: target.account.accountId, postId: String(read(postIdAt, values)) }),
        };
      },
    },
  };
}
