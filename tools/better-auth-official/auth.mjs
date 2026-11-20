// Better Auth, set up as its docs show (https://www.better-auth.com/docs): the shared Postgres store (store.mjs), email and password,
// passkey, two factor, email OTP, magic link, multi session, API keys, JWT (EdDSA), MCP (the OAuth 2.1 provider for MCP clients,
// with Client ID Metadata Documents), device authorization, bearer (which the device docs require to use its session token) and admin (removeUser and the rest, for the users settings.json names as admins). Everything that differs per place is DATA in settings.json,
// read from BETTER_AUTH_SETTINGS (default ./settings.json); the secret comes from BETTER_AUTH_SECRET.

import { betterAuth } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware, sessionMiddleware } from 'better-auth/api';
import {
  admin, bearer, deviceAuthorization, emailOTP, jwt, magicLink, multiSession, organization, twoFactor,
} from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { emailHook } from './send-email.mjs';
import { table as pageTable } from './pages.mjs';
import { cookieOptions } from './cookie-options.mjs';
import { trustedOriginsFor } from './attached-origins.mjs';
import { readSettings } from './settings.mjs';
import rules from './pages/sign-in-rules.json' with { type: 'json' };
import { holdLoopbackResources } from './loopback-resource.mjs';
import { storeDriver } from './store.mjs';
import { teamIdsOf, teamClaim } from './teams-claim.mjs';
import { callBeforeDelete } from './before-delete-url.mjs';

const read = readSettings();
// How an AI product's client metadata document is fetched: Better Auth's own https transport unless the layout names another module.
const { fetchClientMetadataResource } = await import(read.settings.cimd.fetch_module);
export const settings = read.settings;
export const pool = await storeDriver(settings);
const deliver = emailHook(settings.email, { minutes: String(settings.email_code.expires_in_seconds / 60), site: settings.site, site_url: `${settings.issuer}/`, assets_url: `${settings.issuer}${pageTable.assets_path}` });

// Better Auth waits for a send but only logs its failure ("Failed to run background task"), so the answer would still say the
// message is on its way. A send that failed is remembered by its address for a moment, and the after hook below turns the answer
// into an error the page shows ("The code could not be sent just now") on the paths that send mail.
const failedTo = new Map();
const mailPaths = new Set(['/email-otp/send-verification-otp', '/forget-password/email-otp', '/email-otp/request-password-reset', '/sign-in/magic-link', '/request-password-reset', '/send-verification-email', '/change-email']);
async function sendEmail(message) {
  try {
    const { id } = await deliver(message);
    console.log(`email ${message.kind} accepted by the sender as ${id}`);
  } catch (error) {
    failedTo.set(message.to, Date.now());
    console.error(`email ${message.kind} not sent: ${error.message}`);
    throw error;
  }
}
async function refuseWhenNotSent(ctx) {
  if (!mailPaths.has(ctx.path)) return;
  const now = Date.now();
  for (const [to, at] of failedTo) if (now - at > 10000) failedTo.delete(to);
  // A change of email sends to the current address, which the request does not name.
  const asked = ctx.path === '/change-email' ? [...failedTo.keys()] : [ctx.body?.email, ctx.body?.newEmail].filter(Boolean);
  const failed = asked.filter(to => failedTo.delete(to));
  if (failed.length) throw new APIError('INTERNAL_SERVER_ERROR', { code: 'EMAIL_NOT_SENT', message: 'The email could not be sent' });
}

// A password registered on an address before its owner proved it, and any session made with it, go when the owner signs in by code:
// the code proves the address, so nothing a stranger set up beforehand stays valid.
async function clearWhatWasNotProven(ctx) {
  const found = typeof ctx.body?.email === 'string' && await ctx.context.internalAdapter.findUserByEmail(ctx.body.email.toLowerCase());
  if (!found || found.user.emailVerified) return;
  await ctx.context.internalAdapter.deleteUserSessions(found.user.id);
  await ctx.context.internalAdapter.deleteAccounts(found.user.id);
}

// An AI's authorize request is changed before anything reads it:
// - A refresh token needs the offline_access scope, which an AI product may not ask for (the protected-resource document leaves it
//   out by design), and without one the person is signed out of their AI every hour. With settings.mcp.always_offline_access the
//   scope is added, so the consent page says so ("Stay connected while you keep using it").
// - Every connect goes to /consent (prompt=consent), even for an AI the person already allowed: that page is where a remembered AI is
//   shown "Connecting..." with an Undo, and where an address the AI is not known by needs the person to type it. Better Auth takes
//   the prompt out again when consent is answered.
function shapeAuthorize(ctx) {
  const scope = ctx.query?.scope;
  if (typeof scope === 'string' && scope.trim() && settings.mcp.always_offline_access && !scope.split(' ').includes('offline_access')) ctx.query.scope = `${scope} offline_access`;
  // A scope that has a read-only variant (rules.read_only_swaps) is asked with it, because the consent answer may only choose among the scopes
  // the signed request named: Read only then keeps the variant and drops the full scope.
  const asked = typeof ctx.query?.scope === 'string' ? ctx.query.scope.split(' ').filter(Boolean) : [];
  const variants = Object.entries(rules.read_only_swaps).filter(([full, variant]) => asked.includes(full) && !asked.includes(variant)).map(([, variant]) => variant);
  if (variants.length && ctx.request?.method === 'GET') ctx.query.scope = [...asked, ...variants].join(' ');
  // Only the AI's own request (a GET): Better Auth runs authorize again inside its consent and sign-in answers, and that run must not ask again.
  const prompt = (ctx.query?.prompt ?? '').split(' ').filter(Boolean);
  if (ctx.request?.method === 'GET' && !prompt.includes('consent')) ctx.query.prompt = [...prompt, 'consent'].join(' ');
}

// Read only is a switch on the consent screen, off for the person's own AI. Off, what is granted is what the AI asked for (the read-only variants
// shapeAuthorize added are left out where the full scope is asked). On, the scopes pages/sign-in-rules.json read_only_drops names go, and each
// full scope that has a read-only variant (read_only_swaps) is replaced by its variant, so an AI that gets less is the engine's to run with what it
// has. The signed query is checked by Better Auth itself afterwards, and only a subset of it is accepted.
function narrowConsent(ctx) {
  if (typeof ctx.body?.oauth_query !== 'string') return;
  const asked = (new URLSearchParams(ctx.body.oauth_query).get('scope') ?? '').split(' ').filter(Boolean);
  const swaps = Object.entries(rules.read_only_swaps);
  const leftOut = ctx.body.read_only ? [...rules.read_only_drops, ...swaps.map(([full]) => full)] : swaps.filter(([full]) => asked.includes(full)).map(([, variant]) => variant);
  ctx.body.scope = asked.filter(scope => !leftOut.includes(scope)).join(' ');
}

// A person deletes their own account (POST /delete-user, settings.delete_user). Before Better Auth deletes it, the business's own clean-up
// removes that person's rows in the business's own database, by a module in this folder (settings.delete_user.before_delete_module) or by
// the local address it names (before_delete_url, before-delete-url.mjs); a throw from either keeps the account. After it is gone, this tool
// removes the API keys the person held (apikey names its owner by id, with no foreign key). The consent and token rows go with the user by
// their foreign keys.
const ownRowsModule = settings.delete_user?.before_delete_module ? new URL(settings.delete_user.before_delete_module, import.meta.url).href : null;
const ownRowsHook = ownRowsModule ? (await import(ownRowsModule)).beforeDelete : null;
async function deleteOwnRows(user, request) {
  if (ownRowsHook) await ownRowsHook(user, request);
  if (settings.delete_user?.before_delete_url) await callBeforeDelete(settings.delete_user, user);
}
async function deleteKeysOf(user) {
  await (await auth.$context).adapter.deleteMany({ model: 'apikey', where: [{ field: 'referenceId', value: user.id }] });
}

// The person's connected AIs (GET /connected) and the one write that ends one (POST /connected/revoke {clientId}): its refresh tokens
// and access tokens and its consent are deleted together (a refresh token left behind could still be answered again inside the
// replay window), so a pass it holds stops standing at once (credential standing reads these rows) and it must ask again.
// Where the person's limit for an AI is kept: the consent row (one per person and AI), `idleLimitDays`, null for no end. A token made while a limit is set
// ends that many days after it was made (each use makes a new one, so the days restart on use); the limit is applied to the tokens that exist when it is
// set or cleared, and to each one made after (the after hook of /oauth2/token). A token already past its end stays ended.
const tokenEnd = (token, days) => new Date(new Date(token.createdAt).getTime() + (days === null ? settings.mcp.refresh_token_no_end_seconds : days * 86_400) * 1000);
async function applyLimit(adapter, consent) {
  const days = consent.idleLimitDays ?? null;
  const tokens = await adapter.findMany({ model: 'oauthRefreshToken', where: [{ field: 'userId', value: consent.userId }, { field: 'clientId', value: consent.clientId }, { field: 'revoked', value: null }] });
  for (const token of tokens) {
    const end = tokenEnd(token, days);
    if (new Date(token.expiresAt) > new Date() && end.getTime() !== new Date(token.expiresAt).getTime()) await adapter.update({ model: 'oauthRefreshToken', where: [{ field: 'id', value: token.id }], update: { expiresAt: end } });
  }
}
const connected = () => ({
  id: 'connected',
  schema: { oauthConsent: { fields: { idleLimitDays: { type: 'number', required: false } } } },
  hooks: {
    after: [{
      matcher: context => context.path === '/oauth2/token',
      handler: createAuthMiddleware(async ctx => {
        const clientId = ctx.body?.client_id;
        if (typeof clientId !== 'string') return;
        for (const consent of await ctx.context.adapter.findMany({ model: 'oauthConsent', where: [{ field: 'clientId', value: clientId }] })) if (consent.idleLimitDays) await applyLimit(ctx.context.adapter, consent);
      }),
    }],
  },
  endpoints: {
    limitConnected: createAuthEndpoint('/connected/limit', { method: 'POST', use: [sessionMiddleware] }, async ctx => {
      const userId = ctx.context.session.user.id;
      const { clientId, days } = ctx.body ?? {};
      if (typeof clientId !== 'string' || !clientId) throw new APIError('BAD_REQUEST', { message: 'clientId is needed' });
      if (days !== null && !(Number.isInteger(days) && days > 0)) throw new APIError('BAD_REQUEST', { message: 'days is a whole number of days, or null for no end' });
      const consent = await ctx.context.adapter.findOne({ model: 'oauthConsent', where: [{ field: 'userId', value: userId }, { field: 'clientId', value: clientId }] });
      if (!consent) throw new APIError('NOT_FOUND', { message: 'that AI is not connected' });
      await ctx.context.adapter.update({ model: 'oauthConsent', where: [{ field: 'id', value: consent.id }], update: { idleLimitDays: days } });
      await applyLimit(ctx.context.adapter, { ...consent, idleLimitDays: days });
      return ctx.json({ days });
    }),
    listConnected: createAuthEndpoint('/connected', { method: 'GET', use: [sessionMiddleware] }, async ctx => {
      const userId = ctx.context.session.user.id;
      const adapter = ctx.context.adapter;
      const consents = await adapter.findMany({ model: 'oauthConsent', where: [{ field: 'userId', value: userId }] });
      const now = Date.now();
      const ais = [];
      for (const consent of consents) {
        const client = await adapter.findOne({ model: 'oauthClient', where: [{ field: 'clientId', value: consent.clientId }] });
        // Asked of the database, never read as a page of rows: Better Auth's findMany answers 100 rows unless told more, and an AI used
        // daily holds a revoked token for every refresh, so its live token could fall outside the page and the AI be reported ended.
        const ofAi = [{ field: 'userId', value: userId }, { field: 'clientId', value: consent.clientId }];
        const [newest] = await adapter.findMany({ model: 'oauthRefreshToken', where: ofAi, sortBy: { field: 'createdAt', direction: 'desc' }, limit: 1 });
        const lastUsed = newest ? new Date(newest.createdAt).getTime() : 0;
        // Each refresh makes a token that lives idle_seconds from that moment, so the newest unused one is the access's end; with none
        // standing the access has ended: by the days passing unused (a token past its end), or because an old token was used a second time (Better Auth then deletes the whole chain).
        const unused = await adapter.findMany({ model: 'oauthRefreshToken', where: [...ofAi, { field: 'revoked', value: null }] });
        const standing = unused.some(token => new Date(token.expiresAt).getTime() > now);
        const endedBy = standing ? null : unused.length ? 'unused' : 'chain_ended';
        const endedAt = endedBy === 'unused' ? new Date(unused.reduce((latest, token) => Math.max(latest, new Date(token.expiresAt).getTime()), 0)).toISOString() : null;
        const scopes = Array.isArray(consent.scopes) ? consent.scopes : JSON.parse(consent.scopes ?? '[]');
        ais.push({
          client_id: consent.clientId, name: client?.name ?? null, scopes, connected_at: new Date(consent.createdAt).toISOString(),
          last_used_at: lastUsed ? new Date(lastUsed).toISOString() : null, read_only: !scopes.some(scope => rules.read_only_drops.includes(scope) || scope in rules.read_only_swaps),
          ended_by: endedBy, ended_at: endedAt, ended_text: endedBy === 'unused' ? settings.mcp.ended_unused_words.replace('{days}', consent.idleLimitDays) : null, idle_limit_days: consent.idleLimitDays ?? null,
          reconnect_url: /^https:\/\//.test(client?.uri ?? '') ? client.uri : null,
        });
      }
      return ctx.json({ ais });
    }),
    revokeConnected: createAuthEndpoint('/connected/revoke', { method: 'POST', use: [sessionMiddleware] }, async ctx => {
      const userId = ctx.context.session.user.id;
      const clientId = typeof ctx.body?.clientId === 'string' ? ctx.body.clientId : '';
      if (!clientId) throw new APIError('BAD_REQUEST', { message: 'clientId is needed' });
      const where = [{ field: 'userId', value: userId }, { field: 'clientId', value: clientId }];
      await ctx.context.adapter.transaction(async trx => {
        await trx.deleteMany({ model: 'oauthRefreshToken', where });
        await trx.deleteMany({ model: 'oauthAccessToken', where });
        await trx.deleteMany({ model: 'oauthConsent', where });
      });
      return ctx.json({ revoked: true });
    }),
  },
});

// Whether a client document address is one of the product's own programs (settings.mcp.first_party_clients, set where the tool is run): the
// consent page answers for those itself, so a person's own program goes from sign-in straight back with no screen.
const firstParty = () => ({
  id: 'first-party',
  endpoints: {
    isFirstParty: createAuthEndpoint('/first-party', { method: 'GET' }, async ctx => ctx.json({ first_party: (settings.mcp.first_party_clients ?? []).includes(ctx.query?.client_id) })),
  },
});

// The ids of the teams a person belongs to (the organization plugin's teamMember rows), read when a pass is signed, so a pass says
// who is in which team and no engine keeps a list of members. settings.teams names the claim and how many it carries.
const teamIds = userId => teamIdsOf(settings.teams, async () => (await auth.$context).adapter, userId);

export const auth = betterAuth({
  baseURL: settings.base_url,
  basePath: settings.base_path,
  database: pool,
  // The home origins, and every verified attached origin at request time (attached-origins.mjs).
  trustedOrigins: trustedOriginsFor(settings),
  disabledPaths: settings.disabled_paths,
  // The limits are kept per person, by the client address the front door forwards (the headers settings.rate_limit names, past its own
  // addresses in settings.rate_limit.trusted_proxies); with none found every person would share one bucket per path.
  advanced: { ...cookieOptions(settings), ipAddress: { ipAddressHeaders: settings.rate_limit.client_ip_headers, trustedProxies: settings.rate_limit.trusted_proxies } },
  // A signed-in person deletes their own user (POST /delete-user) only while settings.delete_user.enabled is true (deleteOwnRows first, then deleteKeysOf).
  user: {
    deleteUser: { enabled: settings.delete_user?.enabled === true, beforeDelete: deleteOwnRows, afterDelete: deleteKeysOf },
    // A person changes their address behind a recent sign-in: a link to the current address approves it, a link to the new one proves it.
    changeEmail: { enabled: true, sendChangeEmailConfirmation: async ({ user, newEmail, url, token }) => { await sendEmail({ kind: 'change-email', to: user.email, newEmail, url, token }); } },
  },
  // The signed session cookie answers a read for cookie_cache_seconds without a store read; the store stays the authority for
  // revocation, so a signed-out session is refused by the engine's standing check at once and by this tool when the cache ends.
  session: { freshAge: settings.session.fresh_age_seconds, cookieCache: { enabled: true, maxAge: settings.session.cookie_cache_seconds, strategy: 'compact' } },
  rateLimit: { enabled: settings.rate_limit.enabled },
  // A message that did not go is an error the page shows ("The code could not be sent just now"), never a promise that it is on its
  // way, so every send is awaited (Better Auth's documented cost: the answer waits for the mail command).
  // A password does not sign anyone in until its address is proven, so nobody can register a password on another person's address:
  // the person who owns it signs in by email code (below), and that code clears whatever was registered before it was proven.
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: settings.email_password.require_verification,
    sendResetPassword: async ({ user, url, token }) => { await sendEmail({ kind: 'reset-password', to: user.email, url, token }); },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url, token }) => { await sendEmail({ kind: 'verify-email', to: user.email, url, token }); },
  },
  hooks: {
    after: createAuthMiddleware(refuseWhenNotSent),
    // A new API key gets the settings prefix, never one the request asks for (the plugin lets a client choose its own). The body
    // is changed in place: a hook's returned context is merged over the request (defu), which never takes a key away.
    before: createAuthMiddleware(async ctx => {
      if (ctx.path === '/sign-in/email-otp') return clearWhatWasNotProven(ctx);
      if (ctx.path === '/oauth2/authorize') { await holdLoopbackResources(ctx.context.adapter, settings.mcp.loopback_resources, settings.mcp.resource_scopes, ctx.query?.resource); return shapeAuthorize(ctx); }
      if (ctx.path === '/oauth2/token') return holdLoopbackResources(ctx.context.adapter, settings.mcp.loopback_resources, settings.mcp.resource_scopes, ctx.body?.resource);
      if (ctx.path === '/oauth2/consent') return narrowConsent(ctx);
      if (ctx.path === '/api-key/create' && ctx.body) delete ctx.body.prefix;
    }),
  },
  plugins: [
    // No fixed `origin`: the passkey plugin then expects the base URL's origin, and an attached origin when trustedOrigins
    // names it (its related origins, /.well-known/webauthn), as its docs say.
    passkey({ rpID: settings.passkey.rp_id, rpName: settings.passkey.rp_name }),
    twoFactor({ issuer: settings.two_factor_issuer }),
    // The code's length, life, tries and sends come from settings.email_code; the pages say the same minutes (pages.mjs).
    emailOTP({
      otpLength: settings.email_code.digits,
      expiresIn: settings.email_code.expires_in_seconds,
      allowedAttempts: settings.email_code.attempts,
      rateLimit: { window: settings.email_code.window_seconds, max: settings.email_code.sends_per_window },
      async sendVerificationOTP({ email, otp, type }) { await sendEmail({ kind: `otp-${type}`, to: email, otp }); },
    }),
    // The one-time link that adds a passkey on another device: valid settings.add_passkey_link.expires_in_seconds, used once.
    magicLink({
      expiresIn: settings.add_passkey_link.expires_in_seconds,
      sendMagicLink: async ({ email, token, url }) => { await sendEmail({ kind: 'magic-link', to: email, url, token }); },
    }),
    firstParty(),
    multiSession(),
    apiKey({
      defaultPrefix: settings.api_key?.prefix, enableMetadata: true, rateLimit: settings.api_key?.rate_limit,
      // The scope names a key reaches when it is made, as the plugin's permissions ({"<resource>": [names]}); none by default,
      // so a key nobody granted reaches nothing.
      ...(settings.api_key?.default_permissions ? { permissions: { defaultPermissions: settings.api_key.default_permissions } } : {}),
    }),
    jwt({
      disableSettingJwtHeader: settings.disabled_paths.includes('/token'),
      jwks: { keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' } },
      jwt: { issuer: settings.issuer, audience: settings.audience, ...(settings.teams ? { definePayload: async ({ user }) => ({ ...user, ...(await teamClaim(settings.teams, teamIds, user.id)) }) } : {}) },
    }),
    mcp({
      loginPage: settings.mcp.login_page,
      consentPage: settings.mcp.consent_page,
      // The sign-in pages name the AI that is asking before the person has signed in: its public fields (name, address, icon) for a request whose signed query names that client.
      allowPublicClientPrelogin: true,
      resource: settings.mcp.resource,
      // Every client may ask for every configured resource (the door and a person's own engine, any port, made on demand): there is no per-client list to keep.
      enforcePerClientResources: false,
      // An AI's access has no end of its own: each refresh makes a token that lives settings.mcp.refresh_token_no_end_seconds, a date nobody reaches (the store's
      // column needs one). The person may set a limit for an AI (POST /connected/limit); the after hook of the connected plugin then shortens that AI's tokens.
      refreshTokenExpiresIn: settings.mcp.refresh_token_no_end_seconds,
      // A refresh token used again within this many seconds of its own rotation is answered, not taken for theft (which deletes the whole chain): the same
      // renewal sent twice at once (a client with no lock, a retry after a slow answer) must not end the person's sign-in. settings.json holds the number and why.
      refreshTokenReuseInterval: settings.mcp.refresh_token_reuse_interval,
      // The scopes a client may ask for and the /mcp resource allows (settings DATA); the resource row follows the settings.
      ...(settings.mcp.scopes ? { scopes: settings.mcp.scopes } : {}),
      ...(settings.mcp.resource_scopes ? { resources: [{ identifier: settings.mcp.resource, allowedScopes: settings.mcp.resource_scopes }], resourceSeedMode: 'merge' } : {}),
      // How long an AI's access token stands (settings.mcp.access_token_seconds): also how long a person taken out of a team is still admitted by the pass they hold.
      ...(settings.mcp.access_token_seconds ? { accessTokenExpiresIn: settings.mcp.access_token_seconds } : {}),
      // The person's email and whether it is verified (OIDC's `email`, `email_verified`), so a door can tell a proven inbox from a typed one, and the ids of their teams.
      customAccessTokenClaims: async ({ user }) => ({
        ...(user?.email ? { email: user.email, email_verified: user.emailVerified === true } : {}),
        ...(settings.teams && user?.id ? await teamClaim(settings.teams, teamIds, user.id) : {}),
      }),
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    deviceAuthorization({ verificationUri: settings.device.verification_uri }),
    bearer(),
    // Admins are the user ids settings.json names (the plugin's adminUserIds), never an id in code; with none named nobody is, and anyone else is refused.
    admin({ adminUserIds: settings.admin?.user_ids ?? [] }),
    // Organizations and their teams (https://www.better-auth.com/docs/plugins/organization): a person makes an organization and its teams,
    // invites people to it and puts them in a team, and takes them out, with the plugin's own endpoints. Which teams a person is in goes
    // out in every pass (teamClaim), so a computer that granted a team admits its members and nobody keeps a member list.
    ...(settings.teams ? [organization({ teams: { enabled: true } })] : []),
    // After the provider: its limit column joins the provider's consent table, which must exist first.
    connected(),
  ],
});
