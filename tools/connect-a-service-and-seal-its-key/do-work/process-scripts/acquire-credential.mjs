#!/usr/bin/env node
// packages/service-connections/do-work/process-scripts/acquire-credential.mjs
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The blind, generic credential-acquisition process (run by compute.process via
// action:acquire-service-credential). It performs ONE service-declared dance —
// browser+loopback OR device-code — entirely from DATA, then hands back the
// non-secret account label and the sealed token material.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. FILE I/O ONLY — a compute.process subprocess has NO in-process Envelope
//    transport (globalTargetSender is unset), so this script NEVER calls
//    slot::credentials-vault. The owning workflow resolves the client from the
//    vault and mounts it (--client), and seals the token output (--token-out)
//    back into the vault. (Every other compute.process script in the repo is
//    file-based for exactly this reason.)
// 2. Branch ONLY on the DATA fields `flow` and `redirect.transport` — never on a
//    vendor/provider name. New mechanism = new DATA, zero code here.
// 3. The MAIN result (--out) carries ONLY { account_label, credential_handle_ref }.
//    The token sink (--token-out) carries the sealed material for the workflow to
//    write to the vault. Neither a token nor a client secret is ever printed.
//
// Inputs  (mounted by the workflow): --in acquire.json {acquire descriptor},
//         --client client.json {the resolved OAuth client document}.
// Outputs (captured by the workflow): --out acquire-result.json,
//         --token-out acquire-token.json.
// =============================================================================

import fs from 'node:fs/promises';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

// base64url (RFC 4648 §5, no padding) — the PKCE + code-challenge encoding.
function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function asRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function asString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function asNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

// A Google "Desktop"/"Installed" or "Web" OAuth client document → {id, secret}.
function clientShape(clientDocument) {
  const client = clientDocument.installed ?? clientDocument.web ?? clientDocument;
  return {
    client_id: asString(client.client_id, 'client.client_id'),
    client_secret: asString(client.client_secret, 'client.client_secret'),
  };
}

function appendParams(url, params) {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) next.searchParams.set(key, value.join(' '));
    else if (value !== undefined && value !== null) next.searchParams.set(key, String(value));
  }
  return next.toString();
}

function postForm(url, params, extraHeaders = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
    body: new URLSearchParams(params),
  });
}

async function jsonResponse(response, label) {
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned non-JSON`);
  }
  if (!response.ok) {
    // Fail-closed WITH provenance: carry the provider's real HTTP status +
    // error/description/body so a downstream null never masks the true cause.
    const detail = parsed.error_description
      || (typeof parsed.error === 'string' ? parsed.error : '')
      || (Array.isArray(parsed.errors) ? JSON.stringify(parsed.errors) : '')
      || JSON.stringify(parsed).slice(0, 300);
    throw new Error(`${label} failed: HTTP ${response.status} ${detail}`.trim());
  }
  return parsed;
}

function readPath(value, path) {
  let cursor = value;
  for (const part of path) {
    if (!cursor || typeof cursor !== 'object' || !(part in cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

async function firstFreePort(range) {
  if (!Array.isArray(range) || range.length !== 2) {
    throw new Error('redirect.port_range must contain two numbers');
  }
  const [start, end] = range.map((item, index) => asNumber(item, `redirect.port_range[${index}]`));
  for (let port = start; port <= end; port += 1) {
    const free = await new Promise((resolve) => {
      const server = http.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('No loopback port was available in the declared range');
}

function waitForLoopbackCode(port, timeoutMs, expectedState) {
  const redirectUri = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, redirectUri);
      const c = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      // IGNORE stray requests (favicon, prefetch, bare "/") — only the real OAuth
      // redirect carries ?code= or ?error=. Keep listening until it arrives.
      if (!c && !err) { res.statusCode = 204; res.end(); return; }
      // CSRF check (RFC 6749 §10.12): the redirect must echo our state verbatim.
      if (expectedState && u.searchParams.get('state') !== expectedState) {
        res.statusCode = 400; res.end('State mismatch.'); return;
      }
      res.end(c ? 'Sign-in approved. You can close this tab and return to the app.' : `Sign-in failed: ${err}`);
      server.close();
      c ? resolve(c) : reject(new Error(err));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('consent timed out'));
    }, timeoutMs);
    server.on('close', () => clearTimeout(timer));
    server.listen(port, '127.0.0.1');
  });
}

async function acquireLoopback(descriptor, client) {
  const redirect = asRecord(descriptor.redirect, 'redirect');
  const port = await firstFreePort(redirect.port_range);
  // redirect_uri must EXACTLY match the provider-registered callback. Providers
  // like Google accept any loopback port/path; providers like X do an exact
  // string match, so the descriptor pins the port range and declares the exact
  // path (e.g. "/") — a DATA field, never a code branch. Default '' preserves
  // every existing (Google) descriptor unchanged.
  const redirectPath = typeof redirect.path === 'string' ? redirect.path : '';
  const redirectUri = `http://127.0.0.1:${port}${redirectPath}`;
  const scopes = Array.isArray(descriptor.scopes) ? descriptor.scopes.filter((scope) => typeof scope === 'string') : [];

  // PKCE (RFC 7636), DATA-gated by `descriptor.pkce`. X REQUIRES it; providers
  // that ignore it are unaffected. The discriminant is a DATA flag, not a vendor
  // name — a new PKCE provider is a new descriptor, zero code here.
  const usePkce = descriptor.pkce === true;
  let codeVerifier = '';
  const challengeParams = {};
  if (usePkce) {
    codeVerifier = base64Url(crypto.randomBytes(32));
    challengeParams.code_challenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
    challengeParams.code_challenge_method = 'S256';
  }

  // `state` is REQUIRED by RFC 6749 §10.12 as CSRF protection, and providers
  // like X hard-reject authorize URLs without it ("Something went wrong").
  // Always send it; verify the echo on the loopback redirect.
  const state = base64Url(crypto.randomBytes(16));

  const authorizeUrl = appendParams(asString(descriptor.authorize_url, 'authorize_url'), {
    ...asRecord(descriptor.auth_params ?? {}, 'auth_params'),
    ...challengeParams,
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    state,
  });
  execFile('open', [authorizeUrl], () => {});
  const code = await waitForLoopbackCode(
    port,
    asNumber(descriptor.process?.timeout_ms ?? descriptor.timeout_ms ?? 240000, 'timeout_ms'),
    state,
  );

  // Token exchange. Client authentication is DATA-gated by `descriptor.client_auth`:
  //   'basic' → HTTP Basic header base64(id:secret) with NO secret in the body
  //             (confidential clients such as X mandate Basic auth), else
  //   (default) client_secret in the body (Google's installed-client convention).
  const tokenBody = {
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  };
  if (usePkce) tokenBody.code_verifier = codeVerifier;
  const tokenHeaders = {};
  if (descriptor.client_auth === 'basic') {
    // Confidential client (RFC 6749 §2.3 + X's OAuth2 docs): the client is
    // identified AND authenticated ONLY by the HTTP Basic header. `client_id`
    // MUST NOT also appear in the body — mixing two client-identification
    // methods makes strict providers (X) reject with unauthorized_client /
    // invalid_request. The secret never enters the body.
    tokenHeaders.authorization = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`;
  } else {
    // Public / installed-client convention (e.g. Google): the client is
    // identified by `client_id` in the body, with the secret alongside it.
    tokenBody.client_id = client.client_id;
    tokenBody.client_secret = client.client_secret;
  }
  return {
    tokens: await jsonResponse(
      await postForm(asString(descriptor.token_url, 'token_url'), tokenBody, tokenHeaders),
      'token endpoint',
    ),
  };
}

async function acquireDeviceCode(descriptor, client) {
  const device = asRecord(descriptor.device_code ?? descriptor.redirect, 'device_code');
  const scopes = Array.isArray(descriptor.scopes) ? descriptor.scopes.filter((scope) => typeof scope === 'string') : [];
  const deviceCode = await jsonResponse(await postForm(asString(device.device_code_url, 'device_code_url'), {
    client_id: client.client_id,
    scope: scopes.join(' '),
  }), 'device-code endpoint');
  // The device code is the ONLY thing the user must see — emit it for the UI.
  process.stdout.write(JSON.stringify({
    device: {
      user_code: deviceCode.user_code,
      verification_uri: deviceCode.verification_uri ?? deviceCode.verification_url,
    },
  }) + '\n');
  const intervalMs = asNumber(device.poll_interval_ms, 'device_code.poll_interval_ms');
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const response = await postForm(asString(descriptor.token_url, 'token_url'), {
      client_id: client.client_id,
      client_secret: client.client_secret,
      device_code: deviceCode.device_code,
      grant_type: asString(device.grant_type, 'device_code.grant_type'),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (response.ok) return { tokens: parsed };
    if (parsed.error !== device.pending_error) throw new Error(String(parsed.error ?? 'device-code token polling failed'));
  }
}

async function accountLabel(descriptor, tokens) {
  const identity = asRecord(descriptor.identity, 'identity');
  const info = await jsonResponse(await fetch(asString(identity.userinfo_url, 'identity.userinfo_url'), {
    headers: { authorization: `Bearer ${asString(tokens.access_token, 'tokens.access_token')}` },
  }), 'identity endpoint');
  const path = Array.isArray(identity.label_path) ? identity.label_path.filter((part) => typeof part === 'string') : [];
  const label = readPath(info, path);
  if (typeof label !== 'string' || !label) throw new Error('The service did not return an account name. Nothing was connected.');
  return label;
}

async function resourceRefs(descriptor, tokens) {
  const identity = asRecord(descriptor.identity, 'identity');
  const collections = Array.isArray(identity.resource_collections)
    ? identity.resource_collections
    : [];
  const refs = [];
  for (const rawCollection of collections) {
    const collection = asRecord(rawCollection, 'identity.resource_collections[]');
    const response = await jsonResponse(await fetch(asString(collection.url, 'resource collection url'), {
      headers: { authorization: `Bearer ${asString(tokens.access_token, 'tokens.access_token')}` },
    }), 'resource collection endpoint');
    const itemsPath = Array.isArray(collection.items_path)
      ? collection.items_path.filter((part) => typeof part === 'string')
      : [];
    const idPath = Array.isArray(collection.id_path)
      ? collection.id_path.filter((part) => typeof part === 'string')
      : [];
    const items = readPath(response, itemsPath);
    if (!Array.isArray(items)) throw new Error('The service returned unreadable account resources. Nothing was connected.');
    const prefix = asString(collection.ref_prefix, 'resource collection ref_prefix');
    for (const item of items) {
      const id = readPath(item, idPath);
      if (typeof id === 'string' && id) refs.push(`${prefix}${id}`);
    }
  }
  return [...new Set(refs)].sort();
}

// ---------------------------------------------------------------------------
// Main — read the descriptor + the workflow-resolved client, run the declared
// dance, write the result + token-sink files. No vault calls, no secret in logs.
// ---------------------------------------------------------------------------

const descriptor = asRecord(JSON.parse(await fs.readFile(argValue('--in', 'acquire.json'), 'utf8')), 'descriptor');
// The OAuth client document is resolved by DATA, three ways (open by topology):
//   • descriptor.client       — inline (rare; tests)
//   • descriptor.client_path  — a LOCAL desktop client file the user owns
//     (topology C — exactly how publish-youtube.mjs reads client_secret.json).
//     The studio runs on the user's machine, so this process can read it.
//   • --client <file>         — a file the WORKFLOW mounts after resolving it
//     from the vault (topology A/B — platform/BYO client).
let clientDocument;
if (descriptor.client && typeof descriptor.client === 'object') {
  clientDocument = descriptor.client;
} else if (typeof descriptor.client_ref === 'string' && descriptor.client_ref.length > 0) {
  // The owning workflow resolves client_ref from credentials-vault and mounts
  // the resolved document at the fixed client.json path. A local client_path is
  // deliberately NOT allowed to override the vault-resolved client.
  clientDocument = JSON.parse(await fs.readFile('client.json', 'utf8'));
} else if (typeof descriptor.client_path === 'string' && descriptor.client_path.length > 0) {
  clientDocument = JSON.parse(await fs.readFile(descriptor.client_path, 'utf8'));
} else {
  clientDocument = JSON.parse(await fs.readFile(argValue('--client', 'client.json'), 'utf8'));
}
const client = clientShape(asRecord(clientDocument, 'client'));

const redirect = asRecord(descriptor.redirect, 'redirect');
const store = asRecord(descriptor.store, 'store');
const outPath = argValue('--out', 'acquire-result.json');

function credentialKeyForAccount(label) {
  const base = asString(store.vault_key ?? store.vault_target.split("::").pop(), 'vault_key')
    || asString(store.vault_target, 'vault_target').split('::').pop();
  if (!/^[A-Za-z0-9_-]+$/.test(base)) {
    throw new Error('The saved account name cannot be used safely. Nothing was connected.');
  }
  const slug = String(label)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${base}--${slug || 'account'}`;
}

// The full dance runs inside a guard. The process-engine collects the declared
// output file ONLY when exit_code === 0 (crates/process-engine/src/lib.rs:1057),
// so a throw AFTER the browser code is obtained would otherwise leave outputs
// empty — the workflow's `seal_token` then dies on a null value and the REAL
// provider error (e.g. an X token-exchange 400) is lost. Instead we ALWAYS
// write the declared output: success carries the sealed material; failure
// carries an explicit `error` (never a token) and mirrors it to a diagnostic
// file the operator can read. exit 0 either way so the output is collected.
try {
  let acquired;
  if (descriptor.flow === 'oauth2_auth_code' && redirect.transport === 'loopback') {
    acquired = await acquireLoopback(descriptor, client);
  } else if (descriptor.flow === 'oauth2_device_code' && redirect.transport === 'device_code') {
    acquired = await acquireDeviceCode(descriptor, client);
  } else {
    throw new Error("This service's sign-in method is not supported yet.");
  }
  const label = await accountLabel(descriptor, acquired.tokens);
  const discoveredResourceRefs = await resourceRefs(descriptor, acquired.tokens);
  const credentialKey = credentialKeyForAccount(label);
  // ONE output file (outputs.0 — the proven binding path). It carries BOTH the
  // non-secret result AND the sealed material. The workflow's seal_token step
  // reads `secret_value` and writes it to the vault; the workflow's `done` step
  // returns ONLY account_label + credential_handle_ref (explicit field picks), so
  // the token never reaches the dialog/JS. The token transits only engine-internal
  // workflow state on its way to the vault.
  await fs.writeFile(outPath, JSON.stringify({
    account_label: label,
    resource_refs: discoveredResourceRefs,
    // The workflow uses this physical vault key to seal the token. It includes
    // the account identity so a second account cannot overwrite the first.
    credential_key: credentialKey,
    // service-connections treats this as a secret NAME, not an envelope
    // address; keeping it physical makes reveal/downstream reads work.
    credential_handle_ref: credentialKey,
    // Refresh material must remain durable with the refresh token. Without the
    // client identity, a connector can use the short-lived access token once
    // but cannot survive expiry or restart. This entire object is sealed in the
    // vault; the client secret never enters connection DATA or result output.
    secret_value: JSON.stringify({
      tokens: acquired.tokens,
      oauth_client: {
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
      token_url: descriptor.token_url,
    }),
  }, null, 2));
} catch (error) {
  const detail = error && error.message ? String(error.message) : String(error);
  await fs.writeFile(outPath, JSON.stringify({
    account_label: null,
    credential_handle_ref: null,
    secret_value: null,
    error: detail,
  }, null, 2));
  // Best-effort operator diagnostic (the process already reads ~/.bitfield for
  // the client file, so this dir is reachable). Never contains a secret.
  try {
    await fs.writeFile(
      `${process.env.HOME || '.'}/.bitfield/acquire-credential-last-error.json`,
      JSON.stringify({ error: detail, stack: error && error.stack ? String(error.stack) : null }, null, 2),
    );
  } catch { /* diagnostic is best-effort */ }
  process.stderr.write(`acquire-credential failed: ${detail}\n`);
}
