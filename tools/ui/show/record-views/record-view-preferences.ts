// A host supplies the account preference owner before drawing lists. Shared
// record views never import a host transport, so public views carry no account
// store. The signed-in host supplies its existing reactive, cross-device owner.
export type RecordViewPreferenceStore = {
  use: <T>(key: string) => T | null
  write: (key: string, value: unknown) => Promise<unknown>
}

let store: RecordViewPreferenceStore = {
  use: () => null,
  write: async () => { throw new Error('Saving view preferences is unavailable here.') },
}

export function keepRecordViewPreferencesIn(next: RecordViewPreferenceStore) { store = next }
/** A page with no account store (the members page, which keeps no saved configurations) keeps each list's view choices on the
 *  page itself: the choice is also kept on the device (the shared views' localStorage copy), so no save error is shown. */
export function keepRecordViewPreferencesOnThisPage() {
  const kept = new Map<string, unknown>()
  keepRecordViewPreferencesIn({ use: <T,>(key: string) => (kept.get(key) as T | undefined) ?? null, write: async (key, value) => { kept.set(key, value) } })
}
export function useRecordViewPreference<T>(key: string): T | null { return store.use<T>(key) }
export function writeRecordViewPreference(key: string, value: unknown): Promise<unknown> { return store.write(key, value) }
