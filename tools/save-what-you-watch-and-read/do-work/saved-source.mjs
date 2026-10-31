// tools/save-what-you-watch-and-read/do-work/saved-source.mjs
//
// What every way of reading a person's saved X posts shares: the conventions (DATA), the kind of list a request asks for,
// the identity a saved post keeps, and the collector that keeps each post once and says when a read has what it needs.
// Pure apart from reading the conventions file once.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const conventions = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'saved-posts-conventions.json'), 'utf8'));

/** The conventions of the request's kind of list; refuses a kind that does not exist. */
export function listFor(request) {
  const kind = conventions.lists[request.which];
  if (!kind) throw new Error(`which must be one of ${Object.keys(conventions.lists).join(', ')}.`);
  return kind;
}

/** A post with the identity it keeps as a saved item: `<saved_from>-<saved_as>-<key>`, so one post saved two ways is two items. */
export function savedPost(post, which) {
  const { saved_as: savedAs } = conventions.lists[which];
  const savedFrom = conventions.saved_from;
  return { id: `${savedFrom.toLowerCase()}-${savedAs}-${post.key}`, saved_from: savedFrom, saved_as: savedAs, ...post };
}

/** Counts a page's posts against the keys the person already has, and keeps each post once, in the order seen. */
export function collector(alreadyKept) {
  const kept = new Set(alreadyKept ?? []);
  const found = new Map();
  let quietPages = 0;
  const onPage = posts => {
    let fresh = 0;
    for (const post of posts) {
      if (found.has(post.key)) continue;
      found.set(post.key, post);
      if (!kept.has(post.key)) fresh += 1;
    }
    quietPages = posts.length && !fresh ? quietPages + 1 : 0;
    return fresh > 0;
  };
  onPage.finished = () => quietPages >= conventions.stop.pages_with_nothing_new;
  return { onPage, posts: () => [...found.values()], notKept: () => [...found.values()].filter(post => !kept.has(post.key)).length };
}
