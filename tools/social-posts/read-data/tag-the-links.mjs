// tools/social-posts/read-data/tag-the-links.mjs
//
// Purpose: tool:tag-the-links-in-words, the one tagger (posts.mjs) applied to words a caller has written for one send that
// is not a post, such as a private reply to a comment. Every http(s) link in the words is tagged with the medium, source,
// campaign and content the caller names. Nothing is read from a store or sent; the answer is the words and each tagged link.

import { linkTagsOf, taggedLinksIn, tagWords } from './posts.mjs';

const TAGS = { source: 'utm_source', medium: 'utm_medium', campaign: 'utm_campaign', content: 'utm_content' };

/** tool:tag-the-links-in-words: `words` with each link tagged by `source`, `medium`, `campaign` and `content`, and the tagged links. */
export function tagTheLinksInWords(input = {}) {
  const { words } = input;
  if (typeof words !== 'string') throw new Error('tag-the-links-in-words needs words (a string).');
  const given = {};
  for (const [name, param] of Object.entries(TAGS)) {
    if (typeof input[name] !== 'string' || input[name] === '') throw new Error(`tag-the-links-in-words needs ${name} (a non-empty string).`);
    given[param] = input[name];
  }
  const tags = linkTagsOf({}, given);
  return { words: tagWords(words, tags), links: taggedLinksIn(words, tags) };
}
