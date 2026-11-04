import { readScreenReadyRecords } from '../../screen-ready-records/read-data/read-screen-ready-records';

export type PublishedRecord = unknown;

export type MediaSourceRecord = {
  // A source whose content IS text (a written lesson, a chapter) carries it here.
  body_text?: string;
  delivery_kind?: string;
  delivery_target_ref?: string;
  delivery_ttl_seconds?: number;
  content_ref?: string;
  duration_label?: string;
  delivery_url?: string;
  embed_control?: MediaEmbedControl;
  embed_control_ref?: string;
  embed_url?: string;
  external_id?: string;
  file_name?: string;
  id: string;
  label?: string;
  mime_type?: string;
  object_key?: string;
  object_store_ref?: string;
  playback_url?: string;
  poster_url?: string;
  provider_ref?: string;
  source_url?: string;
  source_kind?: string;
  transcript_ref?: string;
};

export type EmbedControlQueryParam = {
  key: string;
  value?: string;
  value_from?: string;
};

export type MediaEmbedControl = {
  commands?: Record<string, unknown>;
  id: string;
  kind?: string;
  label?: string;
  query_params?: EmbedControlQueryParam[];
  serialize?: string;
  target_origin?: string;
};

export type MediaPlaybackSession = {
  id: string;
  media_ref: string;
  position_ms?: number;
  status?: string;
};

export type MediaPlaybackData = {
  sessions: MediaPlaybackSession[];
  sources: MediaSourceRecord[];
};

export type MediaPlaybackSource = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function embedControlQueryParams(value: unknown): EmbedControlQueryParam[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const params = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const key = readString(item.key);
    if (!key) return [];
    return [{
      key,
      value: readString(item.value),
      value_from: readString(item.value_from),
    }];
  });
  return params.length > 0 ? params : undefined;
}

function readEmbedControl(value: unknown): MediaEmbedControl | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  if (!id) return undefined;
  return {
    commands: stringRecord(value.commands),
    id,
    kind: readString(value.kind),
    label: readString(value.label),
    query_params: embedControlQueryParams(value.query_params),
    serialize: readString(value.serialize),
    target_origin: readString(value.target_origin),
  };
}

export function readMediaSource(value: unknown): MediaSourceRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  if (!id) return undefined;
  return {
    body_text: readString(value.body_text),
    content_ref: readString(value.content_ref),
    delivery_kind: readString(value.delivery_kind),
    delivery_target_ref: readString(value.delivery_target_ref),
    delivery_ttl_seconds: readNumber(value.delivery_ttl_seconds),
    delivery_url: readString(value.delivery_url),
    duration_label: readString(value.duration_label),
    embed_control: readEmbedControl(value.embed_control),
    embed_control_ref: readString(value.embed_control_ref),
    embed_url: readString(value.embed_url),
    external_id: readString(value.external_id),
    file_name: readString(value.file_name),
    id,
    label: readString(value.label),
    mime_type: readString(value.mime_type),
    object_key: readString(value.object_key),
    object_store_ref: readString(value.object_store_ref),
    playback_url: readString(value.playback_url),
    poster_url: readString(value.poster_url),
    provider_ref: readString(value.provider_ref),
    source_url: readString(value.source_url),
    source_kind: readString(value.source_kind),
    transcript_ref: readString(value.transcript_ref),
  };
}

function materialSources(value: unknown): MediaSourceRecord[] {
  if (!isRecord(value)) return [];
  const own = Array.isArray(value.material_sources)
    ? value.material_sources.flatMap((item) => {
      const source = readMediaSource(item);
      return source ? [source] : [];
    })
    : [];
  const children = Array.isArray(value.child_content)
    ? value.child_content.flatMap(materialSources)
    : [];
  return [...own, ...children];
}

function readSession(value: unknown, fallbackId: string): MediaPlaybackSession | undefined {
  if (!isRecord(value)) return undefined;
  const mediaRef = readString(value.media_ref);
  if (!mediaRef) return undefined;
  return {
    id: readString(value.id) ?? fallbackId,
    media_ref: mediaRef,
    position_ms: readNumber(value.position_ms),
    status: readString(value.status),
  };
}

export function readMediaPlaybackData(source: MediaPlaybackSource): MediaPlaybackData {
  const rows = readScreenReadyRecords(source);
  const sourceMap = new Map<string, MediaSourceRecord>();

  for (const row of rows.records) {
    for (const material of materialSources(row.payload)) {
      sourceMap.set(material.id, material);
    }
  }

  for (const row of rows.recordsByRole['material-source'] ?? []) {
    const material = readMediaSource(row.payload);
    if (material) sourceMap.set(material.id, material);
  }

  const sessions = (rows.recordsByRole['playback-session'] ?? []).flatMap((row) => {
    const session = readSession(row.payload, row.record_ref ?? row.id);
    return session ? [session] : [];
  });

  return {
    sessions,
    sources: [...sourceMap.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function findMediaSource(
  source: MediaPlaybackSource,
  id: string,
): MediaSourceRecord | undefined {
  return readMediaPlaybackData(source).sources.find((mediaSource) => mediaSource.id === id);
}
