// tools/save-what-you-watch-and-read/do-work/x-posts.mjs
//
// Turns the timeline answers X's own page asks for (the GraphQL "Bookmarks" and "Likes" operations) into plain posts.
// Pure: no browser, no network, no files.
//
// Invariants:
//   - A post is kept only when it names its id and its text record; anything else in an answer is skipped.
//   - A post's links are the addresses its author wrote, with the short t.co form replaced by the real address; the
//     address of the post's own pictures and videos are not links.
//   - The same post is never returned twice from one answer.

/** The tweet record inside a result, unwrapping the visibility wrapper X puts around some posts. */
function tweetIn(result) {
  let tweet = result?.tweet ?? result;
  if (tweet?.__typename === 'TweetWithVisibilityResults') tweet = tweet.tweet;
  return tweet?.rest_id && tweet.legacy ? tweet : null;
}

function authorOf(tweet) {
  const user = tweet.core?.user_results?.result;
  return {
    author: user?.core?.screen_name ?? user?.legacy?.screen_name,
    author_name: user?.core?.name ?? user?.legacy?.name,
  };
}

/** The expanded addresses among a post's entities, once each; the post's own picture and video addresses are left out. */
function expandedLinks(entities) {
  const found = [];
  for (const entity of entities) {
    const address = entity.expanded_url;
    if (!address || /^https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+\/(?:photo|video)\//.test(address)) continue;
    if (!found.includes(address)) found.push(address);
  }
  return found;
}

/** Addresses written in a post of X's page answers, expanded. */
export function linksOf(tweet) {
  return expandedLinks([
    ...(tweet.legacy.entities?.urls ?? []),
    ...(tweet.note_tweet?.note_tweet_results?.result?.entity_set?.urls ?? []),
  ]);
}

/** The one shape of a post, whichever way it was read: key, address, full words, who wrote it, when, pictures, links, the post it quotes. */
function shapePost({ key, author, author_name, text, posted_at, media, links, quoted }) {
  return {
    key,
    url: author ? `https://x.com/${author}/status/${key}` : `https://x.com/i/web/status/${key}`,
    title: text,
    author,
    author_name,
    posted_at: posted_at ? new Date(posted_at).toISOString() : undefined,
    ...(media?.length ? { media } : {}),
    ...(links?.length ? { links } : {}),
    ...(quoted ? { quoted } : {}),
  };
}

function postFrom(tweet, withQuoted) {
  const { author, author_name } = authorOf(tweet);
  const quoted = withQuoted ? tweetIn(tweet.quoted_status_result?.result) : null;
  return shapePost({
    key: tweet.rest_id,
    author,
    author_name,
    text: tweet.note_tweet?.note_tweet_results?.result?.text ?? tweet.legacy.full_text ?? '',
    posted_at: tweet.legacy.created_at,
    media: (tweet.legacy.extended_entities?.media ?? []).map(item => item.media_url_https).filter(Boolean),
    links: linksOf(tweet),
    quoted: quoted ? postFrom(quoted, false) : undefined,
  });
}

/**
 * The posts in one page of X's API (users/:id/bookmarks or liked_tweets, asked with the fields and expansions in the
 * conventions), in the order X listed them. A post whose quoted post the page did not carry has no `quoted`.
 */
export function apiPostsIn(page) {
  const users = new Map((page.includes?.users ?? []).map(user => [user.id, user]));
  const tweets = new Map((page.includes?.tweets ?? []).map(tweet => [tweet.id, tweet]));
  const media = new Map((page.includes?.media ?? []).map(item => [item.media_key, item]));
  const from = (tweet, withQuoted) => {
    const author = users.get(tweet.author_id);
    const quotedId = withQuoted ? (tweet.referenced_tweets ?? []).find(reference => reference.type === 'quoted')?.id : undefined;
    const quoted = quotedId ? tweets.get(quotedId) : undefined;
    const long = tweet.note_tweet;
    return shapePost({
      key: tweet.id,
      author: author?.username,
      author_name: author?.name,
      text: long?.text ?? tweet.text ?? '',
      posted_at: tweet.created_at,
      media: (tweet.attachments?.media_keys ?? []).map(keyOfMedia => media.get(keyOfMedia)).map(item => item?.url ?? item?.preview_image_url).filter(Boolean),
      links: expandedLinks([...(tweet.entities?.urls ?? []), ...(long?.entities?.urls ?? [])]),
      quoted: quoted ? from(quoted, false) : undefined,
    });
  };
  const seen = new Set();
  return (page.data ?? []).filter(tweet => tweet?.id && !seen.has(tweet.id) && seen.add(tweet.id)).map(tweet => from(tweet, true));
}

/** The posts in one answer, in the order X listed them. */
export function postsIn(answer) {
  const posts = [];
  const seen = new Set();
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (Array.isArray(value.entries)) {
      for (const entry of value.entries) {
        const tweet = tweetIn(entry?.content?.itemContent?.tweet_results?.result);
        if (tweet && !seen.has(tweet.rest_id)) { seen.add(tweet.rest_id); posts.push(postFrom(tweet, true)); }
      }
    }
    for (const inner of Object.values(value)) walk(inner);
  };
  walk(answer);
  return posts;
}
