//
// Reads selectable local file roots as a DATA-driven feed: a
// `local-root-shortcut` descriptor row (kind, label, path) can be authored to
// add, rename, or remove a root shortcut with zero code change. The 6
// existing shortcuts ship as fallback DATA (used only when no
// `local-root-shortcut` rows exist yet), never as a closed code-owned enum.
// Mounted volumes (/Volumes) and cloud-storage providers
// (~/Library/CloudStorage) are discovered dynamically and merged in, since
// their identity is assigned by the OS/user at mount time, not authorable
// as a DATA row ahead of time.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { invokeLocalFilesTarget } from './invoke-local-files-target.ts';

const LOCAL_ROOT_SHORTCUT_KIND = 'local-root-shortcut';

export async function getLocalDevRootPath(): Promise<string> {
  return `${await getLocalHomeRootPath()}/dev`;
}

export async function getLocalHomeRootPath(): Promise<string> {
  const result = await invokeLocalFilesTarget({ operation: 'roots' });
  if (typeof result.home !== 'string' || result.home.length === 0) {
    throw new Error('local.files returned no home directory.');
  }
  return result.home;
}

export interface LocalRootShortcut {
  label: string;
  path: string;
}

// ---------------------------------------------------------------------------
// DATA-ROW DECODE
// ---------------------------------------------------------------------------
// These helpers are deliberately duplicated from
// command-palette/do-work/ask-palette-sources-by-text.ts's convention rather
// than imported -- a read-data role file in this package must never import
// another package's UI/do-work internals.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBytes(value: unknown): value is ArrayBufferView {
  // NOTE: `instanceof Uint8Array` is unsafe across a realm/worker boundary
  // (proven under vitest workers) — constructor.name matches but the class
  // object differs, so `instanceof` silently fails. `ArrayBuffer.isView` is
  // realm-safe.
  return ArrayBuffer.isView(value);
}

function decodeReplyPayload(reply: unknown): unknown {
  if (!isRecord(reply)) return null;
  const payload = (reply as { payload?: unknown }).payload;
  if (!isBytes(payload)) return payload ?? null;
  const bytes = payload instanceof Uint8Array
    ? payload
    : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function flattenRow(row: unknown): Record<string, unknown> {
  if (!isRecord(row)) return {};
  const attributeFacts = isRecord(row.attribute_facts) ? row.attribute_facts : {};
  const payload = isRecord(row.payload) ? row.payload : {};
  return { ...row, ...attributeFacts, ...payload };
}

function readRows(decoded: unknown): unknown[] {
  if (Array.isArray(decoded)) return decoded;
  if (isRecord(decoded) && Array.isArray(decoded.items)) return decoded.items;
  if (isRecord(decoded) && Array.isArray(decoded.rows)) return decoded.rows;
  return [];
}

function readLocalRootShortcutDescriptorsFromReply(reply: unknown): LocalRootShortcut[] {
  const decoded = decodeReplyPayload(reply);
  const rows = readRows(decoded);
  const shortcuts: LocalRootShortcut[] = [];
  for (const row of rows) {
    const flat = flattenRow(row);
    if (flat.kind !== LOCAL_ROOT_SHORTCUT_KIND) continue;
    if (typeof flat.label !== 'string' || typeof flat.path !== 'string') continue;
    shortcuts.push({ label: flat.label, path: flat.path });
  }
  return shortcuts;
}

async function askLocalRootShortcutDescriptors(): Promise<LocalRootShortcut[]> {
  try {
    const reply = await sendRequestToBitfieldTarget({
      target: 'slot::find-current-items',
      payload: {
        operation: 'find-current-items',
        in: 'published-record',
        where: { all: [{ field: 'kind', in: [LOCAL_ROOT_SHORTCUT_KIND] }] },
      },
    });
    return readLocalRootShortcutDescriptorsFromReply(reply);
  } catch {
    return [];
  }
}

function resolveShortcutPath(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return `${home}${path.slice(1)}`;
  return path;
}

function defaultLocalRootShortcuts(home: string): LocalRootShortcut[] {
  return [
    { label: 'Home', path: home },
    { label: 'Dev', path: `${home}/dev` },
    { label: 'Desktop', path: `${home}/Desktop` },
    { label: 'Documents', path: `${home}/Documents` },
    { label: 'Downloads', path: `${home}/Downloads` },
  ];
}

// ---------------------------------------------------------------------------
// MOUNTED-VOLUME + CLOUD-STORAGE MIRROR DISCOVERY
// ---------------------------------------------------------------------------

async function listDirectoryEntryNames(directoryPath: string): Promise<string[]> {
  try {
    const result = await invokeLocalFilesTarget({
      operation: 'list_directory',
      path: directoryPath,
    });
    return (result.entries ?? []).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function discoverMirrorShortcuts(home: string): Promise<LocalRootShortcut[]> {
  const [volumeNames, cloudStorageNames] = await Promise.all([
    listDirectoryEntryNames('/Volumes'),
    listDirectoryEntryNames(`${home}/Library/CloudStorage`),
  ]);

  const volumes = volumeNames
    .filter((name) => name !== 'Macintosh HD')
    .map((name) => ({ label: name, path: `/Volumes/${name}` }));

  const cloudStorage = cloudStorageNames.map((name) => ({
    label: name,
    path: `${home}/Library/CloudStorage/${name}`,
  }));

  return [...volumes, ...cloudStorage];
}

// ---------------------------------------------------------------------------
// PUBLIC READER
// ---------------------------------------------------------------------------

export async function listLocalRootShortcuts(): Promise<LocalRootShortcut[]> {
  const home = await getLocalHomeRootPath();

  const [descriptorRows, mirrorShortcuts] = await Promise.all([
    askLocalRootShortcutDescriptors(),
    discoverMirrorShortcuts(home),
  ]);

  const baseShortcuts = descriptorRows.length > 0
    ? descriptorRows.map((shortcut) => ({
        label: shortcut.label,
        path: resolveShortcutPath(shortcut.path, home),
      }))
    : defaultLocalRootShortcuts(home);

  const seenPaths = new Set(baseShortcuts.map((shortcut) => shortcut.path));
  const additionalMirrors = mirrorShortcuts.filter((shortcut) => !seenPaths.has(shortcut.path));

  return [...baseShortcuts, ...additionalMirrors];
}
