// Purpose: resolve one content identity to bytes by trying its `live-namespace.locator` rows in order. This is the
// second reader of the locator contract (the engine's CAS-miss arm in background-runner is the first), so any host
// that can run JavaScript resolves an identity without a running Bitfield engine: a hosted Worker, a desktop app's
// server, a command-line agent.
//
// Non-negotiable invariants:
// - The resolver never reads `target` or `request` for meaning. A row names a target; the caller hands in the
//   readers it can run as a map of target name -> read function. No protocol, vendor, path or product name appears
//   here, and adding a source is one locator row plus, at most, one reader in the host that owns that transport.
// - The resolver owns the QUANTITIES of a window (offset, length, end_inclusive) and never how a source SPELLS them:
//   a row says it with `range_keys` (numbers at named keys) or `range_render` (one formatted value at a key path).
//   Exactly one of the two, as the package contract requires.
// - No read is unbounded. A window is at most `maxWindowBytes`; a longer span is read as successive windows, so a
//   54 GB file costs the same memory as a 54 KB one.
// - A source that returns a different byte count than asked for fails closed for that row, and the next row is
//   tried. A row marked `available: false` is skipped. Rows are tried by ascending `priority` (absent = last),
//   keeping their given order on ties.
// - When every row fails, the error names each target tried and why, so "not found" and "unreachable" stay distinct.

const DEFAULT_WINDOW_BYTES = 8 * 1024 * 1024;

function substitute(template, window) {
  const values = { offset: window.offset, length: window.length, end_inclusive: window.offset + window.length - 1 };
  return template.replace(/\{(offset|length|end_inclusive)\}/g, (_, name) => String(values[name]));
}

function setAt(target, path, value) {
  let cursor = target;
  for (const key of path.slice(0, -1)) {
    if (cursor[key] === null || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[path.at(-1)] = value;
}

// The request a row's target receives for one window. The row is never mutated.
export function renderLocatorRequest(locator, window) {
  const hasKeys = locator.range_keys && typeof locator.range_keys === 'object';
  const hasRender = locator.range_render && typeof locator.range_render === 'object';
  if (hasKeys === hasRender) throw new Error('A locator names exactly one of range_keys or range_render.');
  const request = structuredClone(locator.request ?? {});
  if (hasKeys) {
    request[locator.range_keys.offset] = window.offset;
    request[locator.range_keys.length] = window.length;
  } else {
    const { target_path: path, template } = locator.range_render;
    if (!Array.isArray(path) || !path.length || typeof template !== 'string') throw new Error('range_render needs target_path and template.');
    setAt(request, path, substitute(template, window));
  }
  return request;
}

function decodePointer(value, pointer) {
  if (!pointer) return value;
  return pointer.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((node, key) => node?.[key], value);
}

// A reader's reply as bytes, decoded as the row declares.
function replyBytes(locator, reply) {
  if ((locator.response_encoding ?? 'payload-is-the-bytes') === 'payload-is-the-bytes') {
    if (locator.response_bytes_pointer) throw new Error('payload-is-the-bytes rows carry no response pointer.');
    return reply instanceof Uint8Array ? reply : new Uint8Array(reply);
  }
  if (locator.response_encoding === 'base64') {
    const text = decodePointer(reply, locator.response_bytes_pointer ?? '');
    if (typeof text !== 'string') throw new Error('The reply has no base64 text at the declared pointer.');
    return Uint8Array.from(atob(text), character => character.charCodeAt(0));
  }
  throw new Error(`Unknown response encoding ${locator.response_encoding}.`);
}

// Rows in the order they are tried.
export function orderLocators(locators) {
  return locators
    .map((locator, index) => ({ locator, index }))
    .filter(({ locator }) => locator && locator.available !== false)
    .sort((left, right) => (left.locator.priority ?? Infinity) - (right.locator.priority ?? Infinity) || left.index - right.index)
    .map(({ locator }) => locator);
}

// One window of an identity. Returns { bytes, locator, byte_length, attempts }.
export async function readIdentityWindow({ locators, readers, offset, length }) {
  const attempts = [];
  for (const locator of orderLocators(locators)) {
    const read = readers[locator.target];
    if (typeof read !== 'function') { attempts.push({ target: locator.target, error: 'no reader here' }); continue; }
    const total = Number(locator.byte_length);
    if (!Number.isSafeInteger(total) || total < 0) { attempts.push({ target: locator.target, error: 'the row has no byte_length' }); continue; }
    if (offset >= total && total > 0) throw new RangeError(`Offset ${offset} is past the end (${total} bytes).`);
    const window = { offset, length: Math.min(length, total - offset) };
    if (window.length <= 0) return { bytes: new Uint8Array(0), locator, byte_length: total, attempts };
    try {
      const bytes = replyBytes(locator, await read(renderLocatorRequest(locator, window), window));
      if (bytes.byteLength !== window.length) throw new Error(`returned ${bytes.byteLength} bytes for a ${window.length}-byte window`);
      return { bytes, locator, byte_length: total, attempts };
    } catch (error) {
      attempts.push({ target: locator.target, error: String(error?.message ?? error) });
    }
  }
  const error = new Error(attempts.length
    ? `No location could supply these bytes: ${attempts.map(item => `${item.target} (${item.error})`).join('; ')}`
    : 'No location is known for these bytes.');
  error.attempts = attempts;
  error.code = attempts.length ? 'NAMESPACE_UNREACHABLE' : 'NAMESPACE_NOT_FOUND';
  throw error;
}

// Every byte from `start` to `end` inclusive, as successive bounded windows. Each window re-picks its location, so a
// drive unplugged mid-read continues from the next location that has the bytes.
export async function* streamIdentity({ locators, readers, start = 0, end = null, maxWindowBytes = DEFAULT_WINDOW_BYTES }) {
  const total = Math.max(...orderLocators(locators).map(locator => Number(locator.byte_length)).filter(Number.isSafeInteger), -1);
  if (total < 0) throw Object.assign(new Error('No location is known for these bytes.'), { code: 'NAMESPACE_NOT_FOUND' });
  const last = end === null ? total - 1 : Math.min(end, total - 1);
  for (let offset = start; offset <= last; offset += maxWindowBytes) {
    const { bytes } = await readIdentityWindow({ locators, readers, offset, length: Math.min(maxWindowBytes, last - offset + 1) });
    yield bytes;
  }
}

// The known byte length of an identity from its rows, or null.
export function identityByteLength(locators) {
  const lengths = orderLocators(locators).map(locator => Number(locator.byte_length)).filter(Number.isSafeInteger);
  return lengths.length ? lengths[0] : null;
}
