// src/workspace/account-pass.ts
//
// PURPOSE
//   The page's pass to the account's one door (/mcp): the sign-in tool's own OAuth code flow with PKCE (S256), this page
//   being the client its client document names (account-pass.json `client_document`, on this page's own origin). The
//   pass and its renewal are kept in this page's memory only; the code verifier, the state and the address asked for
//   wait in sessionStorage across the one redirect to sign in, and are removed at the callback.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No pass is ever written to storage, a cookie or an address.
//   2. A callback whose state is not the one this tab sent is refused; nothing is exchanged.

import flow from './account-pass.json' with { type: 'json' };

type Pass = { access: string; refresh: string | null; ends: number };
let held: Pass | null = null;

const at = (path: string) => new URL(path, location.origin).href;
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function exchange(fields: Record<string, string>): Promise<Pass> {
  const response = await fetch(flow.token, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: at(flow.client_document), resource: at(flow.resource), ...fields }),
  });
  const answer = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!response.ok || typeof answer.access_token !== 'string') throw Object.assign(new Error(flow.refused), { status: response.status });
  return { access: answer.access_token, refresh: answer.refresh_token ?? null, ends: Date.now() + 1000 * (Number(answer.expires_in) || 0) };
}

/** Goes to the sign-in tool; the page comes back at the callback with a code. */
async function signIn(): Promise<never> {
  const verifier = random();
  const state = random();
  sessionStorage.setItem(flow.kept, JSON.stringify({ verifier, state, back: `${location.pathname}${location.search}` }));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const asked = new URL(flow.authorize, location.origin);
  const query = { response_type: 'code', client_id: at(flow.client_document), redirect_uri: at(flow.callback), scope: flow.scope, state, code_challenge: challenge, code_challenge_method: 'S256', resource: at(flow.resource) };
  for (const [name, value] of Object.entries(query)) asked.searchParams.set(name, value);
  location.assign(asked.href);
  return new Promise<never>(() => {});
}

/** At the callback: the code exchanged for the pass, and the address that was asked for put back. Elsewhere nothing. */
export async function takeCallback(): Promise<void> {
  if (location.pathname !== flow.callback) return;
  const kept = JSON.parse(sessionStorage.getItem(flow.kept) ?? 'null') as { verifier: string; state: string; back: string } | null;
  sessionStorage.removeItem(flow.kept);
  const query = new URLSearchParams(location.search);
  const code = query.get('code');
  if (!kept || !code || query.get('state') !== kept.state) throw new Error(flow.refused);
  held = await exchange({ grant_type: 'authorization_code', code, redirect_uri: at(flow.callback), code_verifier: kept.verifier });
  history.replaceState(null, '', kept.back.startsWith(flow.callback) ? flow.home : kept.back);
}

/** The pass for the next call: renewed when it is about to end, signed in again when it cannot be renewed. */
export async function pass(): Promise<string> {
  if (held && held.ends - Date.now() > flow.renew_before_ms) return held.access;
  if (held?.refresh) {
    try { held = await exchange({ grant_type: 'refresh_token', refresh_token: held.refresh }); return held.access; } catch { held = null; }
  }
  return signIn();
}

/** A pass the door refused: let go, so the next call renews it or signs in. */
export function passRefused(): void {
  if (held) held.ends = 0;
}
