// A native source folder is an explicit set of Swift and resource files. The
// publisher verifies those bytes before building; an app project alone cannot
// turn a guessed Swift view reference into executable code.
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { checkedAppProject } from './app-project.mjs';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FILE = /^(?!\.)(?!.*(?:^|\/)\.\.?\/)\S+(?:\/\S+)*$/;
const versionOf = makeHashCodeHexFromBytes;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));

function filePath(value) {
  if (typeof value !== 'string' || !FILE.test(value) || value.startsWith('/') ||
      value.includes('\\') || value.includes('//') || value.includes('\0') ||
      value.split('/').some(part => part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('The native source has an invalid file path.');
  }
  return value;
}

function checkedManifest(input) {
  if (!exact(input, ['schema', 'entry', 'swift', 'resources']) ||
      input.schema !== 'trillion.native-source' ||
      !exact(input.entry, ['id', 'type', 'source_path']) ||
      !NAME.test(input.entry.id ?? '') || !NAME.test(input.entry.type ?? '') ||
      !Array.isArray(input.swift) || !input.swift.length || input.swift.length > 128 ||
      !Array.isArray(input.resources) || input.resources.length > 256) {
    throw new Error('The native source manifest is invalid.');
  }
  const swift = input.swift.map(filePath);
  const resources = input.resources.map(filePath);
  if (swift.some(path => !path.endsWith('.swift')) ||
      resources.some(path => path.endsWith('.swift')) ||
      new Set([...swift, ...resources]).size !== swift.length + resources.length ||
      !swift.includes(filePath(input.entry.source_path))) {
    throw new Error('The native source manifest has an invalid file list.');
  }
  return { schema: input.schema,
    entry: { id: input.entry.id, type: input.entry.type, source_path: input.entry.source_path },
    swift: [...swift].sort(), resources: [...resources].sort() };
}

async function readWithin(root, path) {
  let at = root;
  for (const part of path.split('/')) {
    at = join(at, part);
    if ((await lstat(at)).isSymbolicLink()) throw new Error('Native source symlinks are not supported.');
  }
  const bytes = await readFile(at);
  if (bytes.length > 4_000_000) throw new Error('A native source file is too large.');
  return bytes;
}

export async function describeNativeSource(sourceRoot) {
  if (!sourceRoot || !isAbsolute(sourceRoot)) throw new Error('Use an absolute native source folder.');
  const root = await realpath(sourceRoot);
  const manifest = checkedManifest(JSON.parse(await readWithin(root, 'native-app-source.json')));
  const files = new Map();
  let total = 0;
  for (const path of [...manifest.swift, ...manifest.resources].sort()) {
    const bytes = await readWithin(root, path);
    if (path.endsWith('.swift') && /@main\b/.test(bytes.toString('utf8'))) {
      throw new Error('The native source must provide a view, not another app entry.');
    }
    total += bytes.length;
    if (total > 20_000_000) throw new Error('The native source is too large.');
    files.set(path, bytes);
  }
  const pieces = [Buffer.from(JSON.stringify(manifest))];
  for (const [path, bytes] of files) {
    pieces.push(Buffer.from(`\0${path}\0${bytes.length}\0`), bytes);
  }
  return { root, manifest, files, revision: versionOf(Buffer.concat(pieces)),
    entry_version: versionOf(files.get(manifest.entry.source_path)) };
}

export function nativeProjectFromSource(description, { id, name, targets }) {
  const entry = description.manifest.entry;
  return checkedAppProject({ schema: 'trillion.app-project', id, name,
    source: { kind: 'repository-source', id: `native-source:${id}`, revision: description.revision,
      coverage: { routes: 'kept', assets: 'kept', browser_code: 'not-imported',
        server_code: 'source-dependent', sign_in: 'source-dependent', native_code: 'kept' } },
    pages: [{ id: entry.id, path: '/', source_path: entry.source_path,
      presenter: { kind: 'native-screen', ref: {
        kind: 'swift-view', id: entry.id, version: description.entry_version } } }],
    assets: description.manifest.resources.map(path => ({ path, media_type: 'application/octet-stream' })),
    behaviors: [], capabilities: [], permissions: [],
    outputs: targets.map(target => ({ target, presenter: 'native-screen', status: 'buildable' })),
  });
}

export function checkedNativeBuildProject(input, description, targets) {
  const project = checkedAppProject(input);
  if (project.source.kind !== 'repository-source' ||
      project.source.id !== `native-source:${project.id}` ||
      project.source.coverage.native_code !== 'kept' ||
      project.source.revision !== description.revision ||
      project.pages.length !== 1 || project.pages[0].path !== '/' ||
      project.pages[0].source_path !== description.manifest.entry.source_path ||
      project.pages[0].presenter.kind !== 'native-screen' ||
      project.pages[0].presenter.ref.kind !== 'swift-view' ||
      project.pages[0].presenter.ref.id !== description.manifest.entry.id ||
      project.pages[0].presenter.ref.version !== description.entry_version ||
      project.capabilities.length || project.permissions.length ||
      project.behaviors.some(row => row.kind !== 'source-module' || !description.manifest.swift.includes(row.source_path)) ||
      project.assets.length !== description.manifest.resources.length ||
      project.assets.some(row => !description.manifest.resources.includes(row.path))) {
    throw new Error('The native app project does not match its current source.');
  }
  for (const target of targets) {
    const output = project.outputs.find(row => row.target === target);
    if (output?.presenter !== 'native-screen' || output.status !== 'buildable') {
      throw new Error(`This project does not support a ${target} native source build.`);
    }
  }
  return project;
}
