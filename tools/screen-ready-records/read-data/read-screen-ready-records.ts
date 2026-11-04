export type PublishedRecord = {
  payload?: unknown;
  [key: string]: unknown;
};

export type ScreenReadyBlocker = {
  code?: string;
  kind?: string;
  message?: string;
  owner?: string;
  severity?: string;
};

export type ScreenReadySection = {
  id: string;
  label?: string;
  screen_ref: string;
  sort_order?: number;
};

export type ScreenReadyRecordRow = {
  blocker?: ScreenReadyBlocker;
  id: string;
  payload?: unknown;
  record_ref?: string;
  role: string;
  screen_ref: string;
  section_ref: string;
  sort_order?: number;
  source_refs: string[];
};

export type ScreenReadyRecords = {
  blockers: ScreenReadyBlocker[];
  records: ScreenReadyRecordRow[];
  recordsByRole: Record<string, ScreenReadyRecordRow[]>;
  sections: ScreenReadySection[];
};

type RecordSource = unknown;

export type ScreenReadyReadOptions = {
  screen_ref?: string;
  section_ref?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => Boolean(text(item))) : [];
}

function recordValues(source: RecordSource): unknown[] {
  const valueOf = (record: unknown) => {
    if (!isRecord(record)) return record;
    if (record.kind === 'screen-ready-section' || record.kind === 'screen-ready-record' || record.kind === 'screen-ready-blocker') {
      return record;
    }
    return 'payload' in record ? record.payload : record;
  };

  if (Array.isArray(source)) {
    return source.map(valueOf);
  }
  if (isRecord(source) && Array.isArray(source.records)) {
    return source.records.map(valueOf);
  }
  return [];
}

function sortByOrderThenLabel<T extends { id: string; label?: string; sort_order?: number; role?: string }>(left: T, right: T) {
  return (left.sort_order ?? 0) - (right.sort_order ?? 0)
    || String(left.label ?? left.role ?? left.id).localeCompare(String(right.label ?? right.role ?? right.id));
}

function matchesOptions(record: { screen_ref: string; section_ref?: string }, options: ScreenReadyReadOptions) {
  return (!options.screen_ref || record.screen_ref === options.screen_ref)
    && (!options.section_ref || record.section_ref === options.section_ref);
}

export function readScreenReadyRecords(source: RecordSource, options: ScreenReadyReadOptions = {}): ScreenReadyRecords {
  const sections: ScreenReadySection[] = [];
  const records: ScreenReadyRecordRow[] = [];
  const blockers: ScreenReadyBlocker[] = [];

  for (const value of recordValues(source)) {
    if (!isRecord(value)) continue;

    if (value.kind === 'screen-ready-section') {
      const id = text(value.id);
      const screenRef = text(value.screen_ref);
      if (!id || !screenRef) continue;
      const section = {
        id,
        label: text(value.label),
        screen_ref: screenRef,
        sort_order: number(value.sort_order),
      };
      if (matchesOptions(section, options)) sections.push(section);
      continue;
    }

    if (value.kind === 'screen-ready-record') {
      const id = text(value.id);
      const role = text(value.role);
      const screenRef = text(value.screen_ref);
      const sectionRef = text(value.section_ref);
      if (!id || !role || !screenRef || !sectionRef) continue;
      const row = {
        blocker: isRecord(value.blocker) ? value.blocker : undefined,
        id,
        payload: value.payload,
        record_ref: text(value.record_ref),
        role,
        screen_ref: screenRef,
        section_ref: sectionRef,
        sort_order: number(value.sort_order),
        source_refs: textList(value.source_refs),
      };
      if (matchesOptions(row, options)) records.push(row);
      if (isRecord(value.blocker)) blockers.push(value.blocker);
      continue;
    }

    if (value.kind === 'screen-ready-blocker') {
      blockers.push({
        code: text(value.code),
        kind: text(value.kind),
        message: text(value.message),
        owner: text(value.owner),
        severity: text(value.severity),
      });
    }
  }

  const recordsByRole: Record<string, ScreenReadyRecordRow[]> = {};
  for (const row of records.sort(sortByOrderThenLabel)) {
    recordsByRole[row.role] = [...(recordsByRole[row.role] ?? []), row];
  }

  return {
    blockers,
    records: records.sort(sortByOrderThenLabel),
    recordsByRole,
    sections: sections.sort(sortByOrderThenLabel),
  };
}

export function readScreenReadyPayloads<T>(source: RecordSource, role: string, options: ScreenReadyReadOptions = {}): T[] {
  return (readScreenReadyRecords(source, options).recordsByRole[role] ?? [])
    .map((row) => row.payload)
    .filter((payload): payload is T => isRecord(payload));
}

export function screenReadyBlockerText(blocker: ScreenReadyBlocker): string {
  return blocker.message ?? blocker.code ?? 'screen-ready record blocker';
}
