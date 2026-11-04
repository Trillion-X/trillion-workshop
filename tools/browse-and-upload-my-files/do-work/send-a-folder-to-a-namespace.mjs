// Purpose: put every file in one ordinary folder into a person's hosted namespace, from any computer, with nothing set
// up beforehand: no table of files, no vault, no running app. Each file goes through the shared chunked sender
// (send-a-file-to-a-namespace.mjs), named in the namespace as `/<folder name>/<path inside the folder>` the moment its
// upload starts, so the person and their AI can open it by the name they know before it has finished.
//
// Signing in: `signInWithBrowser` performs the standard sign-in any AI app performs (OAuth 2.1 with PKCE and a
// one-time local callback); the person confirms in their browser and the access token stays in this process's memory.
//
// Invariants:
// - Files are read in place; nothing is copied, staged or written on this computer.
// - A file the namespace already holds is only named again, never sent again, so running it twice sends nothing new.
// - A refusal from the service's storage stops the run at once with the service's own words; files already uploaded
//   stay uploaded and named. Nothing is counted as uploaded until the service answered that it holds it.
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { loadChunking } from './content-chunks.mjs';
import { NamespaceRefused, WHOLE_FILE_BYTES, fileSource, sendFile, sendWholeFiles } from './send-a-file-to-a-namespace.mjs';

// The media type the operating system's `file` command reports, or null where it cannot say.
export function mediaTypeOf(file) {
  return new Promise(resolve => {
    const child = spawn('file', ['--brief', '--mime-type', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', code => resolve(code === 0 && /^[\w.+-]+\/[\w.+-]+$/.test(out.trim()) ? out.trim() : null));
  });
}

// Every regular file under `root`, depth first, in name order. Links are not followed, so a link cannot loop. Hidden
// files and folders (a name starting with ".", such as .DS_Store or a program's progress marker) are the computer's
// or another program's bookkeeping, not the person's work, so they are not sent.
export async function* filesUnder(root, relative = '', skip = () => false) {
  const entries = (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const inside = relative ? `${relative}/${entry.name}` : entry.name;
    if (skip(inside) || (entry.isDirectory() && skip(`${inside}/`))) continue;
    if (entry.isDirectory()) yield* filesUnder(root, inside, skip);
    else if (entry.isFile()) yield inside;
  }
}

/**
 * Upload `folder` through `client` (namespace-client.mjs). `say(line)` receives one plain line per file and the
 * closing count. `as` is the folder the files are named under in the namespace (`/Amie recordings` or
 * `/Content/Blocks`); left out, it is the folder's own name. Returns { uploaded, already_there, empty, names, stopped }
 * where `stopped` is the refusal message.
 */
export async function sendFolder({ folder, client, say = () => {}, parallel = 16, as = null }) {
  const root = path.resolve(folder);
  if (!(await fs.stat(root).catch(() => null))?.isDirectory()) throw new Error(`${folder} is not a folder on this computer.`);
  const top = as ? as.replace(/^\/+|\/+$/g, '') : path.basename(root);
  if (!top) throw new Error('The folder to name the files under needs a name.');
  const result = { uploaded: 0, already_there: 0, empty: 0, names: [], stopped: null };
  const chunking = await loadChunking();
  // Small files wait here and go many to a request; the list is sent when it holds a request's worth, and at the end.
  let small = [];
  const record = (inside, name, size, sent) => {
    result.names.push({ name, identity: sent.identity, byte_length: size, state: sent.state });
    // Uploaded means bytes were stored: a chunked file whose every chunk was already held counts as already there.
    if (sent.state === 'uploaded' && !(sent.chunks && sent.chunks === sent.chunks_already_held)) { result.uploaded += 1; say(`uploaded  ${inside}`); }
    else { result.already_there += 1; say(`already there  ${inside}`); }
  };
  const sendSmall = async () => {
    if (!small.length) return;
    const batch = small;
    small = [];
    try {
      const answers = await sendWholeFiles({ client, files: batch, chunking });
      answers.forEach((sent, index) => record(batch[index].inside, batch[index].name, batch[index].source.size, sent));
    } catch (error) {
      (error.answers ?? []).forEach((sent, index) => record(batch[index].inside, batch[index].name, batch[index].source.size, sent));
      throw error;
    } finally { await Promise.all(batch.map(file => file.source.close())); }
  };
  try {
    for await (const inside of filesUnder(root)) {
      const file = path.join(root, inside);
      const size = (await fs.stat(file)).size;
      if (!size) { result.empty += 1; say(`skipped (empty)  ${inside}`); continue; }
      const name = `/${top}/${inside}`;
      const stat = await fs.stat(file);
      const source = await fileSource(file);
      if (size <= WHOLE_FILE_BYTES) {
        small.push({ source, name, inside, modifiedAtMs: stat.mtimeMs, mediaType: await mediaTypeOf(file) });
        if (small.length >= 256 || small.reduce((sum, item) => sum + item.source.size, 0) >= 32 * 1024 * 1024) await sendSmall();
        continue;
      }
      let sent;
      try { sent = await sendFile({ client, source, name, modifiedAtMs: stat.mtimeMs, mediaType: await mediaTypeOf(file), chunking, parallel }); }
      finally { await source.close(); }
      record(inside, name, size, sent);
    }
    await sendSmall();
  } catch (error) {
    await Promise.all(small.map(file => file.source.close()));
    if (!(error instanceof NamespaceRefused)) throw error;
    result.stopped = error.message;
  }
  say(`${result.uploaded} uploaded, ${result.already_there} already there${result.empty ? `, ${result.empty} empty skipped` : ''}.`);
  if (result.stopped) say(`Stopped: ${result.stopped}`);
  return result;
}

// Open a web address in the person's browser the way their operating system does.
function openInBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

/**
 * Sign in to `origin` in the person's browser and return a function giving the Authorization header value. The
 * service registers this program as a public app, the browser confirms with the person's passkey, and the one-time
 * code comes back to a callback on this computer's loopback address. `showSignIn(url)` is told the address to open
 * (the default opens the browser); it can be replaced where a browser is driven another way.
 */
export async function signInWithBrowser({ origin, appName = 'File upload', showSignIn = openInBrowser, say = () => {}, fetchImpl = fetch }) {
  const base = origin.replace(/\/$/, '');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  try {
    const registered = await (await fetchImpl(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: appName, redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) })).json();
    if (!registered.client_id) throw new Error(`The service did not register this program for sign-in: ${JSON.stringify(registered).slice(0, 200)}`);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url'); // PKCE S256 is fixed by the OAuth standard
    const state = randomBytes(16).toString('hex');
    const code = new Promise((resolve, reject) => {
      server.on('request', (request, response) => {
        const url = new URL(request.url, redirect);
        if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
        const problem = url.searchParams.get('state') !== state ? 'The sign-in answer did not match this upload; run the command again.'
          : url.searchParams.get('code') ? null
          : `Sign-in did not finish: ${url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'no code came back'}`;
        response.writeHead(problem ? 400 : 200, { 'content-type': 'text/plain; charset=utf-8' }).end(problem ?? 'Signed in. You can close this tab and go back to your upload.');
        if (problem) reject(new Error(problem));
        else resolve(url.searchParams.get('code'));
      });
    });
    const signInUrl = `${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: redirect, scope: 'decisions', state, code_challenge: challenge, code_challenge_method: 'S256', resource: `${base}/mcp` })}`;
    say(`Sign in to continue: ${signInUrl}`);
    await showSignIn(signInUrl);
    const token = await (await fetchImpl(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: await code, redirect_uri: redirect, client_id: registered.client_id, code_verifier: verifier, resource: `${base}/mcp` }) })).json();
    if (typeof token.access_token !== 'string') throw new Error(`Sign-in did not give access: ${token.error_description ?? token.error ?? 'no token'}`);
    return async () => `Bearer ${token.access_token}`;
  } finally { server.close(); }
}
