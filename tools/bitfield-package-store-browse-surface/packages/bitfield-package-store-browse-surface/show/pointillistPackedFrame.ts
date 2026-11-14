// Browser decoder for Rust pointillist-film-core pointillist bytes.

const FRAME_MAGIC = 'PFCF';
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 22;
const FRAME_CELL_BYTES = 16;
const ANIMATION_MAGIC = 'PFAT';
const ANIMATION_VERSION = 2;
const ANIMATION_HEADER_BYTES = 16;
const ANIMATION_TARGET_CELL_BYTES = 4;

export type PointillistPackedCell = {
  cellId: number;
  r: number;
  g: number;
  b: number;
  a: number;
  opacity: number;
  scale: number;
};

export type PointillistPackedFrame = {
  columns: number;
  rows: number;
  timeSeconds: number;
  cells: PointillistPackedCell[];
};

const POINTILLIST_FRAME_CACHE = new Map<string, Promise<PointillistPackedFrame>>();

export function fetchPointillistFrame(
  url: string,
  { cache = true }: { cache?: boolean } = {},
) {
  if (!cache) {
    return fetchCompressedPointillistBytes(url).then(decodePointillistFrame);
  }

  const cached = POINTILLIST_FRAME_CACHE.get(url);
  if (cached) return cached;

  const loaded = fetchCompressedPointillistBytes(url).then(decodePointillistFrame);
  POINTILLIST_FRAME_CACHE.set(url, loaded);
  return loaded;
}

export function fetchCompressedPointillistBytes(url: string) {
  return Promise.resolve()
    .then(() => readEmbeddedPointillistBytes(url))
    .then(decompressGzip);
}

function readEmbeddedPointillistBytes(url: string) {
  const separator = url.indexOf(',');
  const metadata = separator > 0 ? url.slice(0, separator) : '';
  if (!metadata.startsWith('data:') || !metadata.toLowerCase().includes(';base64')) {
    throw new Error('pointillist preview must use package-owned embedded bytes');
  }

  const encoded = url.slice(separator + 1);
  const decoded = globalThis.atob(encoded);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

export async function decompressGzip(bytes: Uint8Array) {
  const magic = readMagic(bytes);
  if (
    magic === FRAME_MAGIC ||
    magic === ANIMATION_MAGIC
  ) {
    return bytes;
  }

  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const stream = new Blob([body])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function decodePointillistFrame(bytes: Uint8Array): PointillistPackedFrame {
  const magic = readMagic(bytes);
  if (magic === ANIMATION_MAGIC) return decodePointillistTargetAnimation(bytes);
  if (magic !== FRAME_MAGIC) {
    throw new Error(`pointillist bytes magic mismatch: ${magic}`);
  }
  if (bytes.byteLength < FRAME_HEADER_BYTES) {
    throw new Error('pointillist frame is shorter than the header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== FRAME_VERSION) {
    throw new Error(`unsupported pointillist frame version: ${version}`);
  }

  const columns = view.getUint32(6, true);
  const rows = view.getUint32(10, true);
  const timeSeconds = view.getFloat32(14, true);
  const cellCount = view.getUint32(18, true);
  const expectedLength = FRAME_HEADER_BYTES + cellCount * FRAME_CELL_BYTES;
  if (expectedLength !== bytes.byteLength) {
    throw new Error('pointillist frame byte length mismatch');
  }

  const cells: PointillistPackedCell[] = [];
  let offset = FRAME_HEADER_BYTES;
  for (let index = 0; index < cellCount; index += 1) {
    cells.push({
      cellId: view.getUint32(offset, true),
      r: view.getUint8(offset + 4),
      g: view.getUint8(offset + 5),
      b: view.getUint8(offset + 6),
      a: view.getUint8(offset + 7),
      opacity: view.getFloat32(offset + 8, true),
      scale: view.getFloat32(offset + 12, true),
    });
    offset += FRAME_CELL_BYTES;
  }

  return { columns, rows, timeSeconds, cells };
}

function decodePointillistTargetAnimation(bytes: Uint8Array): PointillistPackedFrame {
  if (bytes.byteLength < ANIMATION_HEADER_BYTES) {
    throw new Error('pointillist animation is shorter than the header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== ANIMATION_VERSION) {
    throw new Error(`unsupported pointillist animation version: ${version}`);
  }

  const columns = view.getUint16(6, true);
  const rows = view.getUint16(8, true);
  const targetCount = view.getUint16(10, true);
  const segmentCount = view.getUint16(12, true);
  const frameRate = view.getUint16(14, true);
  if (columns <= 0 || rows <= 0 || targetCount <= 0 || frameRate <= 0) {
    throw new Error('pointillist animation header is invalid');
  }

  let offset = ANIMATION_HEADER_BYTES;
  let selectedTarget = 0;
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    offset = requireBytes(bytes, offset, 12, 'pointillist animation segment');
    const startMillis = view.getUint32(offset, true);
    const sampleCount = view.getUint16(offset + 8, true);
    offset += 12;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      offset = requireBytes(bytes, offset, 2, 'pointillist animation sample');
      const target = view.getUint16(offset, true);
      if (segmentIndex === 0 && sampleIndex === 0) selectedTarget = target;
      offset += 2;
      offset = skipScalarField(bytes, view, offset);
    }
    if (segmentIndex === 0) {
      // Static preview canvases render the first timeline sample. Animation
      // playback can layer on top of the same PFAT parser later.
      selectedTarget = clampInteger(selectedTarget, 0, targetCount - 1);
    }
    void startMillis;
  }

  const cellCount = columns * rows;
  const targetBytes = cellCount * ANIMATION_TARGET_CELL_BYTES;
  const expectedLength = offset + targetCount * targetBytes;
  if (expectedLength !== bytes.byteLength) {
    throw new Error('pointillist animation byte length mismatch');
  }

  const cells: PointillistPackedCell[] = [];
  let targetOffset = offset + selectedTarget * targetBytes;
  for (let cellId = 0; cellId < cellCount; cellId += 1) {
    cells.push({
      cellId,
      r: view.getUint8(targetOffset),
      g: view.getUint8(targetOffset + 1),
      b: view.getUint8(targetOffset + 2),
      a: view.getUint8(targetOffset + 3),
      opacity: 1,
      scale: 1,
    });
    targetOffset += ANIMATION_TARGET_CELL_BYTES;
  }

  return { columns, rows, timeSeconds: 0, cells };
}

function skipScalarField(bytes: Uint8Array, view: DataView, offset: number) {
  offset = requireBytes(bytes, offset, 3, 'pointillist scalar field');
  const termCount = view.getUint16(offset + 1, true);
  offset += 3;
  for (let termIndex = 0; termIndex < termCount; termIndex += 1) {
    offset = skipScalarExpression(bytes, view, offset);
  }
  return offset;
}

function skipScalarExpression(bytes: Uint8Array, view: DataView, offset: number): number {
  offset = requireBytes(bytes, offset, 1, 'pointillist scalar expression');
  const kind = view.getUint8(offset);
  offset += 1;
  if (kind === 0) return offset;
  if (kind === 1) return requireBytes(bytes, offset, 1, 'pointillist channel expression') + 1;
  if (kind === 2) return requireBytes(bytes, offset, 4, 'pointillist constant expression') + 4;
  if (kind === 3) {
    offset = requireBytes(bytes, offset, 1, 'pointillist unary expression') + 1;
    return skipScalarExpression(bytes, view, offset);
  }
  if (kind === 4) {
    offset = requireBytes(bytes, offset, 1, 'pointillist binary expression') + 1;
    offset = skipScalarExpression(bytes, view, offset);
    return skipScalarExpression(bytes, view, offset);
  }
  if (kind === 5) {
    offset = skipScalarExpression(bytes, view, offset);
    offset = skipScalarExpression(bytes, view, offset);
    return skipScalarExpression(bytes, view, offset);
  }
  throw new Error(`unsupported pointillist scalar expression kind: ${kind}`);
}

function readMagic(bytes: Uint8Array) {
  return String.fromCharCode(
    bytes[0] ?? 0,
    bytes[1] ?? 0,
    bytes[2] ?? 0,
    bytes[3] ?? 0,
  );
}

function requireBytes(bytes: Uint8Array, offset: number, count: number, label: string) {
  if (offset + count > bytes.byteLength) {
    throw new Error(`${label} byte length mismatch`);
  }
  return offset;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
