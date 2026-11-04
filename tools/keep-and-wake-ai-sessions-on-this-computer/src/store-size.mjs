// src/store-size.mjs
//
// Purpose: one reading of how full a Durable Object's SQLite store is, shared by everything that watches or frees one:
// the person's store health (src/store-health.mjs), native full-store recovery (src/full-store-recovery.mjs) and the
// release's per-object size watch. The limit and the levels are DATA (src/store-size.json); nothing here names a level.
//
// Invariants:
//   1. A size is the platform's own count (sql.databaseSize), read without a statement. A store that reports none
//      (a host without the count, or a wrapper that hid it) has no size: null, never 0, so it reaches no level.
//   2. The level of a size is the highest row of store-size.json it reaches: at at_share of limit_bytes, or within
//      headroom_bytes of it. `freed` (what the object's own archival freed since it started) is taken off first, since
//      the platform's count need not fall when pages are freed for reuse.
//   3. A full store is one failure code (src/failure.mjs `store-full`, from src/platform-failures.json), whatever words
//      the host used.
import { failureOf } from './failure.mjs';
import settings from '../../record-log/do-work/store-size.json' with { type: 'json' };

export const limitBytes = settings.limit_bytes;

/** The store's size in bytes from its SQL handle (ctx.storage.sql, or a wrapper that passes databaseSize through). */
export function sizeOf(sql) {
  const bytes = Number(sql?.databaseSize);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

const reachedAt = (row, rules) => (Number.isFinite(row.headroom_bytes) ? rules.limit_bytes - row.headroom_bytes : rules.limit_bytes * row.at_share);

/** The highest level `bytes` (less `freed`) reaches, as its row with `at_bytes`, or null below every level. */
export function levelOf(bytes, { freed = 0, rules = settings } = {}) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const held = bytes - Math.max(0, Number(freed) || 0);
  let reached = null;
  for (const row of rules.levels) {
    const at = reachedAt(row, rules);
    if (held >= at && (reached === null || at >= reached.at_bytes)) reached = { ...row, at_bytes: at };
  }
  return reached;
}

/** The lowest level, the one a store is first warned at: its row with `at_bytes`. */
export function firstLevel(rules = settings) {
  return rules.levels.map(row => ({ ...row, at_bytes: reachedAt(row, rules) })).sort((a, b) => a.at_bytes - b.at_bytes)[0];
}

/** Whether a store of `bytes` refuses work of `kind` (a row's `refuses`, such as "growth"). */
export const refuses = (bytes, kind, options) => levelOf(bytes, options)?.refuses?.includes(kind) === true;

/** Whether `operation` is a command that only adds and the store of `bytes` is at a level that refuses growth. */
export const refusesGrowthOf = (bytes, operation, options) => settings.growth_operations.includes(operation) && refuses(bytes, 'growth', options);

export const isStoreFull = error => failureOf(error).code === 'store-full';
