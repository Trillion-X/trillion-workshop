#!/usr/bin/env node
import { realpathSync } from 'node:fs';
// tools/save-what-you-watch-and-read/do-work/save-x-posts.mjs
//
// PURPOSE: tool:save-x-bookmarks and tool:save-x-likes, run in the tool container. Reads the person's saved X posts (their
// bookmarks or their likes, newest first) with the reader in this folder (read-saved-x-posts.mjs), and keeps them as one saved-links
// file in the folder the row names (its outputs, kept in the person's files). The answer says how many were read, how many
// are new, the newest key (the since the next read takes) and the file's name.
//
// Usage: node do-work/save-x-posts.mjs --which bookmarks|likes --out <folder> < input.json
//   input: { account, since?, already_kept?, kept? }: account is the Composio account id of the person's X connection (bookmarks);
//   the likes read takes the X API token on descriptor 3 (the reader's tokenFrom).
//   The file already in <folder> is merged with the fresh posts (kept? is used when there is none): a run never drops an earlier run's posts.
// Refusals exit 1 with X's own words or the reason, and write no file.
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSaved } from './read-saved-x-posts.mjs';
import { readFromComposio } from './composio-source.mjs';
import { makeComposioCall } from '../../composio-connection/read-data/composio-call.mjs';

/** Reads the list the request names and writes it to `out`; answers the summary the row returns. */
export async function saveXPosts(request, { out, way, execute } = {}) {
  if (request.which !== 'bookmarks' && request.which !== 'likes') throw new Error('which must be bookmarks or likes.');
  // Bookmarks are read through the person's X account that Composio holds; likes still read through the X API token.
  const composio = (req, collected) => readFromComposio(req, collected, { execute: execute ?? makeComposioCall() });
  const source = way ?? (request.which === 'bookmarks' ? composio : undefined);
  const read = await readSaved({ via: request.which === 'bookmarks' ? 'composio' : 'api', which: request.which, connection: request.connection, since: request.since ?? null, already_kept: request.already_kept ?? [], token_fd: 3 }, source);
  const file = `saved-x-${request.which}.json`;
  const posts = mergePosts(keptPosts(join(out, file), request.kept), read.posts);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, file), `${JSON.stringify({ saved_from: 'X', which: request.which, generated: new Date().toISOString(), posts }, null, 1)}\n`);
  return { which: request.which, newest: read.newest, read: read.read, not_kept_yet: read.not_kept_yet, total: posts.length, file };
}

/** The posts the file already holds: the file in this folder if there is one, else the posts the caller passes in. */
function keptPosts(path, passed = []) {
  if (!existsSync(path)) return passed;
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(parsed?.posts) ? parsed.posts : passed;
}

/** New posts first, then every kept one that is not among them, so an earlier run's posts are never dropped. */
export function mergePosts(kept, fresh) {
  const keys = new Set(fresh.map(post => post.key));
  return [...fresh, ...kept.filter(post => !keys.has(post.key))];
}

function argument(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  saveXPosts({ ...JSON.parse(readFileSync(0, 'utf8') || '{}'), which: argument('--which') }, { out: argument('--out') })
    .then(answer => process.stdout.write(`${JSON.stringify(answer)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
