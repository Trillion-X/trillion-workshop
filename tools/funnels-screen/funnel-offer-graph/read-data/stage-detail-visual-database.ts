import {
  decodeVisualDatabaseModel,
  type VisualDatabaseModel,
} from '@/packages/visual-database/read-data/visual-database';

export interface FunnelStageDetailVisualDatabaseProjection {
  model: VisualDatabaseModel;
  initialViewId?: string;
}

type FunnelStageDetailVisualDatabaseDescriptor = {
  id: string;
  fields: unknown;
  views: unknown;
  actions?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readDescriptor(
  raw: unknown,
): FunnelStageDetailVisualDatabaseDescriptor | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw.id);
  if (!id) return null;
  return isRecord(raw.fields) && isRecord(raw.views)
    ? {
        id,
        fields: raw.fields,
        views: raw.views,
        ...(raw.actions !== undefined ? { actions: raw.actions } : {}),
      }
    : null;
}

function readInitialViewId(
  views: unknown,
  fallbackId: string,
): string {
  if (!isRecord(views) || !Array.isArray(views.views)) return fallbackId;
  const match = views.views.find((entry) => isRecord(entry) && readString(entry.id));
  return match && isRecord(match) && readString(match.id) ? readString(match.id)! : fallbackId;
}

export function buildFunnelStageDetailVisualDatabaseProjection(
  descriptorRaw: unknown,
  detailRecords: readonly unknown[],
): FunnelStageDetailVisualDatabaseProjection | null {
  const descriptor = readDescriptor(descriptorRaw);
  if (!descriptor) return null;
  return {
    model: decodeVisualDatabaseModel({
      records: detailRecords,
      fields: descriptor.fields,
      views: descriptor.views,
      actions: descriptor.actions ?? { actions: [] },
    }),
    initialViewId: readInitialViewId(descriptor.views, descriptor.id),
  };
}
