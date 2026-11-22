// tools/choose-an-answerer/reader/codex-limits.mjs
//
// Purpose
//   Reads the Codex accounts' weekly usage from codex-lb (GET /api/accounts, no key) and turns it into public.provider_limits
//   rows (provider, account, window_name, used_percent, resets_at, read_at, source, state). The chooser reads those rows.
//   Names only: an account is labelled "codex-lb account N" by its place in the accountId order, so no email, id or key is
//   stored. Pure mapping (limitRowsOf) is separate from the read (readCodexLimits) so it can be tested with no server.
//
// Non-negotiable invariants
//   1. The source is codex-lb's own usage read. The vault is never read here; /v1/usage is not used.
//   2. A reading the account does not report is written as state 'unknown' with a null percent, never as zero.

/** provider_limits rows for each account in a codex-lb /api/accounts reply, read at `readAt` (an ISO string). */
export function limitRowsOf(reply, readAt) {
  const accounts = [...(reply?.accounts ?? [])].sort((a, b) => String(a.accountId).localeCompare(String(b.accountId)));
  return accounts.map((account, index) => {
    const remaining = account.usage?.secondaryRemainingPercent;
    const known = typeof remaining === 'number' && Number.isFinite(remaining);
    const active = account.status === 'active';
    return {
      provider: 'codex',
      account: `codex-lb account ${index + 1}`,
      window_name: 'weekly',
      used_percent: known ? Math.round((100 - remaining) * 100) / 100 : null,
      resets_at: account.resetAtSecondary ?? null,
      read_at: readAt,
      source: 'codex-lb /api/accounts',
      state: known && active ? 'ok' : 'unknown',
    };
  });
}

/** The reply of codex-lb's usage route, read from its local address (the door the computer declares as codex-lb). */
export async function readCodexLimits(baseUrl, { now = new Date(), fetchImpl = fetch } = {}) {
  const answer = await fetchImpl(`${baseUrl}/api/accounts`, { signal: AbortSignal.timeout(15000) });
  if (!answer.ok) throw Object.assign(new Error(`codex-lb answered ${answer.status}`), { status: answer.status });
  return limitRowsOf(await answer.json(), now.toISOString());
}
