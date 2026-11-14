import type { DescribedRecordSurface } from '../../../read-data/described-record-surface';

export type SectionKind =
  | 'identityHeader'
  | 'fieldGroup'
  | 'contributionShelf'
  | 'actionArea'
  | 'problemList'
  | 'empty';

export interface SurfaceSection {
  kind: SectionKind;
  id: string;
  data: unknown;
}

export interface PersonProfileSurfaceDescriptor {
  sections: SurfaceSection[];
}

export function describedRecordToSurfaceDescriptor(
  surface: DescribedRecordSurface,
): PersonProfileSurfaceDescriptor {
  const sections: SurfaceSection[] = [];
  sections.push({ kind: 'identityHeader', id: `${surface.surfaceId}:identity`, data: surface.identity });
  if (surface.fields.length > 0) sections.push({ kind: 'fieldGroup', id: `${surface.surfaceId}:fields`, data: surface.fields });
  for (const relationship of surface.relationships) {
    sections.push({ kind: 'contributionShelf', id: relationship.id, data: relationship });
  }
  if (surface.actions.length > 0) sections.push({ kind: 'actionArea', id: `${surface.surfaceId}:actions`, data: surface.actions });
  if (surface.diagnostics.problems.length > 0) {
    sections.push({ kind: 'problemList', id: `${surface.surfaceId}:problems`, data: surface.diagnostics.problems });
  }
  if (sections.length === 1) sections.push({ kind: 'empty', id: `${surface.surfaceId}:empty`, data: {} });
  return { sections };
}
