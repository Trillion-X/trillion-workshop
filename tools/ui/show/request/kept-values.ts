// parts/ui/show/request/kept-values.ts
//
// Purpose
//   Keeps the last answer to a question on this computer's disk (IndexedDB),
//   so a surface can paint what it last knew the instant it opens and then
//   bring that up to date in the background. A list of twenty thousand records
//   reopens in the time it takes to read one value, never in the time it takes
//   to ask for it again.
//
// Non-negotiable invariants
//   - A value is kept as one string under one key: reading it back is a single
//     read plus one JSON.parse, never a walk over per-record rows.
//   - Nothing here decides what is fresh. The caller stores whatever revision
//     its owner reported alongside the value and sends it back to be compared.
//   - Storage that is missing or refused (a private window, a full disk) makes
//     every read answer "nothing kept" and every write a no-op; the surface
//     then simply asks its owner, as it would on first use.
//   - Given a `key` (32 bytes, base64url), every value is sealed with AES-GCM
//     under it before it touches the disk, with a fresh 12-byte nonce per
//     write. A value that does not open under the key given (kept under
//     another key, or altered) reads as nothing kept. The key is the caller's:
//     a key that lives only as long as a sign-in makes what was kept under it
//     unreadable once that sign-in ends, even if the files stay behind.
//   - The store opens and its key is made as soon as it is created, so the first read is one read.
//   - An open never waits for ever: another tab holding the store (a stuck tab, an upgrade it will not let go) makes the
//     open give up after kept-values.json `open_timeout_ms`, which reads as "nothing kept" like any refused storage, so a
//     surface asks its owner instead of showing a frozen loading screen. The reason is recorded (`keptValuesProblems`),
//     and a late success after giving up is closed again.
//   - Nothing kept lasts for ever: a value not read for `idle_evict_ms` or written longer ago than `age_evict_ms` is dropped by a
//     sweep once per page, then the least recently used past `entries_most`; a read marks its value used at most every
//     `touch_after_ms`. A value written `unsynced` (the only copy of something not yet sent) is never dropped.
//   - A value is kept with the build's row layout (kept-values.json `schema`) and, when the writer names one, the role it
//     was kept for (a member type, an access level). A read that names a role gets nothing from a value kept for another
//     role, so a person whose role changed never paints what the old role could see; a value kept under another `schema`
//     reads as nothing kept and the sweep drops it (never an `unsynced` one: it is the only copy). Rows an earlier build wrote,
//     with no layout or role marked, still read.
//   - `forgetKeptValues` deletes whole stores by name, so one person's kept
//     answers can be removed from a shared computer without reading them.

import settings from './kept-values.json' with { type: 'json' }

/** Stores that could not be opened, newest last: which store, why, and when. */
const problems: { name: string; reason: string; at: number }[] = []
export const keptValuesProblems = (): readonly { name: string; reason: string; at: number }[] => problems

export type KeptWriteOptions = { unsynced?: boolean; role?: string }
export type KeptReadOptions = { role?: string }
export type KeptValues = {
  /** The kept value, or null when none, when it was kept under another layout, or when `role` is named and it was kept for another. */
  read: <T>(key: string, options?: KeptReadOptions) => Promise<T | null>
  write: (key: string, value: unknown, options?: KeptWriteOptions) => Promise<void>
  /** Drops the values idle or old past kept-values.json, then the least recently used past `entries_most` (never an
   *  unsynced one); how many left. */
  sweep: () => Promise<number>
}

const STORE = 'values'
type Meta = { at: number; since: number; unsynced?: true; schema?: number; role?: string }
type Sealed = { iv: Uint8Array; sealed: ArrayBuffer } & Partial<Meta>
type Plain = { text: string } & Partial<Meta>

const metaOf = (row: unknown): (Meta & { unsynced: boolean }) | null => {
  if (!row || typeof row !== 'object') return null
  const { at, since, unsynced } = row as Partial<Meta>
  return typeof at === 'number' && typeof since === 'number' ? { at, since, unsynced: unsynced === true } : null
}
// Whether a row may be read as the layout of this build, and for the asker's role (rows with no mark of either read as before).
const readableAs = (row: unknown, role: string | undefined): boolean => {
  if (!row || typeof row !== 'object') return true
  const { schema, role: keptFor } = row as Partial<Meta>
  return (schema === undefined || schema === settings.schema) && (role === undefined || keptFor === undefined || keptFor === role)
}
// A row marked as used now; a row an earlier version wrote (the JSON text itself, or no marks) starts its marks now.
const stamped = (row: unknown, now: number): Sealed | Plain => {
  const meta = metaOf(row)
  const marks = { at: now, since: meta?.since ?? now, ...(meta?.unsynced ? { unsynced: true as const } : {}) }
  return typeof row === 'string' ? { text: row, ...marks } : { ...(row as Sealed | Plain), ...marks }
}

const bytesOf = (base64url: string) => Uint8Array.from(atob(base64url.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0))

export function createKeptValues(name: string, options: { key?: string } = {}): KeptValues {
  let opening: Promise<IDBDatabase | null> | null = null
  const open = () => opening ??= new Promise<IDBDatabase | null>(resolve => {
    let gaveUp = false
    const giveUp = (reason: string) => { if (gaveUp) return; gaveUp = true; problems.push({ name, reason, at: Date.now() }); resolve(null) }
    const timer = setTimeout(() => giveUp('open_timed_out'), settings.open_timeout_ms)
    try {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE) }
      request.onsuccess = () => { clearTimeout(timer); if (gaveUp) request.result.close(); else resolve(request.result) }
      request.onerror = () => { clearTimeout(timer); giveUp('open_failed') }
      request.onblocked = () => { clearTimeout(timer); giveUp('open_blocked') }
    } catch { clearTimeout(timer); giveUp('open_refused') }
  })
  let sealing: Promise<CryptoKey | null> | null = null
  const sealKey = () => sealing ??= options.key
    ? crypto.subtle.importKey('raw', bytesOf(options.key), 'AES-GCM', false, ['encrypt', 'decrypt']).catch(() => null)
    : Promise.resolve(null)
  const run = <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest | null): Promise<T | null> =>
    open().then(database => new Promise<T | null>(resolve => {
      if (!database) return resolve(null)
      try {
        const transaction = database.transaction(STORE, mode)
        const request = act(transaction.objectStore(STORE))
        transaction.oncomplete = () => resolve((request?.result as T | undefined) ?? null)
        transaction.onerror = () => resolve(null)
        transaction.onabort = () => resolve(null)
      } catch { resolve(null) }
    }))
  // A sealed store holds { iv, sealed } per key; an unsealed one holds the JSON text itself.
  async function textOf(kept: unknown): Promise<string | null> {
    if (!options.key) {
      if (typeof kept === 'string') return kept
      const text = (kept as Plain | null)?.text
      return typeof text === 'string' ? text : null
    }
    const key = await sealKey()
    const sealed = kept as Sealed | null
    if (!key || !sealed || !(sealed.iv instanceof Uint8Array) || !(sealed.sealed instanceof ArrayBuffer)) return null
    try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.sealed)) } catch { return null }
  }
  async function keptOf(text: string, now: number, unsynced: boolean, role: string | undefined): Promise<Sealed | Plain | null> {
    const meta = { at: now, since: now, schema: settings.schema, ...(role === undefined ? {} : { role }), ...(unsynced ? { unsynced: true as const } : {}) }
    if (!options.key) return { text, ...meta }
    const key = await sealKey()
    if (!key) return null
    const iv = crypto.getRandomValues(new Uint8Array(12))
    return { iv, sealed: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)), ...meta }
  }
  // Marks a value as used now, in the same transaction that reads it, so a write made meanwhile is never overwritten.
  const touch = (key: string, now: number) => void run('readwrite', store => {
    const request = store.get(key)
    request.onsuccess = () => { if (request.result !== undefined) store.put(stamped(request.result, now), key) }
    return request
  })
  // Idle or old values go, then the least recently used past the count; a value written with `unsynced` is the only copy
  // of something not yet sent and is never dropped. Rows are walked by cursor and their content is never opened.
  async function sweep(): Promise<number> {
    const now = Date.now()
    const live: Array<{ key: IDBValidKey; at: number }> = []
    let dropped = 0
    await run('readwrite', store => {
      const request = store.openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          const over = live.length - settings.entries_most
          if (over > 0) for (const { key } of live.sort((left, right) => left.at - right.at).slice(0, over)) { store.delete(key); dropped += 1 }
          return
        }
        const meta = metaOf(cursor.value)
        if (!meta) { cursor.update(stamped(cursor.value, now)); live.push({ key: cursor.key, at: now }) }
        else if (!meta.unsynced) {
          if (!readableAs(cursor.value, undefined) || now - meta.at > settings.idle_evict_ms || now - meta.since > settings.age_evict_ms) { cursor.delete(); dropped += 1 }
          else live.push({ key: cursor.key, at: meta.at })
        }
        cursor.continue()
      }
      return request
    })
    return dropped
  }
  // The store is opened and the key made as the store is created, so the first read pays neither.
  void open().then(database => {
    if (!database) return
    const timer = setTimeout(() => void sweep(), settings.sweep_after_ms)
    ;(timer as { unref?: () => void }).unref?.()
  })
  void sealKey()
  return {
    async read<T>(key: string, reading: KeptReadOptions = {}) {
      const row = await run<unknown>('readonly', store => store.get(key))
      if (!readableAs(row, reading.role)) return null
      const text = await textOf(row)
      if (text === null) return null
      const now = Date.now()
      const meta = metaOf(row)
      if (!meta || now - meta.at > settings.touch_after_ms) touch(key, now)
      try { return JSON.parse(text) as T } catch { return null }
    },
    async write(key: string, value: unknown, writing: KeptWriteOptions = {}) {
      const kept = await keptOf(JSON.stringify(value), Date.now(), writing.unsynced === true, writing.role)
      if (kept !== null) await run('readwrite', store => store.put(kept, key))
    },
    sweep,
  }
}

/** Deletes every store of kept values on this computer whose name `drop` accepts. A browser that cannot list its
 *  stores deletes nothing. */
export async function forgetKeptValues(drop: (name: string) => boolean): Promise<void> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return
  const stores = await indexedDB.databases().catch(() => [])
  await Promise.all(stores.filter(store => store.name && drop(store.name)).map(store => new Promise<void>(done => {
    try {
      const request = indexedDB.deleteDatabase(store.name as string)
      request.onsuccess = request.onerror = request.onblocked = () => done()
    } catch { done() }
  })))
}
