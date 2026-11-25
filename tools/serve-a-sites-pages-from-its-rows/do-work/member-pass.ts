// tools/serve-a-sites-pages-from-its-rows/do-work/member-pass.ts
//
// PURPOSE
//   Who a request is, for a members page or a member's file: the pass the site's sign-in tool (tools/better-auth-official) signs
//   for the session the request's cookie names (its jwt plugin's GET /api/auth/token), checked here against the sign-in tool's own
//   public keys (GET /api/auth/jwks): its signature, its issuer and audience, its end, and the team claim
//   (settings.teams.claim of the sign-in tool, `team_ids`) holding the site's members team. That same pass is what the site sends
//   to the engine's door for a members page, so the door judges the member by the member's own pass, never the site's.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No cookie, no pass, a pass that does not check out, or a pass without the members team is "not a member"; nothing in
//      the request other than the signed pass can make one.
//   2. The pass is never written to a log, an error or a page.
//   3. Only EdDSA (Ed25519), ES256 and RS256 passes are taken; "none" and every other algorithm are refused.
//   4. The public keys are read again when a pass names a key id they do not hold, at most once a minute.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { createPublicKey, verify } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import { ask } from './door.ts';

export interface SignIn {
  /** The sign-in tool's address: an http(s) URL or unix:/socket/path. */
  address: string;
  /** The `iss` its passes carry. */
  issuer: string;
  /** The `aud` its passes carry. */
  audience: string;
  /** The claim holding the person's team ids. */
  team_claim: string;
  /** The team whose people are the site's members. */
  members_team: string;
}

export interface Member {
  pass: string;
  subject: string;
  teams: string[];
  /** Every claim of the checked pass (email, name, ...), as the sign-in tool wrote it. */
  claims: Record<string, unknown>;
}

const ALGORITHMS: Record<string, { hash: string | null; dsa?: 'ieee-p1363' }> = {
  EdDSA: { hash: null },
  ES256: { hash: 'sha256', dsa: 'ieee-p1363' },
  RS256: { hash: 'sha256' },
};
const KEYS_AGAIN_MS = 60_000;

const part = (text: string): Record<string, unknown> => JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));

export class MemberPasses {
  #signIn: SignIn;
  #keys = new Map<string, KeyObject>();
  #readAt = 0;
  #now: () => number;

  constructor(signIn: SignIn, now: () => number = Date.now) {
    this.#signIn = signIn;
    this.#now = now;
  }

  async #keysHold(kid: string): Promise<KeyObject | undefined> {
    if (this.#keys.has(kid) || this.#now() - this.#readAt < KEYS_AGAIN_MS) return this.#keys.get(kid);
    this.#readAt = this.#now();
    const answer = await ask(this.#signIn.address, '/api/auth/jwks', { headers: { accept: 'application/json' } });
    if (answer.status !== 200) return undefined;
    const set = JSON.parse(answer.body.toString('utf8')) as { keys?: (JsonWebKey & { kid?: string })[] };
    this.#keys = new Map((set.keys ?? []).filter(key => typeof key.kid === 'string').map(key => [key.kid as string, createPublicKey({ key, format: 'jwk' })]));
    return this.#keys.get(kid);
  }

  /** The member a pass is, or null when it does not check out or lacks the members team. */
  async memberOfPass(pass: string): Promise<Member | null> {
    const pieces = pass.split('.');
    if (pieces.length !== 3) return null;
    let header: Record<string, unknown>, claims: Record<string, unknown>;
    try { header = part(pieces[0]); claims = part(pieces[1]); } catch { return null; }
    const algorithm = typeof header.alg === 'string' ? ALGORITHMS[header.alg] : undefined;
    if (!algorithm || typeof header.kid !== 'string') return null;
    const key = await this.#keysHold(header.kid);
    if (!key) return null;
    const signed = Buffer.from(`${pieces[0]}.${pieces[1]}`);
    const signature = Buffer.from(pieces[2], 'base64url');
    const good = verify(algorithm.hash, signed, algorithm.dsa ? { key, dsaEncoding: algorithm.dsa } : key, signature);
    if (!good) return null;
    const seconds = this.#now() / 1000;
    if (claims.iss !== this.#signIn.issuer) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(this.#signIn.audience)) return null;
    if (typeof claims.exp !== 'number' || claims.exp <= seconds) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > seconds) return null;
    const teams = claims[this.#signIn.team_claim];
    if (!Array.isArray(teams) || !teams.includes(this.#signIn.members_team) || typeof claims.sub !== 'string') return null;
    return { pass, subject: claims.sub, teams: teams.filter((team): team is string => typeof team === 'string'), claims };
  }

  /** The member a request's cookie is signed in as, or null. */
  async memberOfCookie(cookie: string | undefined): Promise<Member | null> {
    if (!cookie) return null;
    const answer = await ask(this.#signIn.address, '/api/auth/token', { headers: { cookie, accept: 'application/json' } });
    if (answer.status !== 200) return null;
    let token: unknown;
    try { token = (JSON.parse(answer.body.toString('utf8')) as { token?: unknown }).token; } catch { return null; }
    return typeof token === 'string' ? this.memberOfPass(token) : null;
  }
}
