import {
  evidencePayloads,
  readEvidenceProjection,
  type EvidenceBlocker,
  type EvidenceProjection,
  type EvidenceProjectionRow,
} from '@/packages/content-media-evidence/read-data/content-media-evidence';
import {
  KIND_ITEM_LABEL_DESCRIPTORS,
  KIND_LABEL_DESCRIPTORS,
  ROLE_LABEL_DESCRIPTORS,
  labelLookup,
} from './media-composition-descriptors';

export type MediaWorkspaceArtifactRef = {
  multihash?: string;
  cas_address?: string;
  media_type?: string;
  byte_length?: number;
  stored_bytes_address_label?: string;
};

export type MediaWorkspaceSource = {
  source_id: string;
  label: string;
  media_type: string;
  role: string;
  source_package: string;
  source_ref: Record<string, unknown>;
  artifact_ref?: MediaWorkspaceArtifactRef;
};

export type MediaWorkspaceTimelineItem = {
  item_id: string;
  label: string;
  detail: string;
  start?: number;
  end?: number;
  record_kind?: string;
  source_package?: string;
  role?: string;
  payload: Record<string, unknown>;
};

export type MediaWorkspaceLane = {
  lane_id: string;
  label: string;
  source_package: string;
  role: string;
  items: MediaWorkspaceTimelineItem[];
};

export type MediaWorkspaceDetailGroup = {
  group_id: string;
  label: string;
  source_package?: string;
  role?: string;
  record_kind?: string;
  count: number;
  items: MediaWorkspaceTimelineItem[];
};

export type MediaWorkspacePanel = {
  panel_id: string;
  label: string;
  lane_id: string;
  count: number;
  items: MediaWorkspaceTimelineItem[];
  source_package?: string;
  role?: string;
  record_kind?: string;
};

export type MediaCompositionEditDecision = {
  kind?: string;
  decision_id?: string;
  action?: string;
  label?: string;
  source_ref?: Record<string, unknown>;
  span?: { start?: number; end?: number };
  parameters?: Record<string, unknown>;
  created_at?: string;
};

export type MediaCompositionMarker = {
  kind?: string;
  marker_id?: string;
  label?: string;
  source_ref?: Record<string, unknown>;
  time?: number;
  span?: { start?: number; end?: number };
  created_at?: string;
};

export type MediaCompositionSelection = {
  kind?: string;
  selection_id?: string;
  source_ref?: Record<string, unknown>;
  selected_source_ref?: Record<string, unknown>;
  source_span_refs?: unknown[];
  created_at?: string;
};

export type MediaWorkspaceView = {
  blockers: EvidenceBlocker[];
  sources: MediaWorkspaceSource[];
  lanes: MediaWorkspaceLane[];
  panels: MediaWorkspacePanel[];
  detailGroups: MediaWorkspaceDetailGroup[];
  selections: MediaCompositionSelection[];
  selectedSourceId?: string;
  editDecisions: MediaCompositionEditDecision[];
  markers: MediaCompositionMarker[];
};

type SourceCandidate = {
  value: Record<string, unknown>;
  sourcePackage: string;
  fallbackRole: string;
  fallbackLabel: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function titleCase(value: string): string {
  const cleaned = value.replace(/[-_:.]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const ROLE_LABELS = labelLookup(ROLE_LABEL_DESCRIPTORS);
const KIND_LABELS = labelLookup(KIND_LABEL_DESCRIPTORS);
const KIND_ITEM_LABELS = labelLookup(KIND_ITEM_LABEL_DESCRIPTORS);

function textFrom(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = asText(record[key]);
    if (value) return value;
  }
  return null;
}

function numberFrom(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function recordKindFrom(record: Record<string, unknown>): string | null {
  return textFrom(record, ['record_kind', 'kind', 'type']);
}

function displayKindLabel(kind: string): string {
  const exact = KIND_LABELS.get(kind);
  if (exact) return exact;
  const family = kind.includes('.')
    ? kind.slice(kind.lastIndexOf('.') + 1)
    : kind;
  return titleCase(family) || titleCase(kind) || kind;
}

function displayKindItemLabel(kind: string): string {
  const exact = KIND_ITEM_LABELS.get(kind);
  if (exact) return exact;
  return displayKindLabel(kind);
}

function displayRoleLabel(role: string): string {
  return ROLE_LABELS.get(role) ?? titleCase(role) ?? role;
}

function artifactRefFrom(value: unknown): MediaWorkspaceArtifactRef | undefined {
  if (!isRecord(value)) return undefined;
  const ref: MediaWorkspaceArtifactRef = {
    multihash: asText(value.multihash) ?? undefined,
    cas_address: asText(value.cas_address) ?? undefined,
    media_type: asText(value.media_type) ?? undefined,
    byte_length: asNumber(value.byte_length),
    stored_bytes_address_label: asText(value.stored_bytes_address_label) ?? undefined,
  };
  return ref.multihash || ref.cas_address || ref.stored_bytes_address_label ? ref : undefined;
}

export function mediaWorkspaceSourceIdForRef(sourceRef: Record<string, unknown>): string {
  const artifact = artifactRefFrom(sourceRef.artifact_ref);
  return textFrom(sourceRef, ['source_id', 'id'])
    ?? artifact?.multihash
    ?? artifact?.cas_address
    ?? textFrom(sourceRef, ['display_name', 'label', 'name'])
    ?? 'source';
}

function sourceFromCandidate(candidate: SourceCandidate): MediaWorkspaceSource | null {
  const artifact = artifactRefFrom(candidate.value.artifact_ref);
  const mediaType = textFrom(candidate.value, ['media_type', 'content_type']) ?? artifact?.media_type ?? 'media';
  const sourceRef = candidate.value;
  const label = textFrom(candidate.value, ['display_name', 'label', 'name', 'title'])
    ?? candidate.fallbackLabel
    ?? mediaType;
  return {
    source_id: mediaWorkspaceSourceIdForRef(sourceRef),
    label,
    media_type: mediaType,
    role: textFrom(candidate.value, ['role']) ?? candidate.fallbackRole,
    source_package: candidate.sourcePackage,
    source_ref: sourceRef,
    artifact_ref: artifact,
  };
}

function mergeSource(existing: MediaWorkspaceSource | undefined, incoming: MediaWorkspaceSource): MediaWorkspaceSource {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    label: existing.label || incoming.label,
    media_type: existing.media_type || incoming.media_type,
    role: existing.role !== 'source' ? existing.role : incoming.role,
    source_package: existing.source_package !== 'unknown' ? existing.source_package : incoming.source_package,
    source_ref: Object.keys(existing.source_ref).length > 0 ? existing.source_ref : incoming.source_ref,
    artifact_ref: existing.artifact_ref ?? incoming.artifact_ref,
  };
}

function projectionRows(projection: EvidenceProjection): EvidenceProjectionRow[] {
  return Object.values(projection.rowsByRole).flat();
}

function sourcePackageFromRow(row: EvidenceProjectionRow, payload: Record<string, unknown>): string {
  return asText(row.source_package)
    ?? asText(payload.source_package)
    ?? asText(payload.sourcePackage)
    ?? asText(payload.package)
    ?? 'unknown';
}

function recordsForRole(projection: EvidenceProjection, role: string): EvidenceProjectionRow[] {
  return projection.rowsByRole[role] ?? [];
}

function sourceCandidatesFromRow(row: EvidenceProjectionRow): SourceCandidate[] {
  const payload = isRecord(row.payload) ? row.payload : null;
  if (!payload) return [];
  const sourcePackage = sourcePackageFromRow(row, payload);
  const fallbackRole = row.role ?? textFrom(payload, ['role']) ?? 'source';
  const fallbackLabel = textFrom(payload, ['display_name', 'label', 'title', 'name'])
    ?? textFrom(payload, ['request_id', 'recorded_file_id', 'decision_id', 'plan_id', 'manifest_id', 'handoff_id', 'selection_id', 'marker_id'])
    ?? fallbackRole;
  const candidates: SourceCandidate[] = [];

  if (isRecord(payload.source)) {
    candidates.push({ value: payload.source, sourcePackage, fallbackRole, fallbackLabel });
  }
  if (isRecord(payload.source_ref)) {
    candidates.push({ value: payload.source_ref, sourcePackage, fallbackRole, fallbackLabel });
  }
  if (Array.isArray(payload.source_refs)) {
    payload.source_refs.forEach((source, index) => {
      if (isRecord(source)) {
        candidates.push({
          value: source,
          sourcePackage,
          fallbackRole,
          fallbackLabel: `${fallbackLabel} ${index + 1}`,
        });
      }
    });
  }
  if (isRecord(payload.artifact_ref)) {
    candidates.push({
      value: {
        role: fallbackRole,
        display_name: fallbackLabel,
        media_type: payload.media_type,
        artifact_ref: payload.artifact_ref,
      },
      sourcePackage,
      fallbackRole,
      fallbackLabel,
    });
  }
  if (Array.isArray(payload.sources)) {
    payload.sources.forEach((source, index) => {
      if (isRecord(source)) {
        candidates.push({
          value: source,
          sourcePackage,
          fallbackRole,
          fallbackLabel: `${fallbackLabel} ${index + 1}`,
        });
      }
    });
  }

  return candidates;
}

function readSources(projection: EvidenceProjection): MediaWorkspaceSource[] {
  const sources = new Map<string, MediaWorkspaceSource>();
  for (const row of projectionRows(projection)) {
    for (const candidate of sourceCandidatesFromRow(row)) {
      const source = sourceFromCandidate(candidate);
      if (!source) continue;
      sources.set(source.source_id, mergeSource(sources.get(source.source_id), source));
    }
  }
  return [...sources.values()];
}

function roleOrder(projection: EvidenceProjection): string[] {
  const configured = projection.config?.projection_lanes ?? [];
  const discovered = Object.keys(projection.rowsByRole).filter((role) => role !== 'config');
  return [...new Set([...configured, ...discovered])];
}

function firstSourcePackageForRows(rows: EvidenceProjectionRow[]): string {
  for (const row of rows) {
    const payload = isRecord(row.payload) ? row.payload : null;
    if (!payload) continue;
    const sourcePackage = sourcePackageFromRow(row, payload);
    if (sourcePackage !== 'unknown') return sourcePackage;
  }
  return 'unknown';
}

function rangeDetail(payload: Record<string, unknown>): string {
  const directRange = isRecord(payload.time_range) ? payload.time_range : payload;
  const start = numberFrom(directRange, ['start', 'start_time', 'time']);
  const end = numberFrom(directRange, ['end', 'end_time']);
  if (start === undefined) return '';
  return end === undefined || end === start ? `${start}s` : `${start}s to ${end}s`;
}

function plainValue(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  if (isRecord(value)) {
    return Object.entries(value)
      .filter(([, item]) => item != null && item !== '')
      .slice(0, 2)
      .map(([key, item]) => `${key.replace(/[-_]/g, ' ')} ${plainValue(item)}`)
      .join(', ');
  }
  return String(value);
}

/** Raw MIME strings never reach the screen — translate to a media-kind word. */
function humanMediaKind(mediaType: string | null): string | null {
  if (!mediaType) return null;
  const family = mediaType.split('/')[0]?.toLowerCase();
  if (family === 'audio') return 'Audio';
  if (family === 'video') return 'Video';
  if (family === 'image') return 'Image';
  return 'Media';
}

function timelineItem(
  row: EvidenceProjectionRow,
  fallbackLabel: string,
  fallbackId: string,
): MediaWorkspaceTimelineItem {
  const payload = isRecord(row.payload) ? row.payload : {};
  const recordKind = recordKindFrom(payload);
  const role = row.role ?? textFrom(payload, ['role']) ?? undefined;
  const sourcePackage = sourcePackageFromRow(row, payload);
  const label = textFrom(payload, [
    'label',
    'title',
    'name',
    'display_name',
    'claim_key',
    'claim_type',
    'profile_label',
    'action',
    'state',
    'status',
  ]) || (recordKind ? displayKindItemLabel(recordKind) : '') || fallbackLabel;
  const detail = rangeDetail(payload)
    || plainValue(payload.value)
    || plainValue(payload.summary)
    || plainValue(payload.evidence)
    || plainValue(payload.parameters)
    || plainValue(payload.details)
    || textFrom(payload, ['message', 'method'])
    || humanMediaKind(textFrom(payload, ['media_type']))
    || (recordKind ? displayKindItemLabel(recordKind) : '')
    || 'Saved';
  const range = isRecord(payload.time_range) ? payload.time_range : payload;
  return {
    item_id: textFrom(payload, [
      'item_id',
      'id',
      'chapter_id',
      'thumbnail_id',
      'claim_id',
      'request_id',
      'result_id',
      'phase_id',
      'alignment_id',
      'cluster_id',
      'match_id',
      'plan_id',
      'manifest_id',
      'handoff_id',
      'decision_id',
      'marker_id',
    ]) ?? fallbackId,
    label,
    detail,
    start: numberFrom(range, ['start', 'start_time', 'time']),
    end: numberFrom(range, ['end', 'end_time']),
    record_kind: recordKind ?? undefined,
    source_package: sourcePackage,
    role,
    payload,
  };
}

function lane(
  projection: EvidenceProjection,
  role: string,
): MediaWorkspaceLane {
  const rows = recordsForRole(projection, role);
  const items = rows.map((row, index) => timelineItem(row, displayRoleLabel(role), `${role}:${index}`));
  return {
    lane_id: role,
    label: displayRoleLabel(role),
    source_package: firstSourcePackageForRows(rows),
    role,
    items,
  };
}

function readLanes(projection: EvidenceProjection): MediaWorkspaceLane[] {
  return roleOrder(projection)
    .map((roleName) => lane(projection, roleName))
    .filter((item) => item.items.length > 0);
}

function detailGroups(projection: EvidenceProjection): MediaWorkspaceDetailGroup[] {
  const groups = new Map<string, MediaWorkspaceDetailGroup & { firstIndex: number }>();
  const rows = projectionRows(projection);
  rows.forEach((row, index) => {
    const payload = isRecord(row.payload) ? row.payload : null;
    if (!payload) return;
    const recordKind = recordKindFrom(payload);
    if (row.role === 'config' || recordKind === 'content-media.evidence-pipeline.config') return;
    const groupId = recordKind ?? row.role ?? sourcePackageFromRow(row, payload);
    const label = recordKind
      ? displayKindLabel(recordKind)
      : displayRoleLabel(row.role ?? sourcePackageFromRow(row, payload));
    const existing = groups.get(groupId);
    const item = timelineItem(row, label, `${groupId}:${index}`);
    if (existing) {
      existing.items.push(item);
      existing.count = existing.items.length;
      return;
    }
    groups.set(groupId, {
      group_id: groupId,
      label,
      source_package: item.source_package,
      role: row.role ?? item.role,
      record_kind: recordKind ?? undefined,
      count: 1,
      items: [item],
      firstIndex: index,
    });
  });
  return [...groups.values()]
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map(({ firstIndex: _firstIndex, ...group }) => group);
}

function readPanels(groups: MediaWorkspaceDetailGroup[]): MediaWorkspacePanel[] {
  return groups.map((group) => ({
    panel_id: group.group_id,
    label: group.label,
    lane_id: group.group_id,
    count: group.count,
    items: group.items,
    source_package: group.source_package,
    role: group.role,
    record_kind: group.record_kind,
  }));
}

function sourceRefFromSelection(selection: MediaCompositionSelection): Record<string, unknown> | null {
  if (isRecord(selection.selected_source_ref)) return selection.selected_source_ref;
  if (isRecord(selection.source_ref)) return selection.source_ref;

  const firstSpan = Array.isArray(selection.source_span_refs) ? selection.source_span_refs[0] : null;
  if (isRecord(firstSpan) && isRecord(firstSpan.source_ref)) return firstSpan.source_ref;

  return null;
}

function selectionTime(selection: MediaCompositionSelection): number {
  const time = selection.created_at ? Date.parse(selection.created_at) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function selectedSourceIdFromSelections(selections: readonly MediaCompositionSelection[]): string | undefined {
  const latest = [...selections].sort((left, right) => selectionTime(left) - selectionTime(right)).at(-1);
  const sourceRef = latest ? sourceRefFromSelection(latest) : null;
  return sourceRef ? mediaWorkspaceSourceIdForRef(sourceRef) : undefined;
}

export function readMediaWorkspace(rows: unknown): MediaWorkspaceView {
  const projection = readEvidenceProjection(rows, 'media-composition');
  const lanes = readLanes(projection);
  const details = detailGroups(projection);
  const selections = evidencePayloads<MediaCompositionSelection>(projection, 'selections');
  return {
    blockers: projection.blockers,
    sources: readSources(projection),
    lanes,
    panels: readPanels(details),
    detailGroups: details,
    selections,
    selectedSourceId: selectedSourceIdFromSelections(selections),
    editDecisions: evidencePayloads<MediaCompositionEditDecision>(projection, 'edit_decisions'),
    markers: evidencePayloads<MediaCompositionMarker>(projection, 'markers'),
  };
}
