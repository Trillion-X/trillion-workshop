// packages/bug-reports/read-data/read-investigations.ts
//
// Bug-reports-local decoder for investigation summary records.

export interface BugReportInvestigationEntry {
  id: string;
  date: string;
  slug: string;
  dirName: string;
  roundCount: number;
}

interface FactRow {
  subject_id?: unknown;
  property_id?: unknown;
  value?: unknown;
}

interface MutableInvestigation {
  subjectId: string;
  title: string;
  rounds: number;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function deriveDate(value: string): string {
  return value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
}

function deriveId(value: string): string {
  return value.match(/\d{3,}/)?.[0] ?? value.replace(/^[^:]+:/, '');
}

function toInvestigationEntry(record: MutableInvestigation): BugReportInvestigationEntry {
  const title = record.title || record.subjectId;
  const id = deriveId(record.subjectId) || deriveId(title) || record.subjectId;
  const date = deriveDate(record.subjectId) || deriveDate(title);
  const slug = slugify(title) || slugify(record.subjectId) || id;
  const dirName = date ? `${id}-${date}-${slug}` : record.subjectId;

  return {
    id,
    date,
    slug,
    dirName,
    roundCount: record.rounds,
  };
}

export function decodeBugReportInvestigationsFeed(raw: unknown): BugReportInvestigationEntry[] {
  if (!Array.isArray(raw)) return [];

  const records = new Map<string, MutableInvestigation>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as FactRow;
    const subjectId = asString(row.subject_id);
    const propertyId = asString(row.property_id);
    if (!subjectId || !propertyId) continue;

    const current = records.get(subjectId) ?? {
      subjectId,
      title: '',
      rounds: 0,
    };

    if (propertyId === 'prop:investigation:title') {
      current.title = asString(row.value);
    } else if (propertyId === 'prop:investigation:rounds') {
      current.rounds = asNumber(row.value);
    }

    records.set(subjectId, current);
  }

  return Array.from(records.values()).map(toInvestigationEntry);
}
