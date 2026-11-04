import { identityOfValue, readSavedRecordFromOwner, sendRequestToBitfieldTarget } from '#workspace-records';
import type { LayoutState } from '../read-data/layout-types';

const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
const ENGINE_WRITE_BATCH_OPERATION = 'engine.operation.write-batch';
const PUBLISHED_RECORD_PATH = ['current-item', 'published-record'] as const;
export const TOP_LEVEL_LAYOUT_STATE_VALUE_ADDRESS_LABEL = 'screen-arrangement-layout-state';

export type EngineLayoutStatePersistence = {
  mode?: 'shared-engine';
  valueAddressLabel: string;
  path?: readonly string[];
  addressMode?: string;
};

export type BrowserLocalLayoutStateScope = {
  applicationRef: string;
  browserContextRef: string;
  accountRef: string;
};

export type BrowserLocalLayoutStatePersistence = {
  mode: 'browser-local';
  scope: BrowserLocalLayoutStateScope;
  storage: Storage;
  eventTarget: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  writerRef: string;
  storageKey: string;
  /**
   * When a write happens, supplied by whoever created this handle. This module is
   * browser-local code, but it is reachable from the layout-state contribution
   * DERIVATION through read-screen-arrangement, and a derivation may not read a
   * clock. The surface that creates the handle is entitled to read one, so the
   * value arrives with the handle instead of being taken here.
   */
  readWriteTimeMs: () => number;
};

export type UnavailableBrowserLocalLayoutStatePersistence = {
  mode: 'browser-local-unavailable';
};

export type LayoutStatePersistence =
  | EngineLayoutStatePersistence
  | BrowserLocalLayoutStatePersistence
  | UnavailableBrowserLocalLayoutStatePersistence;

export const BROWSER_LOCAL_LAYOUT_STATE_UNAVAILABLE = {
  mode: 'browser-local-unavailable',
} satisfies UnavailableBrowserLocalLayoutStatePersistence;

export type BrowserLocalLayoutStateRecord = {
  kind: 'screen-arrangement.browser-layout-state';
  revision: number;
  writtenAt: number;
  writerRef: string;
  state: LayoutState;
};

export const TOP_LEVEL_LAYOUT_STATE_PERSISTENCE = {
  valueAddressLabel: TOP_LEVEL_LAYOUT_STATE_VALUE_ADDRESS_LABEL,
  path: PUBLISHED_RECORD_PATH,
  // The engine's default write address mode wrote a DIFFERENT cell than the
  // entry data-input reads (label_hash), so every persisted layout change —
  // decoration AND tab order — was saved to a cell the next load ignored,
  // reverting on reload. Pin the write mode to the read mode so save and load
  // address the SAME cell (SSOT).
  addressMode: 'label_hash',
} satisfies EngineLayoutStatePersistence;

/**
 * The same arrangement record, kept apart under a key: the copy a limited view (a show rule passing arrangement limits)
 * saves while it is in force, so the person's full saved arrangement is never overwritten by the limited one, and each
 * comes back where it was left. The key is the id of the rule in force; one record kind, one save path.
 */
export function keyedLayoutStatePersistence(persistence: LayoutStatePersistence, key: string): LayoutStatePersistence {
  const suffix = `~${encodeURIComponent(key)}`;
  if (persistence.mode === 'browser-local-unavailable') return persistence;
  if (persistence.mode === 'browser-local') return { ...persistence, storageKey: `${persistence.storageKey}${suffix}` };
  return { ...persistence, valueAddressLabel: `${persistence.valueAddressLabel}${suffix}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function uniqueCells(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizedScopePart(value: string): string {
  return encodeURIComponent(value.trim());
}

function readBrowserStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    if (
      !storage
      || typeof storage.getItem !== 'function'
      || typeof storage.setItem !== 'function'
    ) return null;
    return storage;
  } catch {
    return null;
  }
}

export function browserLocalLayoutStateStorageKey(scope: BrowserLocalLayoutStateScope): string {
  return [
    'bitfield.screen-arrangement.browser-layout-state',
    normalizedScopePart(scope.applicationRef),
    normalizedScopePart(scope.browserContextRef),
    normalizedScopePart(scope.accountRef),
  ].join('::');
}

export function createBrowserLocalLayoutStatePersistence(
  scope: BrowserLocalLayoutStateScope,
  options: {
    storage?: Storage | null;
    eventTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
    // Both required. The caller is a browser surface, which is entitled to read a
    // clock and mint an id; this module is not, because a derivation reaches it.
    writerRef: string;
    readWriteTimeMs: () => number;
  },
): BrowserLocalLayoutStatePersistence | null {
  const storage = options.storage === undefined ? readBrowserStorage() : options.storage;
  const eventTarget = options.eventTarget === undefined
    ? (typeof globalThis.addEventListener === 'function' ? globalThis : null)
    : options.eventTarget;
  if (!storage || !eventTarget) return null;
  if (Object.values(scope).some((value) => !value.trim())) return null;
  return {
    mode: 'browser-local',
    scope,
    storage,
    eventTarget,
    writerRef: options.writerRef.trim(),
    readWriteTimeMs: options.readWriteTimeMs,
    storageKey: browserLocalLayoutStateStorageKey(scope),
  };
}

export function isBrowserLocalLayoutStatePersistence(
  persistence: LayoutStatePersistence | undefined,
): persistence is BrowserLocalLayoutStatePersistence {
  return persistence?.mode === 'browser-local';
}

export function isUnavailableBrowserLocalLayoutStatePersistence(
  persistence: LayoutStatePersistence | undefined,
): persistence is UnavailableBrowserLocalLayoutStatePersistence {
  return persistence?.mode === 'browser-local-unavailable';
}

function decodeBrowserLocalLayoutStateRecord(raw: string | null): BrowserLocalLayoutStateRecord | null {
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as Partial<BrowserLocalLayoutStateRecord>;
    if (
      record.kind !== 'screen-arrangement.browser-layout-state'
      || !Number.isSafeInteger(record.revision)
      || typeof record.writtenAt !== 'number'
      || typeof record.writerRef !== 'string'
      || !isRecord(record.state)
    ) return null;
    return record as BrowserLocalLayoutStateRecord;
  } catch {
    return null;
  }
}

export function readBrowserLocalLayoutState(
  persistence: BrowserLocalLayoutStatePersistence,
): BrowserLocalLayoutStateRecord | null {
  try {
    return decodeBrowserLocalLayoutStateRecord(persistence.storage.getItem(persistence.storageKey));
  } catch {
    return null;
  }
}

export function writeBrowserLocalLayoutState(
  state: LayoutState,
  persistence: BrowserLocalLayoutStatePersistence,
): BrowserLocalLayoutStateRecord | null {
  try {
    const previous = readBrowserLocalLayoutState(persistence);
    const record: BrowserLocalLayoutStateRecord = {
      kind: 'screen-arrangement.browser-layout-state',
      revision: (previous?.revision ?? 0) + 1,
      writtenAt: persistence.readWriteTimeMs(),
      writerRef: persistence.writerRef,
      state,
    };
    persistence.storage.setItem(persistence.storageKey, JSON.stringify(record));
    return record;
  } catch {
    return null;
  }
}

export function subscribeBrowserLocalLayoutState(
  persistence: BrowserLocalLayoutStatePersistence,
  onRecord: (record: BrowserLocalLayoutStateRecord | null) => void,
): () => void {
  const onStorage = (event: Event) => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key !== persistence.storageKey) return;
    onRecord(decodeBrowserLocalLayoutStateRecord(storageEvent.newValue));
  };
  persistence.eventTarget.addEventListener('storage', onStorage);
  return () => persistence.eventTarget.removeEventListener('storage', onStorage);
}

export function readLayoutStateChangedCells(publication: unknown): string[] | null {
  if (!isRecord(publication)) return null;
  if (publication.mode === 'noop') return [];
  if (publication.mode === 'full') return null;
  if (publication.mode !== 'delta' || !isRecord(publication.delta)) return null;
  const changedCells = publication.delta.changedCells;
  if (!Array.isArray(changedCells)) return null;
  if (!changedCells.every((cell): cell is string => typeof cell === 'string' && cell.length > 0)) {
    return null;
  }
  return uniqueCells(changedCells);
}

export async function writeLayoutState(state: LayoutState): Promise<unknown> {
  return writeLayoutStateValue(state, TOP_LEVEL_LAYOUT_STATE_PERSISTENCE);
}

export function buildLayoutStateWriteRequest(
  state: LayoutState,
  persistence: EngineLayoutStatePersistence = TOP_LEVEL_LAYOUT_STATE_PERSISTENCE,
  expectedIdentity?: string | null,
) {
  return {
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: ENGINE_WRITE_BATCH_OPERATION,
      writes: [
        {
          address_label: persistence.valueAddressLabel,
          ...(persistence.addressMode ? { address_mode: persistence.addressMode } : {}),
          path_labels: [...(persistence.path ?? PUBLISHED_RECORD_PATH)],
          payload: state,
          ...(expectedIdentity !== undefined ? { expected_identity: expectedIdentity } : {}),
        },
      ],
    },
  };
}

export function layoutStateWriteRefused(reply: unknown): boolean {
  const bytes = (reply as { payload?: unknown } | null)?.payload;
  if (!(bytes instanceof Uint8Array)) return false;
  try {
    return (JSON.parse(new TextDecoder().decode(bytes)) as { written?: unknown }).written === 0;
  } catch {
    return false;
  }
}

export const layoutStateIdentity = (state: LayoutState): string => identityOfValue(state);

export async function writeLayoutStateValue(
  state: LayoutState,
  persistence: EngineLayoutStatePersistence = TOP_LEVEL_LAYOUT_STATE_PERSISTENCE,
  expectedIdentity?: string | null,
): Promise<unknown> {
  return sendRequestToBitfieldTarget(buildLayoutStateWriteRequest(state, persistence, expectedIdentity));
}

export async function writeLayoutStateDelta(
  state: LayoutState,
  changedCells: string[],
): Promise<boolean> {
  if (changedCells.length === 0) return true;
  await writeLayoutStateValue(state, TOP_LEVEL_LAYOUT_STATE_PERSISTENCE);
  return true;
}

/** What is kept at a persistence now, read from its owner (never this page's cache), or null when nothing is: the
 *  stored value for the person's store, the stored state for a browser-held layout. */
export async function readKeptLayoutValue(persistence: LayoutStatePersistence): Promise<unknown> {
  if (persistence.mode === 'browser-local-unavailable') return null;
  if (persistence.mode === 'browser-local') return readBrowserLocalLayoutState(persistence)?.state ?? null;
  const kept = await readSavedRecordFromOwner(persistence.valueAddressLabel);
  return kept.found ? kept.value ?? null : null;
}
