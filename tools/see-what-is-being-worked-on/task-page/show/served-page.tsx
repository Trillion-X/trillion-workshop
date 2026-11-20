// The task page as this computer's own door serves it (tool:serve-the-task-pages, invoke.pages): the page signs the person
// in with their own sign-in and asks the row's kept session through the door's /mcp, from the door's own origin. Nothing is
// kept but the pass, in this tab only (sessionStorage), and the sign-in's one-time verifier while it signs in.
//
// The address says which databases the page reads: ?dbs=a,b (the session's start input, each held for the owner alone) and
// ?pages=<the one whose task_pages names the pursuits> (default the first). The sign-in is found from the door itself: its
// protected-resource document names the sign-in server, whose metadata names the endpoints; the client is the sign-in
// server's own document for this page (<server>/pages/<tool>/client.json, published from task-page/client-metadata.json)
// unless the address names one (?client=), and the pass is made for this door (<origin>/mcp).
// The callback is callback.html beside this page; it finishes the sign-in and returns to the page.
import { mount, type Ask } from './mount-task-page';

const PASS = 'task-page-pass';
const VERIFIER = 'task-page-verifier';
const RETURN = 'task-page-return';
const CLIENT = 'task-page-client';
const SCOPE = 'tools:*';
const DO = 'do_one_thing_in_my_account';
const [, , toolPart] = location.pathname.split('/');
const tool = decodeURIComponent(toolPart ?? '');
const base = `${location.origin}/pages/${toolPart}/`;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json = async (url: string, init?: RequestInit) => { const reply = await fetch(url, init); if (!reply.ok) throw new Error(`${url} answered ${reply.status}`); return reply.json(); };

async function signInServer() {
  const resource = await json(`${location.origin}/.well-known/oauth-protected-resource`);
  const server = String(resource.authorization_servers?.[0] ?? '');
  const meta = await json(`${server}/.well-known/oauth-authorization-server`);
  return { server, authorize: String(meta.authorization_endpoint), token: String(meta.token_endpoint), clientId: sessionStorage.getItem(CLIENT) ?? `${server}/pages/${toolPart}/client.json`, resource: String(resource.resource) };
}

async function signIn() {
  const { authorize, clientId, resource } = await signInServer();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(VERIFIER, verifier);
  sessionStorage.setItem(RETURN, location.href);
  const url = new URL(authorize);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: `${base}callback.html`, scope: SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256', resource, state: b64url(crypto.getRandomValues(new Uint8Array(16))) })) url.searchParams.set(key, value);
  location.assign(url.toString());
}

async function finishSignIn(code: string) {
  const { token, clientId, resource } = await signInServer();
  const verifier = sessionStorage.getItem(VERIFIER) ?? '';
  sessionStorage.removeItem(VERIFIER);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `${base}callback.html`, client_id: clientId, code_verifier: verifier, resource });
  const pass = await json(token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  sessionStorage.setItem(PASS, String(pass.access_token));
  location.replace(sessionStorage.getItem(RETURN) ?? base);
}

/** One call of the row's kept session through the door: tools:run {tool, call, input}. An answer too long for one reply
 *  comes in pieces ({ part, at, total, key }); the rest are asked with `part` and the joined text is the answer. */
async function call(name: string, args: Record<string, unknown>, input: Record<string, unknown>) {
  const first = await callOnce(name, args, input);
  if (!(first && typeof first.key === 'string' && typeof first.part === 'string' && typeof first.total === 'number')) return first;
  let text = first.part;
  while (text.length < first.total) {
    const piece = await callOnce('part', { key: first.key, at: text.length }, input);
    if (typeof piece?.part !== 'string' || piece.part.length === 0) throw new Error('A piece of the answer did not come.');
    text += piece.part;
  }
  return JSON.parse(text);
}

async function callOnce(name: string, args: Record<string, unknown>, input: Record<string, unknown>) {
  const pass = sessionStorage.getItem(PASS);
  if (!pass) { await signIn(); throw new Error('signing in'); }
  const reply = await fetch(`${location.origin}/mcp`, { method: 'POST', cache: 'no-store',
    headers: { authorization: `Bearer ${pass}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: DO, arguments: { method: 'tools:run', input: { tool, call: { name, arguments: args }, input }, request_key: crypto.randomUUID() } } }) });
  if (reply.status === 401) { sessionStorage.removeItem(PASS); await signIn(); throw new Error('signing in'); }
  const message = await reply.json();
  const outer = message?.result?.structuredContent ?? JSON.parse(message?.result?.content?.[0]?.text ?? 'null');
  const inner = outer?.result;
  if (message?.error || outer?.error || inner?.isError) throw new Error(String(message?.error?.message ?? outer?.error?.message ?? inner?.content?.[0]?.text ?? 'refused'));
  return inner?.structuredContent ?? JSON.parse(inner?.content?.[0]?.text ?? 'null');
}

const params = new URLSearchParams(location.search);
if (params.get('client')) sessionStorage.setItem(CLIENT, String(params.get('client')));
const code = params.get('code');
if (location.pathname.endsWith('/callback.html')) {
  if (code) finishSignIn(code).catch(error => { document.body.textContent = `Sign-in did not finish: ${error.message}`; });
} else {
  const dbs = (params.get('dbs') ?? '').split(',').filter(Boolean).map(database => ({ database }));
  const pagesDatabase = params.get('pages') ?? dbs[0]?.database ?? '';
  const input = { dbs };
  const asks = { dbs, pages_database: pagesDatabase };
  // The page's two addresses, answered by the session's two calls.
  const ask: Ask = async url => {
    const asked = new URL(url, base);
    if (asked.pathname.endsWith('/pursuits')) return JSON.stringify((await call('pursuits', asks, input)).items);
    return JSON.stringify(await call('data', { ...asks, p: (asked.searchParams.get('p') ?? '').split(',').filter(Boolean) }, input));
  };
  const element = document.getElementById('timeline');
  if (element) mount(element, { dataUrl: 'data', seenKey: 'task-page-seen', choices: { url: 'pursuits', param: 'p', ariaLabel: 'Whose work', every: 'All' }, ask });
}
