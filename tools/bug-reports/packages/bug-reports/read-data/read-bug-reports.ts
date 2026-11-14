// packages/bug-reports/read-data/read-bug-reports.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure decoder for the owner-published bug-reports feed.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Decodes only the package-configured projected bug-report rows
// 2. Canonical owner data is projected before this package receives it
// 3. No browser store, merged-project helper, direct connection, or query access
//
// =============================================================================

export interface BugReportEntry {
  id: string;
  title: string;
  description: string;
  stepsToReproduce: string;
  severity: string;
  reportedAt: string;
}

interface BugReportRow {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  stepsToReproduce?: unknown;
  severity?: unknown;
  reportedAt?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function decodeBugReportsFeed(raw: unknown): BugReportEntry[] {
  if (!Array.isArray(raw)) return [];

  const reports: BugReportEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as BugReportRow;
    const id = asString(row.id);
    if (!id) continue;

    reports.push({
      id,
      title: asString(row.title),
      description: asString(row.description),
      stepsToReproduce: asString(row.stepsToReproduce),
      severity: asString(row.severity) || 'untriaged',
      reportedAt: asString(row.reportedAt),
    });
  }

  return reports.sort((a, b) => b.reportedAt.localeCompare(a.reportedAt));
}
