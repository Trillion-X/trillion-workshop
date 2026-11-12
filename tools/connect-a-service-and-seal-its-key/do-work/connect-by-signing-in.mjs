  const state = random();
  // PKCE (RFC 7636 S256): the challenge is SHA-256 because the protocol fixes it; it is the service's check, not an
  // identity this service mints. The verifier waits with the state for the callback, then goes to the token request.
  const verifier = acquire.pkce ? base64url(crypto.getRandomValues(new Uint8Array(32))) : null;
  await env.APP_KV.put(`connect-state:${digest(state)}`, JSON.stringify({ store_id: storeId, service, tool_id: row.id, ...(reconnect ? { reconnect } : {}), ...(verifier ? { code_verifier: verifier } : {}) }), { expirationTtl: STATE_SECONDS });
  const address = new URL(acquire.authorize_url);
  const params = {
    client_id: clientId, redirect_uri: `${redirectOrigin}${acquire.redirect.path}`, response_type: 'code', scope: (acquire.scopes ?? []).join(acquire.scope_separator ?? ' '), state,
    ...(verifier ? { code_challenge: base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)))), code_challenge_method: 'S256' } : {}),
    ...(acquire.auth_params ?? {}),
  };
  for (const [key, value] of Object.entries(params)) address.searchParams.set(key, value);
