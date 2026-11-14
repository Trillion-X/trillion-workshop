// src/container-facts.mjs
//
// PURPOSE
//   What a video, sound or picture file says about itself inside its own bytes: when it was captured, where (the GPS
//   position a phone or camera wrote), which camera, and, for a video, its length and picture size. Read from a
//   QuickTime/MP4 container (the movie header, Apple's location and creation-date keys, the ©xyz position Android and
//   many cameras write), WebM's actual sound/picture tracks, a JPEG's EXIF, or a HEIC photo's EXIF item. Only the few ranges that hold these are read, so a
//   2 GB clip whose index sits at its end costs a handful of small reads, never the file.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: bytes come only through the `read(offset, length)` it is handed, so the same reader runs in a browser
//      (ranges of the person's bytes address) and anywhere else that can read a range.
//   2. Nothing is guessed: a fact the file does not hold is left out; a zero or pre-1970 container time is no time.
//   3. Bounded: every walk stops after MAX_BOXES boxes or entries, and no single read is larger than MAX_READ, so a
//      broken or hostile file cannot make it loop or pull the whole file.
//
// Facts it can return (all optional): captured_at (ISO 8601; without a zone when the file names none, which reads as
// local time), location { latitude, longitude, altitude? }, camera, duration (seconds), resolution ("1920×1080"),
// media_tracks (the actual video/audio TrackType entries in a WebM container, independent of its supplied MIME type).

const CHUNK = 65536;
const MAX_READ = 1 << 20;
const MAX_BOXES = 4096;
const SECONDS_1904_TO_1970 = 2082844800;

/** A range reader that keeps what it read in 64 KiB pieces, so the many small header reads of one walk cost few
 *  requests. `read(offset, length)` answers a Uint8Array of at most `length` bytes from `offset`. */
export function chunkedReader(read, size) {
  const chunks = new Map();
  const chunk = index => {
    if (!chunks.has(index)) chunks.set(index, Promise.resolve(read(index * CHUNK, Math.min(CHUNK, size - index * CHUNK))));
    return chunks.get(index);
  };
  return async (offset, length) => {
    const end = Math.min(size, offset + Math.min(length, MAX_READ));
    if (offset < 0 || offset >= end) return new Uint8Array(0);
    const out = new Uint8Array(end - offset);
    for (let index = Math.floor(offset / CHUNK); index * CHUNK < end; index += 1) {
      const bytes = await chunk(index);
      const from = Math.max(offset, index * CHUNK), to = Math.min(end, index * CHUNK + bytes.length);
      if (to > from) out.set(bytes.subarray(from - index * CHUNK, to - index * CHUNK), from - offset);
    }
    return out;
  };
}

const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const text = bytes => new TextDecoder().decode(bytes).replace(/\0+$/, '').trim();
const fourcc = (bytes, at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
const u64 = (data, at) => data.getUint32(at) * 2 ** 32 + data.getUint32(at + 4);

// ---------------------------------------------------------------------------------------------------------------
// ISO base media (QuickTime, MP4, M4A, HEIC): boxes of {size, type, children}.

/** Every box directly inside [start, end): its type (as letters and as a number), where its content starts and
 *  where it ends. */
async function boxes(read, start, end) {
  const found = [];
  for (let at = start; at + 8 <= end && found.length < MAX_BOXES;) {
    const head = await read(at, 16);
    if (head.length < 8) break;
    const data = view(head);
    let size = data.getUint32(0), body = at + 8;
    if (size === 1 && head.length >= 16) { size = u64(data, 8); body = at + 16; } else if (size === 0) size = end - at;
    if (size < body - at || at + size > end) break;
    found.push({ type: fourcc(head, 4), code: data.getUint32(4), body, end: at + size });
    at += size;
  }
  return found;
}

const child = (list, type) => list.find(box => box.type === type);
const whole = (read, box) => read(box.body, box.end - box.body);

// A `meta` box is a full box (four bytes of version and flags first) in MP4 and HEIC, a plain one in QuickTime.
async function metaChildren(read, meta) {
  const peek = await read(meta.body, 12);
  const plain = peek.length >= 8 && fourcc(peek, 4) === 'hdlr';
  return boxes(read, meta.body + (plain ? 0 : 4), meta.end);
}

// Apple's metadata: `keys` names each entry, `ilst` holds each entry's value in a box whose type is the key's
// 1-based index.
async function appleKeys(read, meta) {
  const inside = await metaChildren(read, meta);
  const keysBox = child(inside, 'keys'), list = child(inside, 'ilst');
  if (!keysBox || !list) return {};
  const keys = await whole(read, keysBox), data = view(keys);
  const names = [];
  for (let at = 8, count = Math.min(data.getUint32(4), MAX_BOXES); count > 0 && at + 8 <= keys.length; count -= 1) {
    const size = data.getUint32(at);
    if (size < 8) break;
    names.push(text(keys.subarray(at + 8, at + size)));
    at += size;
  }
  const values = {};
  for (const item of await boxes(read, list.body, list.end)) {
    const value = child(await boxes(read, item.body, item.end), 'data');
    if (!names[item.code - 1] || !value) continue;
    const bytes = await whole(read, value);
    // Type 1 is UTF-8 text.
    if (bytes.length > 8 && view(bytes).getUint32(0) === 1) values[names[item.code - 1]] = text(bytes.subarray(8));
  }
  return values;
}

// A position written as ISO 6709 ("+38.7223-009.1393+012.000/").
function iso6709(value) {
  const match = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/.exec(String(value ?? '').trim());
  if (!match) return null;
  const latitude = Number(match[1]), longitude = Number(match[2]);
  if (!(Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) || (!latitude && !longitude)) return null;
  return { latitude, longitude, ...(match[3] ? { altitude: Number(match[3]) } : {}) };
}

// A container time: seconds since 1904 in UTC; zero (never set) and anything before 1970 are no time.
function containerTime(seconds) {
  const unix = seconds - SECONDS_1904_TO_1970;
  return seconds > 0 && unix > 0 ? new Date(unix * 1000).toISOString().replace('.000Z', 'Z') : null;
}

// Apple's creation date ("2026-09-03T14:22:10+0100") as ISO 8601 with a colon in its zone.
const appleDate = value => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{2}):?(\d{2})$/.exec(String(value ?? '').trim());
  if (match) return `${match[1]}${match[2]}:${match[3]}`;
  return value && Number.isFinite(Date.parse(value)) ? String(value).trim() : null;
};

const cameraOf = (make, model) => {
  const [a, b] = [make, model].map(value => String(value ?? '').trim());
  if (!a) return b || null;
  return !b ? a : b.toLowerCase().startsWith(a.toLowerCase()) ? b : `${a} ${b}`;
};

async function movieFacts(read, moov) {
  const facts = {};
  const inside = await boxes(read, moov.body, moov.end);
  const header = child(inside, 'mvhd');
  if (header) {
    const bytes = await read(header.body, 32), data = view(bytes);
    const v1 = bytes[0] === 1;
    const created = v1 ? u64(data, 4) : data.getUint32(4);
    const scale = data.getUint32(v1 ? 20 : 12), length = v1 ? u64(data, 24) : data.getUint32(16);
    const at = containerTime(created);
    if (at) facts.captured_at = at;
    if (scale > 0 && length > 0) facts.duration = Math.round(length / scale * 1000) / 1000;
  }
  for (const track of inside.filter(box => box.type === 'trak')) {
    const head = child(await boxes(read, track.body, track.end), 'tkhd');
    if (!head) continue;
    const bytes = await read(head.body, 96), data = view(bytes);
    const at = bytes[0] === 1 ? 88 : 76;
    if (bytes.length < at + 8) continue;
    const width = Math.round(data.getUint32(at) / 65536), height = Math.round(data.getUint32(at + 4) / 65536);
    if (width > 0 && height > 0) { facts.resolution = `${width}×${height}`; break; }
  }
  const metas = inside.filter(box => box.type === 'meta');
  const user = child(inside, 'udta');
  if (user) {
    const within = await boxes(read, user.body, user.end);
    metas.push(...within.filter(box => box.type === 'meta'));
    // ©xyz: two bytes of length and two of language, then the ISO 6709 text.
    const xyz = within.find(box => box.code === 0xa978797a);
    if (xyz) { const place = iso6709(text((await whole(read, xyz)).subarray(4))); if (place) facts.location = place; }
  }
  for (const meta of metas) {
    const keys = await appleKeys(read, meta);
    const place = iso6709(keys['com.apple.quicktime.location.ISO6709']);
    if (place) facts.location = place;
    const created = appleDate(keys['com.apple.quicktime.creationdate']);
    if (created) facts.captured_at = created;
    const camera = cameraOf(keys['com.apple.quicktime.make'], keys['com.apple.quicktime.model']);
    if (camera) facts.camera = camera;
  }
  return facts;
}

// A HEIC or AVIF photo: its EXIF is an item the top-level `meta` places somewhere in the file (iinf names it, iloc
// says where its bytes are).
async function photoItemExif(read, meta) {
  const inside = await metaChildren(read, meta);
  const info = child(inside, 'iinf'), where = child(inside, 'iloc');
  if (!info || !where) return null;
  const infoHead = await read(info.body, 1);
  let exifId = null;
  for (const entry of await boxes(read, info.body + (infoHead[0] === 0 ? 6 : 8), info.end)) {
    if (entry.type !== 'infe') continue;
    const bytes = await read(entry.body, 16), data = view(bytes);
    const v3 = bytes[0] >= 3;
    if (bytes[0] >= 2 && fourcc(bytes, v3 ? 10 : 8) === 'Exif') { exifId = v3 ? data.getUint32(4) : data.getUint16(4); break; }
  }
  if (exifId === null) return null;
  const bytes = await whole(read, where), data = view(bytes);
  const version = bytes[0];
  const offsetSize = bytes[4] >> 4, lengthSize = bytes[4] & 15, baseSize = bytes[5] >> 4, indexSize = version ? bytes[5] & 15 : 0;
  const number = (at, width) => (width === 8 ? u64(data, at) : width === 4 ? data.getUint32(at) : width === 2 ? data.getUint16(at) : 0);
  const idWidth = version < 2 ? 2 : 4;
  let at = 6;
  const count = number(at, idWidth);
  at += idWidth;
  for (let item = 0; item < Math.min(count, MAX_BOXES) && at < bytes.length; item += 1) {
    const id = number(at, idWidth);
    at += idWidth + (version ? 2 : 0) + 2;
    const base = number(at, baseSize);
    at += baseSize;
    const extents = data.getUint16(at);
    at += 2;
    let first = null;
    for (let extent = 0; extent < Math.min(extents, MAX_BOXES); extent += 1) {
      at += indexSize;
      const offset = number(at, offsetSize), length = number(at + offsetSize, lengthSize);
      at += offsetSize + lengthSize;
      first ??= { offset: base + offset, length };
    }
    if (id === exifId && first) {
      const blob = await read(first.offset, first.length);
      // The item starts with the distance from its fifth byte to the TIFF header.
      return blob.length > 8 ? blob.subarray(4 + view(blob).getUint32(0)) : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// EXIF (a TIFF block): capture time, camera, GPS.

const EXIF_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function exifFacts(tiff) {
  if (!tiff || tiff.length < 8) return {};
  const data = view(tiff);
  const little = tiff[0] === 0x49;
  if (!little && tiff[0] !== 0x4d) return {};
  const u16 = at => data.getUint16(at, little), u32 = at => data.getUint32(at, little);
  const entries = offset => {
    const found = {};
    if (offset + 2 > tiff.length) return found;
    const count = Math.min(u16(offset), 1000);
    for (let index = 0; index < count; index += 1) {
      const at = offset + 2 + index * 12;
      if (at + 12 > tiff.length) break;
      const tag = u16(at), type = u16(at + 2), many = u32(at + 4);
      const size = (EXIF_SIZES[type] ?? 1) * many;
      const where = size > 4 ? u32(at + 8) : at + 8;
      if (where + size > tiff.length) continue;
      if (type === 2) found[tag] = text(tiff.subarray(where, where + many));
      else if (type === 3) found[tag] = u16(where);
      else if (type === 4) found[tag] = u32(where);
      else if (type === 5) found[tag] = Array.from({ length: Math.min(many, 16) }, (_, part) => { const below = u32(where + part * 8 + 4); return below ? u32(where + part * 8) / below : 0; });
    }
    return found;
  };
  const top = entries(u32(4));
  const exif = typeof top[0x8769] === 'number' ? entries(top[0x8769]) : {};
  const gps = typeof top[0x8825] === 'number' ? entries(top[0x8825]) : {};
  const facts = {};
  const taken = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(exif[0x9003] ?? top[0x0132] ?? '');
  if (taken && taken[1] !== '0000') {
    const zone = /^[+-]\d{2}:\d{2}$/.test(exif[0x9011] ?? '') ? exif[0x9011] : '';
    facts.captured_at = `${taken[1]}-${taken[2]}-${taken[3]}T${taken[4]}:${taken[5]}:${taken[6]}${zone}`;
  }
  const camera = cameraOf(top[0x010f], top[0x0110]);
  if (camera) facts.camera = camera;
  const degrees = parts => (Array.isArray(parts) && parts.length === 3 ? parts[0] + parts[1] / 60 + parts[2] / 3600 : null);
  const latitude = degrees(gps[2]), longitude = degrees(gps[4]);
  if (latitude !== null && longitude !== null && (latitude || longitude)) {
    facts.location = {
      latitude: Math.round((gps[1] === 'S' ? -latitude : latitude) * 1e6) / 1e6,
      longitude: Math.round((gps[3] === 'W' ? -longitude : longitude) * 1e6) / 1e6,
      ...(Array.isArray(gps[6]) ? { altitude: Math.round(gps[6][0] * 10) / 10 } : {}),
    };
  }
  return facts;
}

// A JPEG: its segments up to the picture data; APP1 "Exif" holds the TIFF block, a start-of-frame its size.
async function jpegFacts(read, size) {
  const facts = {};
  for (let at = 2, seen = 0; at + 4 <= size && seen < MAX_BOXES; seen += 1) {
    const head = await read(at, 4);
    if (head.length < 4 || head[0] !== 0xff) break;
    const marker = head[1], length = view(head).getUint16(2);
    if (marker === 0xda || marker === 0xd9 || length < 2) break;
    if (marker === 0xe1) {
      const segment = await read(at + 4, length - 2);
      if (text(segment.subarray(0, 4)) === 'Exif') Object.assign(facts, exifFacts(segment.subarray(6)));
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const frame = view(await read(at + 4, 5));
      facts.resolution = `${frame.getUint16(3)}×${frame.getUint16(1)}`;
    }
    at += 2 + length;
  }
  return facts;
}

// The first box types an ISO base media file starts with.
const CONTAINER_STARTS = new Set(['ftyp', 'moov', 'wide', 'mdat', 'free', 'skip', 'pnot']);

// EBML uses variable-length element IDs and sizes. Only the container's TrackType entries are needed to choose a
// picture or waveform; walking their declared sizes avoids treating a codec string elsewhere as a real track.
const WEBM_SCAN_BYTES = 256 * 1024;
const EBML = 0x1a45dfa3, SEGMENT = 0x18538067, TRACKS = 0x1654ae6b, TRACK_ENTRY = 0xae, TRACK_TYPE = 0x83;
function ebmlInteger(bytes, at, size) {
  if (at >= bytes.length) return null;
  const first = bytes[at];
  let marker = 0x80, length = 1;
  while (length <= 8 && !(first & marker)) { marker >>= 1; length += 1; }
  if (length > (size ? 8 : 4) || at + length > bytes.length) return null;
  let value = BigInt(size ? first & (marker - 1) : first);
  for (let index = 1; index < length; index += 1) value = value * 256n + BigInt(bytes[at + index]);
  const unknown = size && value === (1n << BigInt(length * 7)) - 1n;
  return { length, value: value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null, unknown };
}

function ebmlElement(bytes, at, limit) {
  const id = ebmlInteger(bytes, at, false);
  const size = id && ebmlInteger(bytes, at + id.length, true);
  if (!id || !size || id.value === null || (size.value === null && !size.unknown)) return null;
  const body = at + id.length + size.length;
  // The Segment usually declares the whole recording, far beyond the bounded opening scan.
  const end = size.unknown || (id.value === SEGMENT && body + size.value > limit) ? limit : body + size.value;
  return body <= end && end <= limit ? { id: id.value, body, end } : null;
}

function webmTrackFacts(bytes) {
  if (bytes.length < 12 || bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) return {};
  let segment = null;
  for (let at = 0, count = 0; at < bytes.length && count < MAX_BOXES; count += 1) {
    const element = ebmlElement(bytes, at, bytes.length);
    if (!element) return {};
    if (element.id === SEGMENT) { segment = element; break; }
    at = element.end;
  }
  if (!segment) return {};
  let tracks = null;
  for (let at = segment.body, count = 0; at < segment.end && count < MAX_BOXES; count += 1) {
    const element = ebmlElement(bytes, at, segment.end);
    if (!element) return {};
    if (element.id === TRACKS) { tracks = element; break; }
    at = element.end;
  }
  if (!tracks) return {};
  const found = new Set();
  for (let at = tracks.body, count = 0; at < tracks.end && count < MAX_BOXES; count += 1) {
    const entry = ebmlElement(bytes, at, tracks.end);
    if (!entry) return {};
    if (entry.id === TRACK_ENTRY) {
      for (let inside = entry.body, fields = 0; inside < entry.end && fields < MAX_BOXES; fields += 1) {
        const field = ebmlElement(bytes, inside, entry.end);
        if (!field) return {};
        if (field.id === TRACK_TYPE && field.end > field.body && field.end - field.body <= 8) {
          let type = 0;
          for (let byte = field.body; byte < field.end; byte += 1) type = type * 256 + bytes[byte];
          if (type === 1) found.add('video');
          if (type === 2) found.add('audio');
        }
        inside = field.end;
      }
    }
    at = entry.end;
  }
  return found.size ? { media_tracks: ['video', 'audio'].filter(kind => found.has(kind)) } : {};
}

/** What the file's own bytes say about it. `read(offset, length)` reads a range; `size` is the file's length. */
export async function readContainerFacts(read, size) {
  const reader = chunkedReader(read, size);
  const start = await reader(0, 12);
  if (start[0] === 0xff && start[1] === 0xd8) return jpegFacts(reader, size);
  if (start[0] === 0x1a && start[1] === 0x45 && start[2] === 0xdf && start[3] === 0xa3) {
    const first = webmTrackFacts(await reader(0, Math.min(size, CHUNK)));
    return first.media_tracks || size <= CHUNK ? first : webmTrackFacts(await reader(0, Math.min(size, WEBM_SCAN_BYTES)));
  }
  if (start.length < 12 || !CONTAINER_STARTS.has(fourcc(start, 4))) return {};
  const top = await boxes(reader, 0, size);
  const moov = child(top, 'moov'), meta = child(top, 'meta');
  if (moov) return movieFacts(reader, moov);
  if (meta) return exifFacts(await photoItemExif(reader, meta));
  return {};
}
