// scripts/paid-proof-account.mjs
// Gives a proof account the paid plan, for proofs that watch what a paid person gets (a free account keeps nothing a
// computer or an AI sends it). the credential argument names the file holding the operator's key; that key is read into
// memory for this one request (POST /mcp/api/owner-grant) and never kept or printed. Returns the account's user id.
import { readCredentialFile } from './credential-file.mjs';
import { setTimeout as wait } from 'node:timers/promises';

// The operator's key is its own mode-600 file under ~/.bitfield/credentials (never the login keychain, which prompts on the
// person's screen); `credential` names that file.
const operatorKeyFrom = credential => readCredentialFile(credential);

const decisionKeptAccess = 'access:decision-kept';

/** The grant endpoint is only a write receipt; paid fixtures proceed only after the returned access includes the paid capability. */
export function verifyPaidGrantReadback(answer) {
  if (!Array.isArray(answer?.access?.capabilities) || !answer.access.capabilities.includes(decisionKeptAccess)) {
    throw new Error('The paid plan grant returned successfully, but the account readback does not include paid decision access.');
  }
  return answer.access;
}

/** Check operator authority before creating a disposable account or browser. */
export async function verifyPaidProofOwner(origin, credential, options = {}) {
  // Use the existing operator-authority endpoint rather than the personal-account endpoint.
  // That same authority guards owner-grant; admission still needs the actual grant and account readback.
  const { timeoutMs = 120_000, maxAttempts = 12, retryDelayMs = 5_000, signal, onAttempt, ...ownerOptions } = options;
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    const started = Date.now();
    try {
      const answer = await verifyProofWorkspaceOwner(origin, credential, {
        ...ownerOptions, signal, timeoutMs: Math.min(30_000, Math.max(1, deadline - Date.now())),
      });
      onAttempt?.({ attempt, status: 200, duration_ms: Date.now() - started });
      return answer;
    } catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.cause?.code === 'UND_ERR_CONNECT_TIMEOUT';
      onAttempt?.({ attempt, status: error.status ?? null, duration_ms: Date.now() - started, ...(timedOut ? { timed_out: true } : {}) });
      signal?.throwIfAborted();
      // Only a busy reply or a timeout on this read-only check is retried.
      // Neither a refusal nor an unknown transport failure grants admission.
      const remaining = deadline - Date.now();
      if ((!timedOut && error.status !== 503) || attempt >= maxAttempts || remaining <= 0) throw error;
      await wait(Math.min(error.retryAfterMs ?? retryDelayMs, remaining), undefined, { signal });
      if (Date.now() >= deadline) throw error;
    }
  }
}

export async function grantPaidPlan(key, origin, credential, { signal, onAttempt, request = fetch, operatorKey: suppliedKey, retryDelayMs = 10_000, requestTimeoutMs = 30_000 } = {}) {
  const boundedSignal = duration => signal ? AbortSignal.any([signal, AbortSignal.timeout(duration)]) : AbortSignal.timeout(duration);
  const accountStarted = Date.now();
  const account = await request(`${origin}/mcp/api/account`, { signal: boundedSignal(30_000), headers: { authorization: `Bearer ${key}` } });
  onAttempt?.({ stage: 'account', attempt: 1, status: account.status, duration_ms: Date.now() - accountStarted });
  if (!account.ok) throw new Error(`The new account could not be read: HTTP ${account.status}. No plan grant was sent.`);
  const answerAccount = await account.json().catch(() => null);
  const user_id = answerAccount?.user_id;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(user_id ?? '')) {
    throw new Error('The new account lookup did not return its account ID. No plan grant was sent.');
  }
  const operatorKey = suppliedKey ?? operatorKeyFrom(credential);
  // Try this exact-account grant at most twice. Each request is bounded by requestTimeoutMs; repeated refusal needs investigation.
  let granted;
  const deadline = Date.now() + 120_000;
  for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt += 1) {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    granted = await request(`${origin}/mcp/api/owner-grant`, { method: 'POST', signal: boundedSignal(Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now()))), headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorKey}` }, body: JSON.stringify({ user_id }) })
      .catch(error => ({ ok: false, status: 503, transport_error: String(error?.cause?.code ?? error), text: async () => String(error?.cause?.code ?? error) }));
    onAttempt?.({ stage: 'grant', attempt: attempt + 1, duration_ms: Date.now() - startedAt,
      status: granted.transport_error ? null : granted.status, ...(granted.transport_error ? { transport_error: granted.transport_error } : {}) });
    signal?.throwIfAborted();
    if (granted.status !== 503 || attempt === 1) break;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(retryDelayMs, deadline - Date.now()))));
  }
  if (!granted.ok) {
    if (granted.transport_error) throw new Error(`The paid plan could not be given to the new account: the request failed (${granted.transport_error}).`);
    const reason = await granted.text().catch(() => '');
    throw new Error(`The paid plan could not be given to the new account: the service answered ${granted.status}${reason ? `: ${reason.slice(0, 1200)}` : '.'}`);
  }
  const answer = await granted.json().catch(() => null);
  verifyPaidGrantReadback(answer);
  return user_id;
}

const proofWorkspaceIdFor = userId => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(userId ?? '')) {
    throw new Error('The disposable UI proof needs its exact created account.');
  }
  return `disposable-workspace-${userId}`;
};

/** A read-only policy-owner check, before creating a disposable account. */
export async function verifyProofWorkspaceOwner(origin, credential, { request = fetch, operatorKey, timeoutMs = 10_000, signal } = {}) {
  const response = await request(`${origin}/mcp/api/show-rules`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${operatorKey ?? operatorKeyFrom(credential)}` },
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok || answer.authority !== 'operator') {
    const retryAfter = response.headers.get('retry-after');
    const retrySeconds = retryAfter === null ? NaN : Number(retryAfter);
    throw Object.assign(new Error(`Proof workspace policy owner read: HTTP ${response.status}${answer.authority ? ` (${answer.authority})` : ''}.`), {
      status: response.status,
      ...(Number.isFinite(retrySeconds) && retrySeconds >= 0 ? { retryAfterMs: retrySeconds * 1000 } : {}),
    });
  }
  return { available: true };
}

/** Removes the deterministic policy for one exact proof account, even if admission returned no handle. */
export async function removeProofWorkspace(userId, origin, credential, { request = fetch, operatorKey, retryDelayMs = 1_000 } = {}) {
  const id = proofWorkspaceIdFor(userId);
  const key = operatorKey ?? operatorKeyFrom(credential);
  const deadline = Date.now() + 120_000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await request(`${origin}/mcp/api/show-rules/remove`, { method: 'POST',
        signal: AbortSignal.timeout(Math.min(30_000, Math.max(1, deadline - Date.now()))),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
      const answer = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(`Proof workspace policy /show-rules/remove: HTTP ${response.status} ${answer.code ?? answer.error ?? ''}`), { status: response.status });
      if (!Array.isArray(answer.rules) || answer.rules.some(rule => rule.id === id)) {
        throw new Error(`Proof workspace policy ${id} remains after removal.`);
      }
      return answer;
    } catch (error) {
      // This exact-id removal is idempotent. Retry only a busy reply or timeout;
      // authorization refusals, unknown failures and an invalid readback remain terminal.
      if ((error.status !== 503 && error.name !== 'TimeoutError') || attempt >= 3 || Date.now() >= deadline) throw error;
      await wait(Math.min(retryDelayMs * attempt, Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline) throw error;
    }
  }
}

// A fresh UI fixture is admitted through the existing operator-owned setup policy.
// This changes admission for its one exact disposable account, never full-setup evidence,
// customer requirements, sign-in, source permissions or paid access. It expires if cleanup fails.
// Only the exact account selects this fixture: completion remains the setup owner's observation.
// is_unknown is a measurement operator, not a boolean operator for the done fact.
export async function admitProofWorkspace(userId, origin, credential, { request = fetch, operatorKey: suppliedKey, retryDelayMs = 1_000 } = {}) {
  const id = proofWorkspaceIdFor(userId);
  const operatorKey = suppliedKey ?? operatorKeyFrom(credential);
  const ask = async (path, body) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await request(`${origin}/mcp/api${path}`, { method: body === undefined ? 'GET' : 'POST',
          signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${operatorKey}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const answer = await response.json();
        if (!response.ok) throw Object.assign(new Error(`Proof workspace policy ${path}: HTTP ${response.status} ${answer.code ?? answer.error ?? ''}`), { status: response.status });
        return answer;
      } catch (error) {
        // Only the read is replayed. An uncertain policy write still follows
        // exact-id cleanup below; it never triggers another POST.
        if (body !== undefined || attempt >= 3 || (error.status !== 503 && error.name !== 'TimeoutError')) throw error;
        await wait(retryDelayMs * attempt);
      }
    }
  };
  const policy = await ask('/show-rules');
  if (policy.authority !== 'operator') throw new Error('The proof workspace policy must use the current operator owner.');
  const until = new Date(Date.now() + 60 * 60_000).toISOString();
  const remove = () => removeProofWorkspace(userId, origin, credential, { request, operatorKey });
  try {
    const saved = await ask('/show-rules/set', { rule: { id, label: 'Disposable Sites UI proof', subject: 'setup-step',
      effect: 'change', when: { kind: 'group', combinator: 'and', negate: false, rules: [
        { kind: 'rule', field: 'account_id', operator: 'is_any_of', params: { values: [userId] } },
      ] }, set: [{ path: ['required'], value: false }], until } });
    if (saved.rule?.id !== id || saved.rule?.until !== until) throw new Error('The exact proof workspace policy was not saved.');
    return { id, until, account_id: userId, full_setup_verified: false, remove };
  } catch (error) {
    // A timed-out or malformed reply may follow a successful write. Retire the
    // deterministic exact-account policy even when no handle reached the caller.
    try { await remove(); }
    catch (cleanupError) {
      throw new Error(`${error.message} Cleanup of ${id} also failed: ${cleanupError.message}`, { cause: error });
    }
    throw error;
  }
}
