// packages/account-contact-points/do-work/import-contact-points.ts
//
// Pure leaf for the IMPORTED-LEAD acquisition path (J07 gate
// free-signup-paid-signup-and, third path). The whole import job is:
// normalize N raw rows -> for each valid row, converge on the SAME
// `action:upsert-email-contact-point` every other acquisition path uses
// (L063: one local entry signal — the contact-point delta — for the whole
// category; the welcome claim + activation buckets fire off that delta with
// zero import-specific policy).
//
// This file is I/O-free: row validation + provenance derivation only. The
// target wrapper (import-contact-points-target.ts) owns the per-row
// account-identity.derive ask + the upsert dispatch (TS boundary — package
// asks NEVER ride inside workflow definitions).
//
// Source grammar (self-describing DATA, L090 — nothing enumerated here):
//   { source: string, rows: [{ email, at?, verified_state? }, ...] }
// `source` is an open label ("csv:2026-07-03", "sheet:leads", "waitlist") —
// provenance becomes `source_ref: "import:<source>"` on every row.

export interface ImportRow {
  email: string;
  at?: string;
  verified_state?: string;
}

export interface NormalizedImportRow {
  email: string;
  source_ref: string;
  at: string;
  verified_state?: string;
}

export interface ImportRejection {
  index: number;
  reason: string;
  email?: string;
}

export interface NormalizedImport {
  rows: NormalizedImportRow[];
  rejected: ImportRejection[];
  source_ref: string;
}

const looksLikeEmail = (value: unknown): value is string =>
  typeof value === 'string' && value.includes('@') && value.trim().length > 2;

/**
 * Validate + normalize an import batch. Fail-closed per row (a bad row is
 * REJECTED with its exact reason, never guessed), fail-closed on the batch
 * (missing source or empty rows throws — no anonymous provenance). Duplicate
 * emails within one batch collapse to the LAST occurrence (latest wins,
 * matching the upsert's own latest-wins law).
 */
export function normalizeImportBatch(input: {
  source?: unknown;
  rows?: unknown;
  at?: string;
}): NormalizedImport {
  const source = typeof input.source === 'string' ? input.source.trim() : '';
  if (!source) {
    throw new Error(
      `import: source (provenance label) required; received input shape: ${JSON.stringify(input).slice(0, 300)}`,
    );
  }
  const rawRows = Array.isArray(input.rows) ? input.rows : [];
  if (rawRows.length === 0) throw new Error('import: rows must be a non-empty array');
  const batchAt = input.at ?? '';
  const source_ref = `import:${source}`;

  const rejected: ImportRejection[] = [];
  const byEmail = new Map<string, NormalizedImportRow>();
  rawRows.forEach((raw, index) => {
    const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    if (!row) {
      rejected.push({ index, reason: 'row is not an object' });
      return;
    }
    if (!looksLikeEmail(row.email)) {
      rejected.push({ index, reason: 'missing or invalid email', email: typeof row.email === 'string' ? row.email : undefined });
      return;
    }
    const email = row.email.trim().toLowerCase();
    const at = typeof row.at === 'string' && row.at.trim() ? row.at : batchAt;
    if (!at) {
      rejected.push({ index, reason: 'missing at (timestamp) and no batch-level at', email });
      return;
    }
    byEmail.set(email, {
      email,
      source_ref,
      at,
      ...(typeof row.verified_state === 'string' && row.verified_state.trim()
        ? { verified_state: row.verified_state.trim() }
        : {}),
    });
  });
  return { rows: [...byEmail.values()], rejected, source_ref };
}
