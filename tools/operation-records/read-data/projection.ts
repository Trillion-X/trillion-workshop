// package-set://bitfield-studio/packages/operation-records/read-data/projection.ts

import { list, numberOr, record, text, textList } from './operation-records.ts';
import type { OperationDescriptor, OperationMode, OperationRecord } from './operation-records.ts';

export interface OperationLensMatch {
  all?: OperationLensMatch[];
  any?: OperationLensMatch[];
  not?: OperationLensMatch;
  modeHintsAny?: string[];
  priorityAny?: OperationRecord['priority'][];
  ownerPackageAny?: string[];
  linkRefPrefixAny?: string[];
  stateDescriptorIncludesAny?: string[];
  hasTransitions?: boolean;
  hasTimeWindow?: boolean;
  hasCandidateFacts?: boolean;
  excludeDone?: boolean;
}

export interface OperationLensDescriptor {
  id: OperationMode;
  label: string;
  sortRank: number;
  match: OperationLensMatch;
}

export interface OperationProjectionConfig {
  donePriorities: OperationRecord['priority'][];
  doneStateDescriptorIncludes: string[];
}

export interface OperationModeProjection {
  mode: OperationMode;
  lens: OperationLensDescriptor;
  focus: OperationRecord | null;
  queue: OperationRecord[];
}

export interface OperationProjection {
  focus: OperationRecord | null;
  queue: OperationRecord[];
  lenses: OperationModeProjection[];
  modes: Record<string, OperationModeProjection>;
  recordsById: Map<string, OperationRecord>;
  descriptorsById: Map<string, OperationDescriptor>;
}

export const DEFAULT_OPERATION_PROJECTION_CONFIG: OperationProjectionConfig = {
  donePriorities: ['done'],
  doneStateDescriptorIncludes: [],
};

function descriptorSlotRank(
  record: OperationRecord,
  descriptorsById: ReadonlyMap<string, OperationDescriptor>,
  slot: 'priorityDescriptor' | 'stateDescriptor' | 'kindDescriptor',
): number {
  return descriptorsById.get(record[slot])?.sortRank ?? 500;
}

function compareOperation(a: OperationRecord, b: OperationRecord, descriptorsById: ReadonlyMap<string, OperationDescriptor>): number {
  return descriptorSlotRank(a, descriptorsById, 'priorityDescriptor') - descriptorSlotRank(b, descriptorsById, 'priorityDescriptor')
    || descriptorSlotRank(a, descriptorsById, 'stateDescriptor') - descriptorSlotRank(b, descriptorsById, 'stateDescriptor')
    || descriptorSlotRank(a, descriptorsById, 'kindDescriptor') - descriptorSlotRank(b, descriptorsById, 'kindDescriptor')
    || a.sortKey.localeCompare(b.sortKey)
    || (a.timeWindow?.startsAt ?? a.timeWindow?.localDate ?? '').localeCompare(b.timeWindow?.startsAt ?? b.timeWindow?.localDate ?? '')
    || a.id.localeCompare(b.id);
}

function isDone(record: OperationRecord, config: OperationProjectionConfig): boolean {
  return config.donePriorities.includes(record.priority)
    || config.doneStateDescriptorIncludes.some((token) => record.stateDescriptor.includes(token));
}

function hasAny<T>(values: readonly T[], allowed?: readonly T[]): boolean {
  return !allowed || allowed.length === 0 || values.some((value) => allowed.includes(value));
}

function recordLensHints(record: OperationRecord, descriptorsById: ReadonlyMap<string, OperationDescriptor>): OperationMode[] {
  return Array.from(new Set([
    ...record.modeHints,
    ...(descriptorsById.get(record.kindDescriptor)?.defaultModes ?? []),
    ...(descriptorsById.get(record.stateDescriptor)?.defaultModes ?? []),
    ...(descriptorsById.get(record.priorityDescriptor)?.defaultModes ?? []),
  ]));
}

function matchLens(
  record: OperationRecord,
  match: OperationLensMatch,
  config: OperationProjectionConfig,
  descriptorsById: ReadonlyMap<string, OperationDescriptor>,
): boolean {
  if (match.all && !match.all.every((entry) => matchLens(record, entry, config, descriptorsById))) return false;
  if (match.any && !match.any.some((entry) => matchLens(record, entry, config, descriptorsById))) return false;
  if (match.not && matchLens(record, match.not, config, descriptorsById)) return false;
  if (match.excludeDone && isDone(record, config)) return false;
  if (match.modeHintsAny && !hasAny(recordLensHints(record, descriptorsById), match.modeHintsAny)) return false;
  if (match.priorityAny && !match.priorityAny.includes(record.priority)) return false;
  if (match.ownerPackageAny && !match.ownerPackageAny.includes(record.ownerPackage)) return false;
  if (match.linkRefPrefixAny && !record.linkRefs.some((ref) => match.linkRefPrefixAny?.some((prefix) => ref.startsWith(prefix)))) return false;
  if (match.stateDescriptorIncludesAny && !match.stateDescriptorIncludesAny.some((token) => record.stateDescriptor.includes(token))) return false;
  if (typeof match.hasTransitions === 'boolean' && (record.transitions.length > 0) !== match.hasTransitions) return false;
  if (typeof match.hasTimeWindow === 'boolean' && Boolean(record.timeWindow) !== match.hasTimeWindow) return false;
  if (typeof match.hasCandidateFacts === 'boolean' && (record.candidateFactRefs.length > 0) !== match.hasCandidateFacts) return false;
  return true;
}

function labelFromId(id: string): string {
  const parts = id.split(/[._:-]/g).filter(Boolean);
  const last = parts.length > 0 ? parts[parts.length - 1] : id;
  return last.replace(/[-_]/g, ' ') || id;
}

function operationLens(id: OperationMode, label = labelFromId(id), sortRank = 500): OperationLensDescriptor {
  return { id, label, sortRank, match: { modeHintsAny: [id] } };
}

function operationLenses(
  records: readonly OperationRecord[],
  lenses: readonly OperationLensDescriptor[],
  descriptorsById: ReadonlyMap<string, OperationDescriptor>,
): OperationLensDescriptor[] {
  const byId = new Map<string, OperationLensDescriptor>();
  for (const lens of lenses) byId.set(lens.id, lens);
  for (const id of new Set(records.flatMap((record) => recordLensHints(record, descriptorsById)))) {
    if (!byId.has(id)) byId.set(id, operationLens(id));
  }
  return [...byId.values()].sort((a, b) => a.sortRank - b.sortRank || a.id.localeCompare(b.id));
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function decodeOperationLensMatch(raw: unknown): OperationLensMatch {
  const row = record(raw);
  return {
    ...(list(row.all).length > 0 ? { all: list(row.all).map(decodeOperationLensMatch) } : {}),
    ...(list(row.any).length > 0 ? { any: list(row.any).map(decodeOperationLensMatch) } : {}),
    ...(Object.keys(record(row.not)).length > 0 ? { not: decodeOperationLensMatch(row.not) } : {}),
    ...(textList(row.modeHintsAny ?? row.mode_hints_any).length > 0 ? { modeHintsAny: textList(row.modeHintsAny ?? row.mode_hints_any) } : {}),
    ...(textList(row.priorityAny ?? row.priority_any).length > 0 ? { priorityAny: textList(row.priorityAny ?? row.priority_any) } : {}),
    ...(textList(row.ownerPackageAny ?? row.owner_package_any).length > 0 ? { ownerPackageAny: textList(row.ownerPackageAny ?? row.owner_package_any) } : {}),
    ...(textList(row.linkRefPrefixAny ?? row.link_ref_prefix_any).length > 0 ? { linkRefPrefixAny: textList(row.linkRefPrefixAny ?? row.link_ref_prefix_any) } : {}),
    ...(textList(row.stateDescriptorIncludesAny ?? row.state_descriptor_includes_any).length > 0 ? { stateDescriptorIncludesAny: textList(row.stateDescriptorIncludesAny ?? row.state_descriptor_includes_any) } : {}),
    ...(typeof bool(row.hasTransitions ?? row.has_transitions) === 'boolean' ? { hasTransitions: bool(row.hasTransitions ?? row.has_transitions) } : {}),
    ...(typeof bool(row.hasTimeWindow ?? row.has_time_window) === 'boolean' ? { hasTimeWindow: bool(row.hasTimeWindow ?? row.has_time_window) } : {}),
    ...(typeof bool(row.hasCandidateFacts ?? row.has_candidate_facts) === 'boolean' ? { hasCandidateFacts: bool(row.hasCandidateFacts ?? row.has_candidate_facts) } : {}),
    ...(typeof bool(row.excludeDone ?? row.exclude_done) === 'boolean' ? { excludeDone: bool(row.excludeDone ?? row.exclude_done) } : {}),
  };
}

export function decodeOperationLensDescriptor(raw: unknown): OperationLensDescriptor | null {
  const row = record(raw);
  const id = text(row.id);
  if (!id) return null;
  const match = decodeOperationLensMatch(row.match);
  return {
    id,
    label: text(row.label) || labelFromId(id),
    sortRank: numberOr(row.sortRank ?? row.sort_rank, 500),
    match: Object.keys(match).length > 0 ? match : { modeHintsAny: [id] },
  };
}

export function decodeOperationLensDescriptors(raw: unknown): OperationLensDescriptor[] {
  const row = record(raw);
  const source = Array.isArray(raw) ? raw : row.lenses;
  return list(source).map(decodeOperationLensDescriptor).filter((entry): entry is OperationLensDescriptor => entry !== null);
}

export function decodeOperationProjectionConfig(raw: unknown): OperationProjectionConfig {
  const row = record(raw);
  const donePriorities = textList(row.donePriorities ?? row.done_priorities);
  const doneStateDescriptorIncludes = textList(row.doneStateDescriptorIncludes ?? row.done_state_descriptor_includes);
  return {
    donePriorities: donePriorities.length > 0 ? donePriorities : DEFAULT_OPERATION_PROJECTION_CONFIG.donePriorities,
    doneStateDescriptorIncludes,
  };
}

export function projectMode(
  records: readonly OperationRecord[],
  mode: OperationMode,
  lenses: readonly OperationLensDescriptor[] = [],
  config: OperationProjectionConfig = DEFAULT_OPERATION_PROJECTION_CONFIG,
  descriptors: readonly OperationDescriptor[] = [],
): OperationModeProjection {
  const descriptorsById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const lens = operationLenses(records, lenses, descriptorsById).find((entry) => entry.id === mode) ?? operationLens(mode);
  const queue = records.filter((record) => matchLens(record, lens.match, config, descriptorsById));
  queue.sort((a, b) => compareOperation(a, b, descriptorsById));
  return { mode, lens, focus: queue[0] ?? null, queue };
}

export function buildOperationProjection(
  records: readonly OperationRecord[],
  descriptors: readonly OperationDescriptor[] = [],
  lenses: readonly OperationLensDescriptor[] = [],
  config: OperationProjectionConfig = DEFAULT_OPERATION_PROJECTION_CONFIG,
): OperationProjection {
  const descriptorsById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const sorted = [...records];
  sorted.sort((a, b) => compareOperation(a, b, descriptorsById));
  const queue = sorted.filter((record) => !isDone(record, config));
  const projectedLenses = operationLenses(sorted, lenses, descriptorsById).map((lens) => projectMode(sorted, lens.id, lenses, config, descriptors));
  const modes = projectedLenses.reduce<Record<string, OperationModeProjection>>((acc, projection) => {
    acc[projection.mode] = projection;
    return acc;
  }, {});
  return {
    focus: queue[0] ?? null,
    queue,
    lenses: projectedLenses,
    modes,
    recordsById: new Map(sorted.map((record) => [record.id, record])),
    descriptorsById,
  };
}
