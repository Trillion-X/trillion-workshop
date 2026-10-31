// tools/save-what-you-watch-and-read/do-work/read-saved-x-posts.mjs
//
// Reads a person's saved X posts (their bookmarks or their likes), newest first, with the full words, who wrote each
// post, every real link it carries, its pictures and the post it quotes. Two ways in, one shape out:
//   via 'api'     X's API with the access token the person's X connection holds (api-source.mjs)
//   via "browser" the person's own signed-in X session in a browser profile folder (browser-source.mjs)
// It posts, likes, follows and changes nothing on X.
//
// Usage: node read-saved-x-posts.mjs < request.json
//   request: { via: 'api' | "browser", which: "bookmarks" | "likes", already_kept?: [post key], out_file? }
//     api:     token_fd: the descriptor the token is mounted on
//     browser: profile_dir, handle? (needed for likes), browser?: { executable? }
//   or { sign_in: true, profile_dir }: opens a visible window on X's sign-in page with that profile and waits for it to close.
//   `already_kept` are post keys the person already has: the read stops once several pages hold only those.
//   `out_file` is where the posts are written; without it they are in the answer.
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFromApi } from './api-source.mjs';
import { readFromBrowser, signIn } from './browser-source.mjs';
import { collector, savedPost } from './saved-source.mjs';

const ways = { api: readFromApi, browser: readFromBrowser };

/** Reads the request's list by the way it names; answers { which, pages, read, not_kept_yet, posts }. */
export async function readSaved(request, way = ways[request.via ?? 'api']) {
  if (!way) throw new Error(`via must be one of ${Object.keys(ways).join(', ')}.`);
  const collected = collector(request.already_kept);
  const pages = await way(request, collected);
  const posts = collected.posts().map(post => savedPost(post, request.which));
  return { which: request.which, via: request.via ?? 'api', pages, read: posts.length, not_kept_yet: collected.notKept(), posts };
}

async function main() {
  const request = JSON.parse(readFileSync(0, 'utf8'));
  if (request.sign_in) {
    await signIn(request);
    process.stdout.write(`${JSON.stringify({ signed_in_profile: request.profile_dir })}\n`);
    return;
  }
  const { posts, ...summary } = await readSaved(request);
  if (request.out_file) {
    writeFileSync(request.out_file, `${JSON.stringify({ generated: new Date().toISOString(), ...summary, posts }, null, 1)}\n`);
    process.stdout.write(`${JSON.stringify({ ...summary, out_file: request.out_file })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ ...summary, posts })}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
