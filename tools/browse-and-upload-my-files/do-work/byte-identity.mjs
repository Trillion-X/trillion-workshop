// One streaming identity interface for native and compiled hosts. The host selects
// its implementation; file identities remain ordinary unkeyed BLAKE3 hex.
let compiledFactory = null;

export function useCompiledByteIdentity(factory) {
  if (typeof factory !== 'function') throw new TypeError('A byte identity factory is required.');
  compiledFactory = factory;
}

/** The host's compiled byte identity, made now, or null where the host installed none: for a synchronous digest that
 *  must not wait (src/decision-store.mjs identityOf). Its caller frees it. */
export function compiledByteIdentityNow() {
  return compiledFactory ? compiledFactory() : null;
}

// Without a compiled host, the identity is the Workshop's one BLAKE3 owner (tools/content-identity); `hex` is asked once,
// after the last update, as every caller does.
export async function createByteIdentity() {
  if (compiledFactory) return compiledFactory();
  const { makeHashCodeHasher } = await import('../../content-identity/read-data/identity.mjs');
  const digest = makeHashCodeHasher();
  return {
    update: bytes => digest.update(bytes),
    hex: () => digest.identity().slice(3),
    free: () => {},
  };
}

// A file identity streamed through the host's byte identity, fed a window at a time so compiled memory grows by one
// window, never by the whole input. `finish` answers `1f:` + hex and frees it; `free` frees it unanswered.
const WINDOW = 1024 * 1024;

export async function startFileIdentity() {
  const digest = await createByteIdentity();
  let open = true;
  const free = () => { if (open) { open = false; digest.free(); } };
  return {
    update(bytes) { for (let at = 0; at < bytes.byteLength; at += WINDOW) digest.update(bytes.subarray(at, at + WINDOW)); },
    finish() { try { return `1f:${digest.hex()}`; } finally { free(); } },
    free,
  };
}

export async function fileIdentityOf(bytes) {
  const identity = await startFileIdentity();
  try { identity.update(bytes); return identity.finish(); } finally { identity.free(); }
}

/** The same byte-identity owner for an explicit UTF-8 text value. */
export async function textIdentity({ text } = {}) {
  if (typeof text !== 'string') throw new TypeError('Text identity requires an explicit text value.');
  const digest = await createByteIdentity();
  try {
    digest.update(new TextEncoder().encode(text));
    return { identity: `1f:${digest.hex()}` };
  } finally { digest.free(); }
}
