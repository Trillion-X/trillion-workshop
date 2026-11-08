#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, matchesGlob, resolve } from 'node:path';
import zlib from 'node:zlib';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const MODES = new Set(['SOURCE_FIRST_PORT', 'BEHAVIORAL_PORT', 'VISUAL_REPLICA', 'INSPIRATION_ONLY', 'ANTI_REFERENCE', 'NO_PRIOR_OWNER']);
const STATUSES = new Set(['ADMITTED', 'BASELINED', 'ADAPTED', 'VERIFIED', 'REJECTED', 'SUPERSEDED']);
const CURRENT_SCHEMA = 'reference-adaptation-contract/reference-grounded-adaptation';
const VISUAL_PIXEL_LOCK_SCHEMA = 'reference-adaptation-contract/measured-reference-geometry';
const VISUAL_MINIMUMS = Object.freeze({
  landmarks: 8,
  color_samples: 8,
  typography_measurements: 5,
  spacing_measurements: 8,
  surface_measurements: 3,
  control_measurements: 2,
  element_mappings: 8,
});
const BLAKE3_MULTIHASH = /^1f:[0-9a-f]{64}$/;
const SOURCE_FIRST_WORDS = /\b(copy|copied|port|ported|exact same|same animation|bring (?:it|this) over|use that exact)\b/i;
const DAY_MS = 24 * 60 * 60 * 1000;

function absolute(path) { return isAbsolute(path) ? path : resolve(process.cwd(), path); }
function multihash(bytes) { return makeHashCodeHexFromBytes(bytes); }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function meaningfulLines(text) { return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length >= 24); }
function isRecord(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function finiteNonNegative(value) { return Number.isFinite(value) && value >= 0; }
function finitePositive(value) { return Number.isFinite(value) && value > 0; }
function unique(values) { return new Set(values).size === values.length; }
function repositoryRelativePath(path) {
  return typeof path === 'string' && path.length > 0 && !/[:\\\x00-\x1f\x7f]/.test(path)
    && path.split('/').every((part) => part && part !== '.' && part !== '..');
}
function capabilityOwnerMatches(path, owner) {
  if (!repositoryRelativePath(path) || typeof owner !== 'string') return false;
  const directory = owner.endsWith('/');
  const named = directory ? owner.slice(0, -1) : owner;
  if (!repositoryRelativePath(named)) return false;
  return (directory && path.startsWith(owner)) || matchesGlob(path, directory ? `${named}/**` : named);
}
function words(text) { return new Set(String(text ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []); }
function redacted(text, redactions) {
  return redactions.reduce((out, one) => (typeof one?.from === 'string' && one.from && typeof one?.to === 'string' ? out.split(one.from).join(one.to) : out), text);
}
// The existing source-copy owner also accepts positions in the complete pinned
// UTF-8 source. The declaration discloses positions, never the removed text or
// an extra digest of a private fragment. This does not prove port admission.
function redactSourceCopy(source, redactions = [], { sourceMultihash } = {}) {
  const refused = () => new TypeError('Source copy redactions are invalid or do not bind the complete pinned source.');
  const own = (value, key) => Object.hasOwn(value, key);
  const data = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value;
  const validText = text => typeof text === 'string' && Buffer.from(text, 'utf8').toString('utf8') === text;
  if (!Buffer.isBuffer(source) || !Array.isArray(redactions)) throw refused();
  const original = Buffer.from(source);
  if (redactions.length === 0) return { bytes: original, mode: 'none' };
  const entries = [];
  for (let index = 0; index < redactions.length; index += 1) {
    const entry = data(redactions, String(index));
    if (!isRecord(entry)) throw refused();
    entries.push(entry);
  }
  const byteMode = entries.some(entry => own(entry, 'from_bytes'));
  if (!byteMode) {
    if (entries.some(entry => typeof data(entry, 'from') !== 'string' || !data(entry, 'from')
        || typeof data(entry, 'to') !== 'string')) throw refused();
    return { bytes: Buffer.from(redacted(original.toString('utf8'), entries), 'utf8'), mode: 'literal' };
  }
  // Bind all original bytes before interpreting any position.
  if (typeof sourceMultihash !== 'string' || !BLAKE3_MULTIHASH.test(sourceMultihash)
      || multihash(original) !== sourceMultihash) throw refused();
  try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original); }
  catch { throw refused(); }
  const boundary = offset => offset === original.length || (original[offset] & 0xc0) !== 0x80;
  const spans = [];
  let previousEnd = 0;
  for (const entry of entries) {
    if (Reflect.ownKeys(entry).length !== 2 || !own(entry, 'from_bytes') || !own(entry, 'to')) throw refused();
    const range = data(entry, 'from_bytes'), replacement = data(entry, 'to');
    if (!Array.isArray(range) || range.length !== 2 || Reflect.ownKeys(range).length !== 3
        || !own(range, '0') || !own(range, '1') || !validText(replacement)) throw refused();
    const start = data(range, '0'), end = data(range, '1');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < previousEnd || start < 0
        || start >= end || end > original.length || !boundary(start) || !boundary(end)) throw refused();
    spans.push({ start, end, replacement: Buffer.from(replacement, 'utf8') });
    previousEnd = end;
  }
  // Validate everything first, then assemble once using original positions.
  const chunks = [];
  let offset = 0;
  for (const { start, end, replacement } of spans) {
    chunks.push(original.subarray(offset, start), replacement);
    offset = end;
  }
  chunks.push(original.subarray(offset));
  return { bytes: Buffer.concat(chunks), mode: 'bytes' };
}
function named(source) {
  const lines = Array.isArray(source.lines) ? ` lines ${source.lines.join('-')}` : '';
  const repository = typeof source.repository === 'string' ? source.repository
    : repositoryIdentity(source.repository) ?? '(invalid repository locator)';
  return `${repository}@${String(source.commit).slice(0, 12)}:${source.path ?? `path ${source.path_multihash}`}${lines}`;
}

// A typed locator preserves the identity of the UTF-8 name without publishing it.
// Identity comparison does not resolve or grant a checkout; the source read below
// separately requires the real reader's caller-declared name scope.
function repositoryIdentity(reference) {
  if (typeof reference === 'string' && reference.length) return multihash(Buffer.from(reference));
  return isRecord(reference) && Reflect.ownKeys(reference).length === 1
    && Object.hasOwn(reference, 'repository_multihash') && typeof reference.repository_multihash === 'string'
    && BLAKE3_MULTIHASH.test(reference.repository_multihash)
    ? reference.repository_multihash : null;
}
function sameRepository(left, right) {
  const identity = repositoryIdentity(left);
  return identity !== null && identity === repositoryIdentity(right);
}

function readPngDimensions(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function decodePng(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('invalid PNG signature');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  if (!finitePositive(width) || !finitePositive(height) || bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0 || idat.length === 0) {
    throw new Error(`unsupported PNG width=${width} height=${height} bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
  }
  const channels = colorType === 2 ? 3 : 4;
  const stride = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  if (inflated.length !== height * (stride + 1)) throw new Error('PNG scanline byte count mismatch');
  const pixels = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(stride);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const current = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset + x];
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) {
        const prediction = left + up - upperLeft;
        const leftDistance = Math.abs(prediction - left);
        const upDistance = Math.abs(prediction - up);
        const upperLeftDistance = Math.abs(prediction - upperLeft);
        const predictor = leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft;
        value = raw + predictor;
      } else throw new Error(`unsupported PNG filter ${filter}`);
      current[x] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = x * channels;
      const targetIndex = (y * width + x) * 4;
      pixels[targetIndex] = current[sourceIndex];
      pixels[targetIndex + 1] = current[sourceIndex + 1];
      pixels[targetIndex + 2] = current[sourceIndex + 2];
      pixels[targetIndex + 3] = channels === 4 ? current[sourceIndex + 3] : 255;
    }
    current.copy(previous);
    sourceOffset += stride;
  }
  return { width, height, pixels };
}

function calculateRgbaDifference(referencePath, renderPath) {
  const reference = decodePng(referencePath);
  const render = decodePng(renderPath);
  if (reference.width !== render.width || reference.height !== render.height) throw new Error('reference and render PNG dimensions differ');
  let absoluteDelta = 0;
  for (let index = 0; index < reference.pixels.length; index += 1) absoluteDelta += Math.abs(reference.pixels[index] - render.pixels[index]);
  return absoluteDelta / (reference.pixels.length * 255);
}

function validateMeasuredFile(row, label, errors, { png = false } = {}) {
  if (!isRecord(row)) {
    errors.push(`${label} is required`);
    return null;
  }
  const path = row.path ? absolute(row.path) : null;
  if (!path || !existsSync(path)) {
    errors.push(`${label} missing: ${path ?? '(no path)'}`);
    return null;
  }
  const bytes = readFileSync(path);
  if (!BLAKE3_MULTIHASH.test(row.multihash ?? '') || multihash(bytes) !== row.multihash) errors.push(`${label} multihash drift`);
  if (!png) return { path };
  const dimensions = readPngDimensions(path);
  if (!dimensions) {
    errors.push(`${label} must be a PNG with a readable IHDR`);
    return { path };
  }
  if (dimensions.width !== row.width || dimensions.height !== row.height) {
    errors.push(`${label} dimensions ${dimensions.width}x${dimensions.height} do not match ${row.width}x${row.height}`);
  }
  return { path, ...dimensions };
}

function validateBounds(bounds, label, errors, dimensions) {
  if (!isRecord(bounds)
    || !finiteNonNegative(bounds.x_px)
    || !finiteNonNegative(bounds.y_px)
    || !finitePositive(bounds.width_px)
    || !finitePositive(bounds.height_px)) {
    errors.push(`${label} requires non-negative x/y and positive width/height`);
    return;
  }
  if (dimensions && (bounds.x_px + bounds.width_px > dimensions.width || bounds.y_px + bounds.height_px > dimensions.height)) {
    errors.push(`${label} exceeds measured image bounds`);
  }
}

function requireMeasurementArray(reference, key, minimum, errors) {
  const rows = reference?.[key];
  if (!Array.isArray(rows) || rows.length < minimum) {
    errors.push(`pixel lock reference ${reference?.id ?? '(missing id)'} requires at least ${minimum} ${key}`);
    return [];
  }
  const ids = rows.map((row) => row?.id).filter(Boolean);
  if (ids.length !== rows.length || !unique(ids)) errors.push(`pixel lock reference ${reference.id} ${key} require unique ids`);
  return rows;
}

function validateVisualPixelLock(contract, stage, errors) {
  const receipt = contract?.pixel_lock ?? contract?.proof?.pixel_lock;
  if (!isRecord(receipt)) {
    errors.push('VISUAL_REPLICA requires pixel_lock path and BLAKE3 multihash');
    return null;
  }
  const lockPath = receipt.path ? absolute(receipt.path) : null;
  if (!lockPath || !existsSync(lockPath)) {
    errors.push(`VISUAL_REPLICA pixel lock missing: ${lockPath ?? '(no path)'}`);
    return null;
  }
  const lockBytes = readFileSync(lockPath);
  if (!BLAKE3_MULTIHASH.test(receipt.multihash ?? '') || multihash(lockBytes) !== receipt.multihash) errors.push('VISUAL_REPLICA pixel lock multihash drift');
  let lock;
  try {
    lock = JSON.parse(lockBytes.toString('utf8'));
  } catch {
    errors.push('VISUAL_REPLICA pixel lock is not valid JSON');
    return null;
  }
  if (lock?.schema !== VISUAL_PIXEL_LOCK_SCHEMA) {
    errors.push(`VISUAL_REPLICA pixel lock must use ${VISUAL_PIXEL_LOCK_SCHEMA}`);
  }
  if (!Array.isArray(lock?.references) || lock.references.length === 0) errors.push('VISUAL_REPLICA pixel lock requires references');
  if (!Array.isArray(lock?.target_screens) || lock.target_screens.length === 0) errors.push('VISUAL_REPLICA pixel lock requires target_screens');

  const references = Array.isArray(lock?.references) ? lock.references : [];
  const referenceIds = references.map((reference) => reference?.id).filter(Boolean);
  if (referenceIds.length !== references.length || !unique(referenceIds)) errors.push('VISUAL_REPLICA references require unique ids');
  const referenceById = new Map(references.map((reference) => [reference?.id, reference]));

  for (const reference of references) {
    const sourceDimensions = validateMeasuredFile(reference?.source, `pixel lock reference ${reference?.id} source`, errors, { png: true });
    const cropDimensions = validateMeasuredFile(reference?.crop, `pixel lock reference ${reference?.id} crop`, errors, { png: true });
    validateMeasuredFile(reference?.annotated_proof, `pixel lock reference ${reference?.id} annotated_proof`, errors, { png: true });
    const crop = reference?.crop;
    if (!finiteNonNegative(crop?.source_x_px) || !finiteNonNegative(crop?.source_y_px)) {
      errors.push(`pixel lock reference ${reference?.id} crop requires source_x_px and source_y_px`);
    } else if (sourceDimensions && cropDimensions
      && (crop.source_x_px + cropDimensions.width > sourceDimensions.width || crop.source_y_px + cropDimensions.height > sourceDimensions.height)) {
      errors.push(`pixel lock reference ${reference?.id} crop exceeds source bounds`);
    }

    const landmarks = requireMeasurementArray(reference, 'landmarks', VISUAL_MINIMUMS.landmarks, errors);
    for (const row of landmarks) {
      if (!finiteNonNegative(row?.x_px) || !finiteNonNegative(row?.y_px)) errors.push(`landmark ${row?.id ?? '(missing id)'} requires x_px and y_px`);
      else if (cropDimensions && (row.x_px >= cropDimensions.width || row.y_px >= cropDimensions.height)) errors.push(`landmark ${row.id} exceeds crop bounds`);
    }
    const colors = requireMeasurementArray(reference, 'color_samples', VISUAL_MINIMUMS.color_samples, errors);
    for (const row of colors) {
      if (!/^#[0-9A-F]{8}$/i.test(row?.rgba_hex ?? '')) errors.push(`color sample ${row?.id ?? '(missing id)'} requires 8-digit rgba_hex`);
      if (!finiteNonNegative(row?.x_px) || !finiteNonNegative(row?.y_px)) errors.push(`color sample ${row?.id ?? '(missing id)'} requires x_px and y_px`);
    }
    const typography = requireMeasurementArray(reference, 'typography_measurements', VISUAL_MINIMUMS.typography_measurements, errors);
    for (const row of typography) {
      validateBounds(row?.bounds, `typography measurement ${row?.id ?? '(missing id)'} bounds`, errors, cropDimensions);
      if (!finitePositive(row?.font_size_px) || !finitePositive(row?.line_height_px) || !finitePositive(row?.font_weight) || !Number.isFinite(row?.letter_spacing_px)) {
        errors.push(`typography measurement ${row?.id ?? '(missing id)'} requires font_size_px, line_height_px, font_weight, and letter_spacing_px`);
      }
    }
    const spacings = requireMeasurementArray(reference, 'spacing_measurements', VISUAL_MINIMUMS.spacing_measurements, errors);
    for (const row of spacings) if (!['x', 'y'].includes(row?.axis) || !finiteNonNegative(row?.distance_px)) errors.push(`spacing measurement ${row?.id ?? '(missing id)'} requires axis and distance_px`);
    const surfaces = requireMeasurementArray(reference, 'surface_measurements', VISUAL_MINIMUMS.surface_measurements, errors);
    for (const row of surfaces) {
      validateBounds(row?.bounds, `surface measurement ${row?.id ?? '(missing id)'} bounds`, errors, cropDimensions);
      if (!finiteNonNegative(row?.radius_px) || !finiteNonNegative(row?.border_width_px) || !/^#[0-9A-F]{8}$/i.test(row?.fill_rgba_hex ?? '')) {
        errors.push(`surface measurement ${row?.id ?? '(missing id)'} requires radius_px, border_width_px, and fill_rgba_hex`);
      }
    }
    const controls = requireMeasurementArray(reference, 'control_measurements', VISUAL_MINIMUMS.control_measurements, errors);
    for (const row of controls) {
      validateBounds(row?.bounds, `control measurement ${row?.id ?? '(missing id)'} bounds`, errors, cropDimensions);
      if (!finiteNonNegative(row?.radius_px)) errors.push(`control measurement ${row?.id ?? '(missing id)'} requires radius_px`);
    }
  }

  const screens = Array.isArray(lock?.target_screens) ? lock.target_screens : [];
  const screenIds = screens.map((screen) => screen?.id).filter(Boolean);
  if (screenIds.length !== screens.length || !unique(screenIds)) errors.push('VISUAL_REPLICA target_screens require unique ids');
  for (const screen of screens) {
    const reference = referenceById.get(screen?.reference_id);
    if (!reference) errors.push(`target screen ${screen?.id ?? '(missing id)'} references unknown reference_id`);
    if (!finitePositive(screen?.replica_dimensions?.width) || !finitePositive(screen?.replica_dimensions?.height)) {
      errors.push(`target screen ${screen?.id ?? '(missing id)'} requires replica_dimensions`);
    } else if (reference && (screen.replica_dimensions.width !== reference.crop?.width || screen.replica_dimensions.height !== reference.crop?.height)) {
      errors.push(`target screen ${screen.id} replica_dimensions must equal reference crop dimensions`);
    }
    const mappings = requireMeasurementArray(screen, 'element_mappings', VISUAL_MINIMUMS.element_mappings, errors);
    for (const mapping of mappings) {
      if (!String(mapping?.reference_element ?? '').trim() || !String(mapping?.target_element ?? '').trim() || !String(mapping?.implementation_owner ?? '').trim()) {
        errors.push(`element mapping ${mapping?.id ?? '(missing id)'} requires reference_element, target_element, and implementation_owner`);
      }
      validateBounds(mapping?.reference_bounds, `element mapping ${mapping?.id ?? '(missing id)'} reference_bounds`, errors, reference ? { width: reference.crop?.width, height: reference.crop?.height } : null);
    }
    if (stage === 'completion') {
      const render = validateMeasuredFile(screen?.render_proof, `target screen ${screen?.id} render_proof`, errors, { png: true });
      if (render && (render.width !== screen.replica_dimensions?.width || render.height !== screen.replica_dimensions?.height)) {
        errors.push(`target screen ${screen.id} render_proof must match replica_dimensions`);
      }
      const comparison = screen?.comparison;
      if (!isRecord(comparison)) errors.push(`target screen ${screen?.id} requires pixel comparison proof`);
      else {
        validateMeasuredFile({
          path: comparison.pixel_diff_path,
          multihash: comparison.pixel_diff_multihash,
          width: screen.replica_dimensions?.width,
          height: screen.replica_dimensions?.height,
        }, `target screen ${screen?.id} pixel diff`, errors, { png: true });
        if (comparison.method !== 'mean-absolute-rgba-byte-difference') errors.push(`target screen ${screen?.id} comparison method must be mean-absolute-rgba-byte-difference`);
        if (!finiteNonNegative(comparison.difference_ratio) || !finiteNonNegative(comparison.maximum_difference_ratio) || comparison.maximum_difference_ratio > 0.03) {
          errors.push(`target screen ${screen?.id} comparison requires ratios and maximum_difference_ratio <= 0.03`);
        } else if (comparison.difference_ratio > comparison.maximum_difference_ratio) {
          errors.push(`target screen ${screen.id} difference_ratio exceeds maximum_difference_ratio`);
        }
        if (reference?.crop?.path && screen?.render_proof?.path) {
          try {
            const actualDifferenceRatio = calculateRgbaDifference(absolute(reference.crop.path), absolute(screen.render_proof.path));
            if (Math.abs(actualDifferenceRatio - comparison.difference_ratio) > 0.000001) {
              errors.push(`target screen ${screen.id} declared difference_ratio ${comparison.difference_ratio} does not match measured ${actualDifferenceRatio}`);
            }
            if (finiteNonNegative(comparison.maximum_difference_ratio) && actualDifferenceRatio > comparison.maximum_difference_ratio) {
              errors.push(`target screen ${screen.id} measured RGBA difference exceeds maximum_difference_ratio`);
            }
          } catch (error) {
            errors.push(`target screen ${screen.id} pixel comparison failed: ${String(error?.message ?? error)}`);
          }
        }
      }
    }
  }
  return { referenceCount: references.length, targetScreenCount: screens.length, minimums: VISUAL_MINIMUMS };
}

// A source named by repository, commit and path (`{ repository, commit, path, multihash, old_copy }`) is one job's old
// owner. One copy: the old one goes. `old_copy` is "same-file" when the source is the target's own earlier bytes (a
// change in place), else `{ deleted_by }`, a date by which the old path leaves its repository's main line, at most
// options.oldCopyDaysAtMost days after the baseline. Whether it is gone is read through options.readers.
// A source that is part of a file names it as `lines: [first, last]` (1-based, inclusive, at its commit): its bytes,
// its multihash and its line retention are those lines only, and its old copy is gone when their whitespace-folded
// text no longer appears in the file on its repository's main line, while the rest of the file stays.
const folded = (text) => text.replace(/\s+/g, ' ').trim();
function sourceLines(source, bytes, errors) {
  if (source.lines === undefined) return bytes;
  const [first, last] = Array.isArray(source.lines) ? source.lines : [];
  const all = bytes.toString('utf8').split('\n');
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > all.length) {
    errors.push(`source ${named(source)}: lines must be [first, last] within its ${all.length} lines at its commit`);
    return null;
  }
  return Buffer.from(`${all.slice(first - 1, last).join('\n')}\n`);
}
function partLives(source, part, options) {
  const main = options.readers?.mainOf?.(source.repository), path = main ? options.readers.pathOf?.(source) ?? source.path : null;
  if (!path || !options.readers.lives?.(source.repository, path)) return path ? false : null;
  const now = options.readers.readSource({ ...source, path, commit: main });
  return now === null ? null : folded(now.toString('utf8')).includes(folded(part.toString('utf8')));
}
function oldCopyLives(source, part, options) {
  if (options.readers?.retirementOf) {
    const state = options.readers.retirementOf(source);
    if (state?.state === 'absent') return false;
    if (state?.state !== 'regular') return null;
    return part ? folded(state.bytes.toString('utf8')).includes(folded(part.toString('utf8'))) : true;
  }
  const path = options.readers?.pathOf?.(source) ?? source.path;
  return part ? partLives(source, part, options) : path ? options.readers?.lives?.(source.repository, path) ?? null : null;
}
function ownTargetIdentity(source, targetPath, options) {
  return typeof source?.path === 'string' && sameRepository(source.repository, options.repository) && (source.path === targetPath
    || options.readers?.sameFileIdentity?.(source.commit, source.path, targetPath) === true);
}
function checkOldCopy(source, contract, options, errors, deferred, part) {
  const old = source.old_copy;
  const sameFile = (Array.isArray(contract.targets) ? contract.targets : []).some((target) => ownTargetIdentity(source, target?.path, options));
  if (old === 'same-file' || (old === undefined && sameFile)) {
    if (!sameFile) errors.push(`source ${named(source)}: old_copy "same-file" needs the source to be a target's own path in this repository`);
    return;
  }
  if (!isRecord(old) || Number.isNaN(Date.parse(old.deleted_by ?? ''))) {
    errors.push(`source ${named(source)}: old_copy must be "same-file" or { deleted_by: <date> }; a move leaves one copy`);
    return;
  }
  const due = Date.parse(old.deleted_by);
  const recorded = Date.parse(contract?.baseline?.recorded_at ?? '');
  if (Number.isFinite(options.oldCopyDaysAtMost)) {
    if (!Number.isFinite(recorded)) errors.push('baseline.recorded_at is required to judge old_copy.deleted_by');
    else if (due - recorded > options.oldCopyDaysAtMost * DAY_MS) errors.push(`source ${named(source)}: old_copy.deleted_by is more than ${options.oldCopyDaysAtMost} days after baseline.recorded_at`);
  }
  const lives = oldCopyLives(source, part, options);
  if (lives === null) {
    deferred.push(`whether the old copy ${named(source)} has retired is not readable here`);
    return;
  }
  if (!lives) return;
  const now = options.now ? Date.parse(options.now) : Date.now();
  if (now > due) errors.push(`the old copy ${named(source)} still lives after its deleted_by ${old.deleted_by}: two copies of one job`);
  else if (contract.status === 'VERIFIED') errors.push(`VERIFIED while the old copy ${named(source)} still lives: one copy is part of done`);
}

// NO_PRIOR_OWNER: nothing older does this job. The claim carries the search that found nothing (proof.search: the job
// phrasings, the capability rows returned, the code patterns and each repository searched at its commit), and the
// judge runs that search again now, so a claim cannot be carried forward past an owner that exists. Every row the
// capability search finds near, and every file the code search finds, is either named in distinct_from with why it is
// a different job, or the claim is refused. options.searchRepositories names the repositories a search must cover;
// options.readers.searchCode and options.searchCapabilities re-run it. What cannot be re-run here is deferred, in words.
function checkNoPriorOwner(contract, options, errors, deferred) {
  if (contract?.sources?.length) errors.push('NO_PRIOR_OWNER names no sources: a source is a prior owner, so port it');
  const job = String(contract?.job ?? '').trim();
  if (!job) errors.push('NO_PRIOR_OWNER requires job: the job in the words a person would use for it');
  const search = contract?.proof?.search;
  if (!isRecord(search)) {
    errors.push('NO_PRIOR_OWNER requires proof.search: the capability search and the code search that found no owner');
    return null;
  }
  const phrasings = (Array.isArray(search.phrasings) ? search.phrasings : []).map(String).filter((one) => one.trim());
  if (!phrasings.length) errors.push('proof.search.phrasings must name the job phrasings searched');
  else if (job && !phrasings.includes(job)) errors.push('proof.search.phrasings must include the job itself');
  if (!Array.isArray(search.capability_rows)) errors.push('proof.search.capability_rows must record the rows the capability search returned');
  const patterns = (Array.isArray(search.code_patterns) ? search.code_patterns : []).map(String).filter(Boolean);
  if (!patterns.length) errors.push('proof.search.code_patterns must name the code searched for');
  const asked = new Set(phrasings.flatMap((phrase) => [...words(phrase)]));
  const usable = patterns.filter((pattern) => {
    try {
      new RegExp(pattern, 'i');
    } catch {
      errors.push(`code pattern ${pattern} is not a regular expression`);
      return false;
    }
    if (![...words(pattern.replace(/\\[a-z]/gi, ' '))].some((word) => asked.has(word))) {
      errors.push(`code pattern ${pattern} shares no word with the job phrasings`);
      return false;
    }
    return true;
  });
  const recorded = new Map();
  for (const row of Array.isArray(search.repositories) ? search.repositories : []) {
    if (!isRecord(row) || Number(Object.hasOwn(row, 'repository')) + Number(Object.hasOwn(row, 'repository_multihash')) !== 1) {
      errors.push('proof.search.repositories needs exactly one repository name or repository_multihash per row');
      continue;
    }
    const privateReference = Object.hasOwn(row, 'repository_multihash');
    const name = privateReference
      ? (BLAKE3_MULTIHASH.test(row.repository_multihash ?? '')
        ? options.readers?.repositoryName?.({ repository_multihash: row.repository_multihash }, options.searchRepositories ?? []) : null)
      : row.repository;
    if (typeof name !== 'string' || !name || (privateReference && multihash(Buffer.from(name)) !== row.repository_multihash)) {
      errors.push('proof.search.repositories has an invalid or unresolved repository locator in the declared reader scope');
      continue;
    }
    if (recorded.has(name)) {
      errors.push('proof.search.repositories records the same resolved repository more than once');
      continue;
    }
    if (typeof row.commit !== 'string' || !/^[0-9a-f]{7,64}$/.test(row.commit)) {
      errors.push('proof.search.repositories needs an immutable commit identity for each captured search');
      continue;
    }
    if (typeof options.readers?.repositoryCommit !== 'function' || options.readers?.checkout?.(name) === null) {
      deferred.push(`the captured search commit for ${name} could not be verified here`);
    } else {
      const captured = options.readers.repositoryCommit(name, row.commit);
      if (typeof captured !== 'string' || !/^[0-9a-f]{7,64}$/.test(captured) || !captured.startsWith(row.commit)) {
        errors.push('proof.search.repositories could not verify the captured commit in its declared repository');
        continue;
      }
    }
    recorded.set(name, row.commit);
  }
  if (![...recorded.values()].some(Boolean)) errors.push('proof.search.repositories must record each repository searched and its commit');
  for (const name of options.searchRepositories ?? []) if (!recorded.get(name)) errors.push(`proof.search.repositories does not record a search of ${name}`);

  const distinct = Array.isArray(contract?.distinct_from) ? contract.distinct_from : [];
  for (const one of distinct) if (!String(one?.why ?? '').trim()) errors.push(`distinct_from ${one?.capability ?? one?.path ?? '(unnamed)'} requires why`);
  const namesFile = (repository, path) => distinct.some((one) => sameRepository(one?.repository, repository)
    && (one.path === path || (String(one.path ?? '').endsWith('/') && path.startsWith(one.path))));
  const namesRow = (row) => distinct.some((one) => one?.capability === row.capability);
  const own = new Set((Array.isArray(contract?.targets) ? contract.targets : []).map((target) => target?.path));
  const isContract = options.isContract ?? (() => false);

  const unnamed = new Map();
  const searched = {};
  for (const name of [...new Set([...(options.searchRepositories ?? []), ...recorded.keys()])].filter(Boolean)) {
    for (const pattern of usable) {
      const hits = options.readers?.searchCode?.(name, pattern) ?? null;
      if (hits === null) {
        deferred.push(`the code search of ${name} is not re-run here: no checkout`);
        break;
      }
      searched[name] = options.readers.mainOf?.(name) ?? null;
      for (const path of hits) {
        if ((name === options.repository && own.has(path)) || isContract(path) || namesFile(name, path)) continue;
        if (!unnamed.has(`${name}:${path}`)) unnamed.set(`${name}:${path}`, pattern);
      }
    }
  }
  for (const [hit, pattern] of unnamed) errors.push(`the code search /${pattern}/ finds ${hit}: port it, or name it in distinct_from with why it is a different job`);

  const rowsNear = [];
  if (typeof options.searchCapabilities !== 'function') deferred.push('the capability search is not re-run here');
  else {
    for (const phrase of phrasings) {
      const rows = options.searchCapabilities(phrase);
      if (rows === null) {
        deferred.push(`the capability search for "${phrase}" did not answer`);
        continue;
      }
      for (const row of rows.filter((one) => one.near)) {
        const ownRow = row.repository === options.repository && (Array.isArray(row.owner) ? row.owner : []).some((owner) => [...own].some((path) => capabilityOwnerMatches(path, owner)));
        if (ownRow || namesRow(row)) continue;
        rowsNear.push(row.capability);
        errors.push(`the capability search for "${phrase}" finds "${row.capability}" (${row.where ?? row.repository}): port it, or name it in distinct_from with why it is a different job`);
      }
    }
  }
  return { searched, capabilityRowsNear: [...new Set(rowsNear)] };
}

// The reader of every target byte the validator judges: options.readers (read-from-repositories.mjs) when given, so a
// commit gate reads the staged or committed bytes, else the file on disk relative to the current folder.
function readTargetBytes(path, options) {
  if (options.readers?.readTarget) return options.readers.readTarget(path);
  const file = absolute(path);
  return existsSync(file) ? readFileSync(file) : null;
}

// Shared source and declaration evidence. No current target, retirement or history verdict is made here.
function readContractEvidence(contract, options) {
  const errors = [];
  const deferred = [];
  contract = contract && typeof contract === 'object' && !Array.isArray(contract) ? contract : {};
  const stage = options.stage ?? 'completion';
  if (!['pre-edit', 'completion'].includes(stage)) errors.push(`invalid stage ${stage}`);
  const targetNeedle = options.target ? (options.readers ? options.target : absolute(options.target)) : null;
  const required = ['schema', 'id', 'status', 'directive', 'mode', 'sources', 'targets', 'preserve', 'allowed_deltas', 'banned_substitutions', 'baseline', 'proof'];
  for (const key of required) if (!(key in (contract ?? {}))) errors.push(`missing ${key}`);
  if (contract?.schema !== CURRENT_SCHEMA) errors.push('unsupported schema');
  if (!/^REF-[A-Z0-9][A-Z0-9-]+$/.test(contract?.id ?? '')) errors.push('invalid id');
  if (!STATUSES.has(contract?.status)) errors.push('invalid status');
  if (!MODES.has(contract?.mode)) errors.push('invalid mode');
  if (options.modes && !options.modes.includes(contract?.mode)) errors.push(`mode ${contract?.mode} is not one this repository accepts (${options.modes.join(', ')})`);
  if (!BLAKE3_MULTIHASH.test(contract?.directive?.message_multihash ?? '')) errors.push('directive requires a valid BLAKE3 message_multihash');
  if (!String(contract?.directive?.quote ?? '').trim()) errors.push('directive.quote is required');
  if (SOURCE_FIRST_WORDS.test(String(contract?.directive?.quote ?? '')) && contract?.mode !== 'SOURCE_FIRST_PORT') {
    errors.push('literal copy/port/exact-same directive requires SOURCE_FIRST_PORT');
  }
  const noPriorOwner = contract?.mode === 'NO_PRIOR_OWNER';
  if (!noPriorOwner && (!Array.isArray(contract?.sources) || contract.sources.length === 0)) errors.push('sources must be non-empty');
  if (!Array.isArray(contract?.targets) || contract.targets.length === 0) errors.push('targets must be non-empty');
  const sources = Array.isArray(contract?.sources) ? contract.sources : [];
  const targets = Array.isArray(contract?.targets) ? contract.targets : [];
  const ownsTarget = (row) => (options.readers ? row?.path === targetNeedle : absolute(row?.path ?? '') === targetNeedle);
  if (targetNeedle && !targets.some(ownsTarget)) errors.push(`contract does not own target ${targetNeedle}`);

  const source = sources[0];
  const target = targets[0];
  const separateBaseline = isRecord(contract.baseline) && Object.hasOwn(contract.baseline, 'path');
  const baselinePath = separateBaseline ? contract.baseline.path : target?.path;
  if ((options.readers || separateBaseline || source?.repository) && targets.some((one) => !repositoryRelativePath(one?.path))) errors.push('targets must use canonical repository-relative paths without traversal');
  if (separateBaseline) {
    if (!repositoryRelativePath(baselinePath)) errors.push('baseline.path must be a non-empty repository-relative path without traversal');
    if (targets.some((one) => one?.path === baselinePath)) errors.push('baseline.path is a separate byte-copy artifact and must not appear in targets');
  }
  // A source in a private repository moved into a public one may have to lose words before its first commit there (a
  // person's name, a private path): baseline.redactions lists each literal replacement, and the byte copy is then the
  // source with exactly those replacements. Nothing else may differ.
  if (contract?.baseline?.redactions !== undefined && !Array.isArray(contract.baseline.redactions)) errors.push('baseline.redactions must be an array');
  const redactions = Array.isArray(contract?.baseline?.redactions) ? contract.baseline.redactions : [];
  const declarations = Array.from({ length: redactions.length }, (_, index) => Object.getOwnPropertyDescriptor(redactions, String(index))?.value);
  const byteRedactions = declarations.some(one => isRecord(one) && Object.hasOwn(one, 'from_bytes'));
  const completeByteSource = sources.length === 1 && source?.repository && source?.commit && source?.lines === undefined;
  if (byteRedactions && (contract.mode !== 'SOURCE_FIRST_PORT' || !completeByteSource)) {
    errors.push('byte redactions require SOURCE_FIRST_PORT with exactly one complete immutable repository source and no selected lines');
  }
  if (!byteRedactions) for (const one of declarations) {
    const from = isRecord(one) ? Object.getOwnPropertyDescriptor(one, 'from')?.value : null;
    const to = isRecord(one) ? Object.getOwnPropertyDescriptor(one, 'to')?.value : null;
    if (typeof from !== 'string' || !from || typeof to !== 'string') errors.push('baseline.redactions are { from, to } literal replacements');
  }
  const sourceTexts = [];
  const sourceChecks = [];
  let sourceCopyBytes = null;
  let sourceArtifact = null;
  let sourceArtifactCount = 0;
  let sourceArtifactsMatch = true;
  for (const one of sources) {
    if (one?.repository !== undefined || one?.commit !== undefined) {
      if (!repositoryIdentity(one?.repository) || !/^[0-9a-f]{7,64}$/.test(String(one?.commit ?? '')) || !(one?.path || BLAKE3_MULTIHASH.test(String(one?.path_multihash ?? '')))) {
        errors.push('a source named by repository needs repository, commit (a commit identity) and path, or path_multihash for a private repository');
        continue;
      }
      const resolvedRepository = typeof one.repository === 'string' || Boolean(options.readers?.repositoryName?.(one.repository));
      if (!resolvedRepository) {
        deferred.push(`source ${named(one)} has no unambiguous caller-declared repository`);
      }
      const file = resolvedRepository ? options.readers?.readSource?.(one) ?? null : null;
      const bytes = file && sourceLines(one, file, errors);
      if (file === null && resolvedRepository && options.readers?.checkout?.(one.repository)) errors.push(`source ${named(one)} is not in that commit`);
      else if (file === null && resolvedRepository) deferred.push(`source ${named(one)} is not readable here`);
      else if (bytes) {
        if (separateBaseline && source?.lines !== undefined && !redactions.length) {
          if (sourceArtifact === null) sourceArtifact = Buffer.from(file);
          else if (!sourceArtifact.equals(file)) sourceArtifactsMatch = false;
          sourceArtifactCount += 1;
        }
        if (multihash(bytes) !== one.multihash) errors.push(`source multihash drift: ${named(one)}`);
        let retentionText = bytes.toString('utf8');
        if (one === source && (!byteRedactions || completeByteSource)) {
          try {
            const copy = redactSourceCopy(bytes, redactions, { sourceMultihash: one.multihash });
            sourceCopyBytes = copy.bytes;
            if (copy.mode !== 'bytes') retentionText = copy.bytes.toString('utf8');
          } catch {
            errors.push('Source copy redactions are invalid or do not bind the complete pinned source.');
          }
        }
        // Byte redactions never shrink the original retention denominator.
        sourceTexts.push(retentionText);
      }
      sourceChecks.push({ source: one, bytes: one.lines === undefined ? null : bytes });
    } else if (options.requireRepositorySources) {
      errors.push(`source ${one?.path ?? '(no path)'} must be named by repository, commit and path, so every checkout reads the same bytes`);
    } else {
      const sourcePath = one?.path ? absolute(one.path) : null;
      if (sourcePath && existsSync(sourcePath)) {
        const bytes = readFileSync(sourcePath);
        sourceTexts.push(bytes.toString('utf8'));
        if (one === source) sourceCopyBytes = Buffer.from(bytes);
        if (multihash(bytes) !== one.multihash) errors.push('source multihash drift');
      } else if (sourcePath) errors.push(`source missing: ${sourcePath}`);
    }
  }
  let fullSourceBaseline = false;
  let copied = source?.multihash;
  if (contract?.mode === 'SOURCE_FIRST_PORT') {
    if (!['user-owned', 'repository-owned', 'licensed'].includes(source?.ownership)) errors.push('SOURCE_FIRST_PORT requires owned or licensed source');
    if (!contract?.baseline?.copied_before_adaptation) errors.push('SOURCE_FIRST_PORT requires copied_before_adaptation=true');
    if (contract?.baseline?.source_multihash !== source?.multihash) errors.push('baseline source multihash must equal declared source multihash');
    // A complete, unchanged snapshot of this same pinned source also proves its selected ranges.
    // Bind the whole artifact, not merely matching slices from an unrelated or changed file.
    fullSourceBaseline = separateBaseline && source?.repository && source?.lines !== undefined && !redactions.length
      && sourceArtifactCount === sources.length && sourceArtifactCount > 0 && sourceArtifactsMatch
      && sources.every((one) => sameRepository(one.repository, source.repository) && one.commit === source.commit
        && one.path === source.path && one.path_multihash === source.path_multihash)
      && multihash(sourceArtifact) === contract?.baseline?.target_multihash_at_baseline;
    copied = redactions.length || fullSourceBaseline ? contract?.baseline?.target_multihash_at_baseline : source?.multihash;
    if (!redactions.length && !fullSourceBaseline && copied !== contract?.baseline?.target_multihash_at_baseline) errors.push('baseline target multihash must equal source multihash');
    if (redactions.length && sourceCopyBytes !== null && multihash(sourceCopyBytes) !== copied) {
      errors.push('baseline target multihash must equal the source with exactly baseline.redactions applied');
    }
    if (!Array.isArray(contract?.preserve) || contract.preserve.length === 0) errors.push('SOURCE_FIRST_PORT requires preserved mechanisms');
    if (!Array.isArray(contract?.banned_substitutions) || contract.banned_substitutions.length === 0) errors.push('SOURCE_FIRST_PORT requires banned substitutions');
  }
  if (contract?.mode === 'BEHAVIORAL_PORT' && !(contract?.proof?.test_refs?.length > 0 && contract?.preserve?.length > 0)) errors.push('BEHAVIORAL_PORT requires preserved behaviors and test refs');
  if (contract?.mode === 'VISUAL_REPLICA' && !(contract?.proof?.render_refs?.length > 0)) errors.push('VISUAL_REPLICA requires render refs');
  if (contract?.mode === 'INSPIRATION_ONLY' && !contract?.proof?.originality_ref) errors.push('INSPIRATION_ONLY requires originality_ref');
  if (contract?.mode === 'ANTI_REFERENCE' && !(contract?.banned_substitutions?.length > 0)) errors.push('ANTI_REFERENCE requires explicit excluded patterns');
  return { contract, errors, deferred, stage, noPriorOwner, sources, targets, source, target,
    separateBaseline, baselinePath,
    sourceTexts, sourceChecks, fullSourceBaseline, copied };
}

/** Pinned source bytes and declared copy identities, without claiming that a copy completed or a port is admitted. */
export function validateReferenceAdaptationEvidence(contract, options = {}) {
  const evidence = readContractEvidence(contract, { ...options, requireRepositorySources: true });
  if (evidence.noPriorOwner) evidence.errors.push('NO_PRIOR_OWNER requires fresh searches outside immutable contract evidence');
  return {
    scope: 'immutable-contract-evidence', admission: false,
    valid: evidence.errors.length === 0, errors: evidence.errors, deferred: evidence.deferred,
    id: evidence.contract?.id ?? null, mode: evidence.contract?.mode ?? null,
    status: evidence.contract?.status ?? null, measurements: null,
  };
}

export function validateReferenceAdaptationContract(contract, options = {}) {
  const evidence = readContractEvidence(contract, options);
  const { errors, deferred, stage, noPriorOwner, sources, targets, source, target,
    separateBaseline, baselinePath,
    sourceTexts, sourceChecks, fullSourceBaseline, copied } = evidence;
  contract = evidence.contract;
  const activeScope = Array.isArray(options.activeTargetPaths) ? new Set(options.activeTargetPaths) : null;
  const artifacts = new Set();
  if (separateBaseline) artifacts.add(baselinePath);
  // In a legacy archive-first contract the first target is also its claimed
  // original-copy artifact. It cannot become active merely because it exists.
  if (contract.mode === 'SOURCE_FIRST_PORT' && !separateBaseline && activeScope && !activeScope.has(baselinePath)) artifacts.add(baselinePath);
  const activeTargets = targets.filter((one) => !artifacts.has(one?.path) && (!activeScope || activeScope.has(one?.path)));
  const ambiguousTargets = contract.mode === 'SOURCE_FIRST_PORT' && targets.length > 1 && !separateBaseline && !activeScope;
  if (ambiguousTargets) errors.push('multiple targets require baseline.path or activeTargetPaths to prove active retention');
  if (targets.some((one) => artifacts.has(one?.path))) errors.push('targets must not name baseline artifacts; a separate artifact belongs in baseline.path');
  for (const one of sourceChecks) checkOldCopy(one.source, contract, options, errors, deferred, one.bytes);
  const targetTexts = [];
  let targetBytes = null;
  for (const one of targets) {
    // A declared archival copy never supplies retention or required mechanisms, even in an invalid contract.
    if (artifacts.has(one?.path) || ((options.readers || separateBaseline) && !repositoryRelativePath(one?.path))) continue;
    const bytes = one?.path ? readTargetBytes(one.path, options) : null;
    if (bytes) {
      // Admission reads every current target, including coupled DATA. Only the
      // independently constrained feature scope supplies retained mechanisms.
      if (!activeScope || activeScope.has(one.path)) targetTexts.push(bytes.toString('utf8'));
      if (one === target) targetBytes = bytes;
    } else if ((options.readers || stage === 'completion' || separateBaseline || activeScope) && one?.path) errors.push(`target missing: ${options.readers ? one.path : absolute(one.path)}`);
  }


  if (stage === 'pre-edit' && !['BASELINED', 'ADAPTED', 'VERIFIED'].includes(contract?.status)) errors.push('pre-edit requires BASELINED, ADAPTED, or VERIFIED status');
  if (stage === 'completion' && contract?.status !== 'VERIFIED') errors.push('completion requires VERIFIED status');

  if (contract?.mode === 'SOURCE_FIRST_PORT') {
    // The immutable baseline is the byte copy, either at the first target's historical path or at an explicitly
    // separate path. A separate artifact requires committed proof; its current bytes cannot stand in for history.
    const copyNow = targetBytes && multihash(targetBytes) === copied;
    if (separateBaseline && (!/^[0-9a-f]{7,64}$/.test(String(contract.baseline.commit ?? '')) || typeof options.readers?.targetAtCommit !== 'function')) {
      errors.push('baseline.path requires baseline.commit and a repository reader to verify its committed byte copy');
    } else if (contract?.baseline?.commit && options.readers?.targetAtCommit && baselinePath && (!separateBaseline || repositoryRelativePath(baselinePath))) {
      const atBaseline = options.readers.targetAtCommit(contract.baseline.commit, baselinePath, { followRenames: !separateBaseline });
      if (atBaseline === null) errors.push(`baseline.commit ${contract.baseline.commit} does not hold ${baselinePath}`);
      else if (multihash(atBaseline) !== copied) errors.push(`${baselinePath} at baseline.commit is not the source's bytes: the first commit of a port is the byte copy`);
    } else if (options.readers && source?.repository && !copyNow) {
      errors.push('baseline.commit must name the commit that holds the byte copy of the source');
    }
    if (options.readers && source?.repository && (contract?.baseline?.commit || copyNow)) {
      const history = options.readers.baselineHistory?.(contract?.baseline?.commit ?? 'HEAD', activeTargets.map((one) => one?.path).filter(repositoryRelativePath));
      if (!history) errors.push('baseline requires repository history proof before active adaptation');
      else {
        if (!history.ancestor) errors.push('baseline.commit must be an ancestor of the judged commit');
        if (history.allEarlierOrParallelContent !== true) errors.push('baseline requires complete earlier and parallel target history proof');
        const copies = new Set([copied, ...(fullSourceBaseline ? [source.multihash] : []), ...sources.slice(1).map((one) => one?.multihash)]);
        const sourcePaths = new Set(sources.map((one) => one?.path));
        const targetPaths = new Set(activeTargets.map((one) => one?.path));
        const sourceTargets = sources.map((one) => activeTargets.filter((target) => ownTargetIdentity(one, target?.path, options)));
        const mappedTargets = sourceTargets.flat().map((target) => target.path);
        const inPlaceClaim = sources.some((one, index) => one?.old_copy === 'same-file' || sourceTargets[index].length);
        const genuineInPlace = sources.length === sourcePaths.size && sources.length === activeTargets.length && targetPaths.size === sourcePaths.size
          && sourceTargets.every((targets) => targets.length === 1) && new Set(mappedTargets).size === activeTargets.length
          && options.policySince && sources.every((one) => sameRepository(one?.repository, options.repository)
            && one.commit === contract?.baseline?.commit && (one.old_copy === 'same-file' || one.old_copy === undefined)
            && options.readers.isAncestor?.(one.commit, options.policySince));
        if (inPlaceClaim && !genuineInPlace) errors.push('same-file provenance requires the complete original source/target set at a snapshot no later than policySince; mixed or post-policy self-sources cannot certify an imported adaptation');
        for (const one of history.targets) {
          const exact = (bytes) => bytes !== null && copies.has(multihash(bytes));
          const sameFile = genuineInPlace && one.atBaseline !== null && sources.some((source) => ownTargetIdentity(source, one.path, options)
            && source.multihash === multihash(one.atBaseline) && (source.old_copy === 'same-file' || source.old_copy === undefined));
          const initial = !contract?.baseline?.commit;
          const bytes = initial ? readTargetBytes(one.path, options) : one.atBaseline;
          const absentAtBaseline = !initial && bytes === null;
          const priorCopies = sameFile
            ? one.introductionsOrdered && Array.isArray(one.parallel) && one.parallel.every(exact)
            : Array.isArray(one.before) && one.before.every(exact);
          if (!priorCopies || (!absentAtBaseline && !exact(bytes))) {
            errors.push(`baseline must precede active adaptation: ${one.path} has prior or unrelated target history`);
          }
        }
      }
    }
  }
  // Retention is measured whenever both sides are readable, at any stage: it is what tells an adaptation from a rewrite.
  let retention = null;
  if (!ambiguousTargets && ['SOURCE_FIRST_PORT', 'BEHAVIORAL_PORT'].includes(contract?.mode) && sourceTexts.length && targetTexts.length) {
    const sourceLines = sourceTexts.flatMap(meaningfulLines);
    const targetSet = new Set(targetTexts.flatMap(meaningfulLines));
    const retained = sourceLines.filter((line) => targetSet.has(line)).length;
    const ratio = sourceLines.length ? retained / sourceLines.length : 1;
    const minimum = Number(contract?.proof?.minimum_meaningful_line_retention ?? 0);
    if (contract.mode === 'SOURCE_FIRST_PORT') {
      if (ratio < minimum) errors.push(`meaningful line retention ${ratio.toFixed(4)} below ${minimum.toFixed(4)}`);
      if (Number.isFinite(options.retentionAtLeast) && minimum < options.retentionAtLeast) {
        errors.push(`proof.minimum_meaningful_line_retention ${minimum} is below this repository's ${options.retentionAtLeast}`);
      }
    }
    for (const mechanism of contract?.proof?.required_mechanisms ?? []) {
      if (!targetTexts.some((text) => text.includes(mechanism))) errors.push(`required mechanism missing: ${mechanism}`);
    }
    retention = { sourceMeaningfulLines: sourceLines.length, retainedMeaningfulLines: retained, meaningfulLineRetention: ratio };
  }
  let visualMeasurements = null;
  if (contract?.mode === 'VISUAL_REPLICA') {
    visualMeasurements = validateVisualPixelLock(contract, stage, errors);
  }
  const search = noPriorOwner ? checkNoPriorOwner(contract, options, errors, deferred) : null;
  if (stage === 'completion' && !(contract?.proof?.test_refs?.length > 0)) errors.push('completion requires test refs');

  return {
    valid: errors.length === 0,
    errors,
    deferred,
    id: contract?.id ?? null,
    mode: contract?.mode ?? null,
    status: contract?.status ?? null,
    measurements: retention ?? visualMeasurements ?? search ?? null,
  };
}

function usage() {
  console.error('usage: validate-reference-adaptation-contract.mjs validate <contract.json> [--stage pre-edit|completion] [--target <path>]');
  process.exit(2);
}

if (import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  const [command, contractArg, ...rest] = process.argv.slice(2);
  if (command !== 'validate' || !contractArg) usage();
  const stageAt = rest.indexOf('--stage');
  const targetAt = rest.indexOf('--target');
  const options = {
    stage: stageAt >= 0 ? rest[stageAt + 1] : 'completion',
    target: targetAt >= 0 ? rest[targetAt + 1] : undefined,
  };
  try {
    const result = validateReferenceAdaptationContract(readJson(absolute(contractArg)), options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ valid: false, errors: [String(error?.message ?? error)] }, null, 2));
    process.exitCode = 1;
  }
}
