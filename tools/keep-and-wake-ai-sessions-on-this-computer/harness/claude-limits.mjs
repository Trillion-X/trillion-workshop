// harness/claude-limits.mjs
//
// Purpose
//   Writes what is known about a Claude subscription's limits as provider_limits rows (provider, account, window,
//   used_percent, resets_at, read_at, source, state), the same shape codex-answerer's Codex reader writes. Two sources:
//   1. the usage-limit words of a finished run (take-open-work.json limit_patterns and limit_reset): state "limited" with the
//      reset those words name, the fallback that is on now;
//   2. the Anthropic rate-limit headers of real traffic, read passively: OFF until the proxy passes them through (claude-limits.json
//      header_reader is "off"; the coordinator flips it after CLIProxyAPI's passthrough-headers is on). No probe is ever sent.
//   The header names come from claude-limits.json (header_rows), not from this file, so a changed name is a data change.
//
// Non-negotiable invariants
//   1. A row is written only from a reading that happened: words a run said, or headers a response carried. Never a guess.
//   2. The account is a label the source names (here, the AI row id); no token, key or header value that is a secret is kept.
//   3. The reader is off unless claude-limits.json says header_reader "on"; with it off, headers are ignored.
//
import { readFileSync } from 'node:fs';

const settings = JSON.parse(readFileSync(new URL('./claude-limits.json', import.meta.url), 'utf8'));

/** The window a limit's words name ("weekly" / "daily"), else "other". */
export const windowOf = words => (/weekly/i.test(String(words ?? '')) ? 'weekly' : /daily/i.test(String(words ?? '')) ? 'daily' : 'other');

/** The provider_limits row for a run that reached its usage limit. `resetsAt` is the ISO instant the words name, or null
 * when they name none (the caller rests limit_rest_hours; the row then carries that instant instead). */
export function limitedRow({ account, words, resetsAt, readAt = new Date().toISOString() }) {
  return { provider: settings.provider, account, window: windowOf(words), used_percent: null, resets_at: resetsAt ?? null,
    read_at: readAt, source: settings.sources.words, state: 'limited' };
}

/** Parses the rate-limit headers of one response into provider_limits rows (one per window the headers name). Returns [] when
 * the reader is off, so a caller can always call it. `headers` is a plain object with lowercase names, or a Headers-like object. */
export function rowsFromHeaders(headers, { account, readAt = new Date().toISOString() } = {}) {
  if (settings.header_reader !== 'on') return [];
  const read = name => (name && (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name])) || null;
  return settings.header_rows.map(({ window, utilization, reset, status }) => {
    const used = read(utilization);
    const resets = read(reset);
    if (used === null && resets === null) return null;
    const percent = used === null ? null : Number(used) * settings.utilization_scale;
    const rejected = read(status) === 'rejected';
    return { provider: settings.provider, account, window, used_percent: Number.isFinite(percent) ? percent : null,
      resets_at: resets === null ? null : new Date(Number(resets) * 1000).toISOString(), read_at: readAt, source: settings.sources.headers,
      state: rejected ? 'limited' : 'ok' };
  }).filter(Boolean);
}

/** The SQL and parameters that record one provider_limits row (upsert on provider, account, window). */
export function upsertLimit(row) {
  return { sql: settings.upsert_sql, params: [row.provider, row.account, row.window, row.used_percent, row.resets_at, row.read_at, row.source, row.state] };
}
