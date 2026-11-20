// packages/service-connections/do-work/process-scripts/acquire-credential.pkce.test.mjs
//
// End-to-end proof of the DATA-gated PKCE / client_auth / redirect.path
// contract in acquire-credential.mjs (L127 guard for the X one-click flow).
//
// Runs the REAL script as a child process against a REAL local HTTP "provider"
// (authorize + token + userinfo on 127.0.0.1). No mocks of the code under test.
// The fake provider ASSERTS the wire contract a PKCE provider (X) enforces:
//   1. authorize request carries code_challenge (S256) + exact redirect_uri
//      including the declared redirect.path
//   2. token request carries code_verifier whose SHA-256 == code_challenge
//   3. client_auth:'basic' -> Authorization: Basic base64(id:secret), and the
//      secret is ABSENT from the form body
//   4. default (no flags) -> no PKCE params, secret in body (Google contract
//      unchanged — the deletion test)
//
// Run: node --test packages/service-connections/do-work/process-scripts/acquire-credential.pkce.test.mjs

// Register with the active harness so both the package-wide Vitest command and
// the documented standalone Node command execute this real-process proof.
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'acquire-credential.mjs');

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A fake OAuth provider that records what it saw. `authorize` immediately
 * redirects the "browser" (a plain fetch we fire ourselves, since `open` won't
 * navigate in CI) — instead we parse the authorize URL the script would open by
 * intercepting via PATH shim below, then deliver ?code= to the loopback server.
 */
function startProvider({ seen, tokenError = null }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      seen.token = {
        params: Object.fromEntries(new URLSearchParams(body)),
        authorization: req.headers.authorization ?? null,
      };
      res.setHeader('content-type', 'application/json');
      if (tokenError) {
        // Simulate a provider rejecting the exchange (e.g. X's redirect_uri
        // mismatch / invalid_client) to exercise the fail-closed guard.
        res.statusCode = tokenError.status ?? 400;
        res.end(JSON.stringify(tokenError.body ?? { error: 'invalid_request', error_description: 'bad thing' }));
        return;
      }
      res.end(JSON.stringify({ access_token: 'tok_live_test', token_type: 'bearer' }));
      return;
    }
    if (url.pathname === '/userinfo') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { username: 'testuser' } }));
      return;
    }
    if (url.pathname === '/resources') {
      seen.resourceAuthorization = req.headers.authorization ?? null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [{ id: 'UConfxVDElXLZDnEM29u_XjA' }] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Run the real script with a PATH-shimmed `open` that captures the authorize
 * URL, asserts on it, and then plays the browser: hits the loopback redirect
 * with ?code=. Returns { result, authorizeUrl, seen }.
 */
async function runAcquire({ descriptor, client, tokenError = null }) {
  const seen = {};
  const { server, port } = await startProvider({ seen, tokenError });
  const work = tempFolder(path.join(tmpdir(), 'acq-test-'));
  try {
    descriptor = {
      ...descriptor,
      authorize_url: 'https://provider.example/authorize',
      token_url: `http://127.0.0.1:${port}/token`,
      identity: {
        userinfo_url: `http://127.0.0.1:${port}/userinfo`,
        label_path: ['data', 'username'],
        ...(descriptor.identity ?? {}),
      },
      store: { vault_key: 'test', vault_target: 'credentials-vault::test' },
      client,
      timeout_ms: 15000,
    };
    if (Array.isArray(descriptor.identity.resource_collections)) {
      descriptor.identity.resource_collections = descriptor.identity.resource_collections.map((collection) => ({
        ...collection,
        url: collection.url === 'RESOURCE_URL' ? `http://127.0.0.1:${port}/resources` : collection.url,
      }));
    }
    await writeFile(path.join(work, 'acquire.json'), JSON.stringify(descriptor));

    // PATH shim: `open <url>` writes the url to a file instead of a browser.
    const openCapture = path.join(work, 'authorize-url.txt');
    await writeFile(path.join(work, 'open'), `#!/bin/sh\nprintf %s "$1" > "${openCapture}"\n`, { mode: 0o755 });

    const child = spawn(process.execPath, [SCRIPT, '--in', path.join(work, 'acquire.json'), '--out', path.join(work, 'result.json')], {
      cwd: work,
      env: { ...process.env, PATH: `${work}:${process.env.PATH}` },
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });

    // Wait for the script to "open the browser", then play the user consent.
    const authorizeUrl = await (async () => {
      for (let i = 0; i < 200; i += 1) {
        try { return new URL(await readFile(openCapture, 'utf8')); } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`authorize URL never captured. stderr: ${stderr}`);
    })();
    const redirectUri = authorizeUrl.searchParams.get('redirect_uri');
    // Real providers echo `state` verbatim on the redirect (RFC 6749 §4.1.2);
    // the script rejects redirects whose state doesn't match.
    const echoedState = authorizeUrl.searchParams.get('state');
    const stateParam = echoedState ? `&state=${encodeURIComponent(echoedState)}` : '';
    await fetch(`${redirectUri}${redirectUri.includes('?') ? '&' : '?'}code=test_code_123${stateParam}`);

    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(exitCode, 0, `script failed: ${stderr}`);
    const result = JSON.parse(await readFile(path.join(work, 'result.json'), 'utf8'));
    return { result, authorizeUrl, seen };
  } finally {
    server.close();
    await rm(work, { recursive: true, force: true });
  }
}

const CLIENT = { client_id: 'cid_test', client_secret: 'shh_secret' };

test('pkce:true + client_auth:basic + redirect.path (the X contract)', async () => {
  const { result, authorizeUrl, seen } = await runAcquire({
    descriptor: {
      flow: 'oauth2_auth_code',
      pkce: true,
      client_auth: 'basic',
      scopes: ['tweet.read', 'users.read'],
      redirect: { transport: 'loopback', port_range: [4573, 4580], path: '/' },
    },
    client: CLIENT,
  });

  // 1. authorize carried S256 PKCE + the exact redirect path + CSRF state
  //    (X hard-rejects authorize URLs without `state`: "Something went wrong").
  const challenge = authorizeUrl.searchParams.get('code_challenge');
  assert.ok(challenge, 'authorize must carry code_challenge');
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorizeUrl.searchParams.get('state'), 'authorize must carry state (RFC 6749 §10.12; X mandates it)');
  const redirectUri = authorizeUrl.searchParams.get('redirect_uri');
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/$/, 'redirect_uri must end with declared path "/"');

  // 2. token exchange proved possession: SHA256(code_verifier) === code_challenge.
  const verifier = seen.token.params.code_verifier;
  assert.ok(verifier, 'token request must carry code_verifier');
  assert.equal(base64Url(crypto.createHash('sha256').update(verifier).digest()), challenge);

  // 3. Basic client auth: header present, NEITHER client_id NOR secret in the
  //    body (X confidential contract + RFC 6749 §2.3 — one identification method).
  assert.equal(seen.token.authorization, `Basic ${Buffer.from('cid_test:shh_secret').toString('base64')}`);
  assert.equal(seen.token.params.client_secret, undefined, 'client_secret must not leak into the form body under basic auth');
  assert.equal(seen.token.params.client_id, undefined, 'client_id must NOT appear in the body under basic auth (X rejects mixed client identification)');

  // 4. Full flow completed to identity.
  assert.equal(result.error, undefined, "identity failed: " + String(result.error));
  assert.equal(result.account_label, 'testuser');
});

test('defaults unchanged (the Google deletion test): no pkce params, secret in body, bare redirect', async () => {
  const { result, authorizeUrl, seen } = await runAcquire({
    descriptor: {
      flow: 'oauth2_auth_code',
      scopes: ['openid'],
      redirect: { transport: 'loopback', port_range: [4573, 4580] },
      identity: {
        resource_collections: [{
          url: 'RESOURCE_URL',
          items_path: ['items'],
          id_path: ['id'],
          ref_prefix: 'youtube-channel:',
        }],
      },
    },
    client: CLIENT,
  });
  assert.equal(authorizeUrl.searchParams.get('code_challenge'), null, 'no PKCE unless descriptor.pkce === true');
  assert.match(authorizeUrl.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/, 'no path suffix unless declared');
  assert.equal(seen.token.authorization, null, 'no Basic header by default');
  assert.equal(seen.token.params.client_secret, 'shh_secret', 'secret stays in body by default (Google contract)');
  assert.equal(seen.token.params.client_id, 'cid_test', 'client_id stays in body by default (public/installed-client contract)');
  assert.equal(seen.token.params.code_verifier, undefined);
  assert.equal(seen.resourceAuthorization, 'Bearer tok_live_test');
  assert.deepEqual(result.resource_refs, ['youtube-channel:UConfxVDElXLZDnEM29u_XjA']);
});

test('fail-closed guard: a token-exchange error still writes the declared output with the real cause (never a null seal, never a token)', async () => {
  const { result } = await runAcquire({
    descriptor: {
      flow: 'oauth2_auth_code',
      pkce: true,
      client_auth: 'basic',
      scopes: ['tweet.read'],
      redirect: { transport: 'loopback', port_range: [4573, 4580], path: '/' },
    },
    client: CLIENT,
    tokenError: { status: 400, body: { error: 'invalid_request', error_description: 'Value passed for the authorization code was invalid.' } },
  });
  // The process must exit 0 (runAcquire asserts that) so the process-engine
  // collects the declared output — otherwise the workflow's seal_token dies on a
  // null value and the real cause is lost.
  assert.equal(result.secret_value, null, 'no token on failure');
  assert.ok(typeof result.error === 'string' && result.error.length > 0, 'error field carries the real cause');
  assert.match(result.error, /HTTP 400/, 'error includes the provider HTTP status');
  assert.match(result.error, /authorization code was invalid/, 'error includes the provider description');
});
