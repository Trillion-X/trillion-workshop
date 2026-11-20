// tools/form-groups-and-matches/read-data/feed-selectors.mjs
//
// Pure parsers for a community's member feed. They turn raw post records into display-ready post models. No I/O, no
// clock (the caller hands in `nowMs`), no UI.
//
// A post is self-describing DATA: { kind: 'community-post', id, title, body, author, created_at | date, author_role?,
// member_ref? }. A new post is a new record and needs no code change. Operator or member styling comes from the post's
// own `author_role` and `member_ref`, never from an author's name.

/** Accept an array, `{ records }`, `{ rows }` or `{ items }` and return its object entries. Anything else is empty. */
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

/** A post's fields are the record itself, or the record's `payload` when it is wrapped. */
function unwrap(record) {
  if (record && typeof record === 'object' && record.payload && typeof record.payload === 'object') {
    return record.payload;
  }
  return record || {};
}

/**
 * Relative-time label for an ISO date string, against the caller's `nowMs`. Falls back to the date string itself when
 * there is no clock or the date is thirty days old or more.
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
 * Post records as display models, newest first. A post is the operator's unless it names a member: an explicit
 * `author_role` wins, else a post with no `member_ref` is the operator's.
 * @param {unknown} raw   the bound feed value (array, or `{ records }`)
 * @param {number}  nowMs the caller's clock for relative time (optional)
 * @returns {Array<{id, title, body, author, isOperator, dateIso, relative}>}
 */
export function buildPostModels(raw, nowMs) {
  const models = [];
  for (const record of recordList(raw)) {
    const p = unwrap(record);
    if (readString(p.kind) && p.kind !== 'community-post') continue;
    const id = readString(p.id) || readString(record.address);
    if (!id) continue;
    const dateIso = readString(p.created_at) || readString(p.date);
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

/** Two-letter avatar monogram from an author's name: the initials of the first two words, else the first two letters. */
export function monogram(author) {
  const name = readString(author) || '';
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.slice(0, 2) || '?').toUpperCase();
}
