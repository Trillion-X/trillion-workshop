// tools/paid-access/read-data/object-store-map.ts
//
// The AUTHORITY row (the person's `paid-file` record) that binds a private `object_key` to:
//   - the stored bytes it resolves to (`cas_hash`),
//   - the at-rest encryption of those bytes (`enc_alg` + `enc_nonce`, and the NAME of the key, `enc_key_ref`), and
//   - the access refs the OBJECT ITSELF requires (`required_access_refs`).
//
// WHY required refs live HERE (with the bytes), not as a request parameter:
//   If a caller could supply "which access this object needs", a buyer of a free item could pair their access with
//   a paid file's `object_key` and pass the gate. The gate must be a property of the OBJECT. A buyer only ever names
//   an `object_key`; the refs and the hash are read from this record.
//
// WHY the row names its key and never holds it (changed from the package, which kept `enc_key` in the row): a row is
// readable by every tool given the records right, it travels in answers and it is kept in history. The key value lives
// with the person's held values; the row carries `enc_key_ref`, the key's name, and only the door that streams the
// bytes is handed the value, on a private pipe, at the moment it decrypts.
//
// This is generic: ANY private file is one row here. `object_key`/`object_store_ref` are the only nouns.
//
// MACHINE-READABLE: every field is explicit and typed; `required_access_refs` is an
// array, nothing is packed into a delimited string.

/** One private object's authority row. */
export type ObjectStoreEntry = {
  /** Logical key the file is asked for by (e.g. "chapter-one.pdf"). */
  object_key: string;
  /** Logical store the key lives in (audit/label only; bytes resolve via cas_hash). */
  object_store_ref: string;
  /** Content hash the shell streams. The bytes at this hash are CIPHERTEXT when
   *  `enc_alg` is set (so a public `/cas/<hash>` leak is inert). */
  cas_hash: string;
  /** The NAME of the at-rest decryption key in the person's held values, never the key. Absent → plaintext. */
  enc_key_ref?: string;
  /** Cipher nonce/IV paired with the encryption key. */
  enc_nonce?: string;
  /** DATA-selected cipher capability id (e.g. "aes-256-ctr"). Absent → plaintext.
   *  The shell selects the cipher from a capability map keyed by this — never a
   *  hardcoded branch, so a new cipher is one capability registration. */
  enc_alg?: string;
  /** Access refs the OBJECT requires (ANY-of). Empty → ungated (a public object
   *  would not take the private path, but an empty gate is honored as public). */
  required_access_refs: string[];
  /** Content type the shell serves for these bytes. */
  mime?: string;
  /** Lease lifetime in seconds for this object (URL-hygiene upper bound; live
   *  entitlement is the real authority). Absent → caller's configured default. */
  ttl_seconds?: number;
};

type RecordSource = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = str(item);
    if (s) out.push(s);
  }
  return out;
}

function toEntry(value: unknown): ObjectStoreEntry | null {
  if (!isRecord(value)) return null;
  const objectKey = str(value.object_key);
  if (!objectKey) return null;
  const casHash = str(value.cas_hash);
  const ttl = value.ttl_seconds;
  return {
    object_key: objectKey,
    object_store_ref: str(value.object_store_ref),
    cas_hash: casHash,
    enc_key_ref: str(value.enc_key_ref) || undefined,
    enc_nonce: str(value.enc_nonce) || undefined,
    enc_alg: str(value.enc_alg) || undefined,
    required_access_refs: strArray(value.required_access_refs),
    mime: str(value.mime) || undefined,
    ttl_seconds: typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : undefined,
  };
}

/** All object authority rows from the map record (accepts `{records:[...]}`,
 *  `{entries:[...]}`, or a bare array). Malformed rows are dropped, never guessed. */
export function readObjectStoreEntries(source: RecordSource): ObjectStoreEntry[] {
  const rows = Array.isArray(source)
    ? source
    : isRecord(source)
      ? (Array.isArray(source.records) ? source.records
        : Array.isArray(source.entries) ? source.entries
          : [])
      : [];
  const out: ObjectStoreEntry[] = [];
  for (const row of rows) {
    const entry = toEntry(row);
    if (entry) out.push(entry);
  }
  return out;
}

/** The authority row for one `object_key`, or undefined if not present. */
export function findObjectStoreEntry(source: RecordSource, objectKey: string): ObjectStoreEntry | undefined {
  const key = str(objectKey);
  if (!key) return undefined;
  return readObjectStoreEntries(source).find((entry) => entry.object_key === key);
}
