// packages/interaction-program/read-data/feed-selectors.mjs
//
// =============================================================================
// PURPOSE: pure parsers for the member-facing Community FEED surface
// (mount-community-feed.tsx). Turns raw Bitfield `community-post` records into
// display-ready post models. ZERO I/O, ZERO React (pure functions so they are
// unit-testable and reusable, the leaf-computation convention like
// console-selectors.mjs).
//
// A community-post record is self-describing DATA:
//   { kind:'community-post', id, title, body, author, created_at (or date),
//     author_role? ('operator'|'member'), member_ref? }
// The feed is DATA-driven: a new post is a new record, ZERO code change
// (L090). Operator vs member styling is derived from DATA (author_role /
// member_ref), never a hardcoded author name.
//
// The extensive documentation here is a design feature; do not remove it.
// =============================================================================

/** Accept an array, `{records:[...]}`, or `{rows:[...]}` and return the records. */
export function recordList(raw) {
  if (Array.isArray(raw)) return raw.filter((r) => r && typeof r === 'object');
  if (raw && typeof raw === 'object') {
    for (const key of ['records', 'rows', 'items']) {
      if (Array.isArray(raw[key])) return raw[key].filter((r) => r && typeof r === 'object');
    }
  }
  return [];
}

function readString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** A post's payload may be the record itself or nested under `.payload`. */
function unwrap(record) {
  if (record && typeof record === 'object' && record.payload && typeof record.payload === 'object') {
    return record.payload;
  }
  return record || {};
}

/**
 * Relative-time label from an ISO date/`created_at` string, computed against a
 * caller-supplied `nowMs` (NEVER Date.now() here, the caller owns the clock so
 * this stays pure/deterministic for tests). Falls back to the raw date string.
 */
export function relativeTime(dateStr, nowMs) {
  const iso = readString(dateStr);
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t) || typeof nowMs !== 'number') return iso;
  const days = Math.floor((nowMs - t) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return iso;
}

/**
 * Parse raw community-post records into display models, newest first.
 * @param {unknown} raw   the bound feed value (array or {records})
 * @param {number}  nowMs caller clock for relative-time (optional)
 * @returns {Array<{id,title,body,author,isOperator,dateIso,relative}>}
 */
export function buildPostModels(raw, nowMs) {
  const models = [];
  for (const record of recordList(raw)) {
    const p = unwrap(record);
    if (readString(p.kind) && p.kind !== 'community-post') continue;
    const id = readString(p.id) || readString(record.address);
    if (!id) continue;
    const dateIso = readString(p.created_at) || readString(p.date);
    // Operator authorship is DATA-derived: explicit author_role, else "no
    // member_ref" (an announcement authored by the program, not a member).
    const isOperator = p.author_role === 'operator' || (!readString(p.member_ref) && p.author_role !== 'member');
    models.push({
      id,
      title: readString(p.title),
      body: readString(p.body) || '',
      author: readString(p.author) || 'Member',
      isOperator,
      dateIso,
      relative: relativeTime(dateIso, nowMs),
    });
  }
  models.sort((a, b) => {
    const ta = a.dateIso ? Date.parse(a.dateIso) : 0;
    const tb = b.dateIso ? Date.parse(b.dateIso) : 0;
    return tb - ta;
  });
  return models;
}

/** First two letters for an avatar monogram (author initials). */
export function monogram(author) {
  const name = readString(author) || '';
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.slice(0, 2) || '?').toUpperCase();
}
