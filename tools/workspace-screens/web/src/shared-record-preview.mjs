// A collection reads only compact preview fields already saved beside an admitted file.
// No original file, remote URL, frame strip or private result metadata is returned.
import { MAX_PREVIEW_COVER_BYTES, savedImageCover } from './share-image-cover.mjs';

export const SHARED_PREVIEW_BATCH_SIZE = 8;
const MAX_POSTER_JSON_BYTES = Math.ceil(MAX_PREVIEW_COVER_BYTES / 3) * 4 + 512;

export async function readSharedSavedPreview(body) {
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_POSTER_JSON_BYTES) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  const saved = {};
  if (savedImageCover(value)) saved.poster = value.poster;
  if (Array.isArray(value?.peaks) && value.peaks.length > 0 && value.peaks.length <= 1200
    && value.peaks.every(peak => typeof peak === 'number' && Number.isFinite(peak) && peak >= 0 && peak <= 1)) saved.peaks = value.peaks;
  if (typeof value?.lines === 'string' && value.lines.trim() && value.lines.length <= 4096) saved.lines = value.lines;
  return Object.keys(saved).length ? saved : null;
}

export function sharedPreviewItems(value) {
  if (!Array.isArray(value) || value.length > SHARED_PREVIEW_BATCH_SIZE || value.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 200)) throw new Error(`Choose up to ${SHARED_PREVIEW_BATCH_SIZE} visible records.`);
  return [...new Set(value)];
}
