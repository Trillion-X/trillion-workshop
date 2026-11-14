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
export function useRecordViewPreference<T>(key: string): T | null { return store.use<T>(key) }
export function writeRecordViewPreference(key: string, value: unknown): Promise<unknown> { return store.write(key, value) }
