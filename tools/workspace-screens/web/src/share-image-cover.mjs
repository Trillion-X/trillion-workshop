// A collection card may fetch only a small original image. Larger originals use
// the compact preview already kept beside the file in the namespace.
export const MAX_ORIGINAL_COVER_BYTES = 256 * 1024;
export const MAX_PREVIEW_COVER_BYTES = 256 * 1024;

const RASTER_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
export const rasterImageTypeFor = (declared, name) => {
  const type = String(declared ?? '').split(';', 1)[0].trim().toLowerCase();
  if (RASTER_IMAGE_TYPES.has(type)) return type;
  if (type && type !== 'application/octet-stream') return null;
  const extension = String(name ?? '').match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' })[extension] ?? null;
};

export const TRANSPARENT_COVER = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zkq0AAAAASUVORK5CYII='),
  char => char.charCodeAt(0),
);

// MadePreview stores a data URL, not another namespace file. Keep the route's
// decoded answer bounded even if an older preview result was unusually large.
export function savedImageCover(value) {
  const poster = value?.poster;
  if (typeof poster !== 'string' || poster.length > Math.ceil(MAX_PREVIEW_COVER_BYTES / 3) * 4 + 64) return null;
  const found = /^data:(image\/(?:jpeg|png|webp|gif|avif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(poster);
  if (!found) return null;
  try {
    const binary = atob(found[2]);
    if (!binary.length || binary.length > MAX_PREVIEW_COVER_BYTES) return null;
    return { type: found[1], bytes: Uint8Array.from(binary, char => char.charCodeAt(0)) };
  } catch { return null; }
}
