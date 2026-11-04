// An existing Xcode project stays the build owner. A Git commit pins its source.
import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkedAppProject } from '../../assemble-and-publish-an-app-project/src/app-project.mjs';

const COMMIT = /^[0-9a-f]{40}$/;
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SCHEME = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,119}$/;
const versionOf = value => `1f:${bytesToHex(blake3(new TextEncoder().encode(value)))}`;
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 20_000_000 }).trim();

/** Build the GitHub address from the saved connection, never from caller text. */
export function nativeXcodeRepositoryUrl(origin) {
  if (!origin || origin.kind !== 'github-repository' || !PART.test(origin.owner ?? '') ||
      !PART.test(origin.repo ?? '') || !/^[a-f0-9]{32}$/.test(origin.project_id ?? '') ||
      !COMMIT.test(origin.commit ?? '') || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(origin.branch ?? '')) {
    throw new Error('The saved Xcode source needs a checked connected GitHub repository and commit.');
  }
  return `https://github.com/${origin.owner}/${origin.repo}.git`;
}

/** Fetch the exact connected source into a caller-created private build workspace. */
export function cloneNativeXcodeSource(origin, destination) {
  const url = nativeXcodeRepositoryUrl(origin);
  if (!isAbsolute(destination ?? '')) throw new Error('The native source build folder must be absolute.');
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  execFileSync('git', ['clone', '--quiet', '--no-checkout', '--filter=blob:none', '--no-tags', url, destination],
    { env, stdio: 'pipe', maxBuffer: 20_000_000 });
  // A credential helper may rewrite the transport URL. Keep recorded source identity aligned with the saved connection.
  execFileSync('git', ['-C', destination, 'config', 'remote.origin.url', url], { env, stdio: 'pipe', maxBuffer: 20_000_000 });
  execFileSync('git', ['-C', destination, 'fetch', '--quiet', '--filter=blob:none', '--depth=1', '--no-tags', 'origin', origin.commit],
    { env, stdio: 'pipe', maxBuffer: 20_000_000 });
  execFileSync('git', ['-C', destination, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'],
    { env, stdio: 'pipe', maxBuffer: 20_000_000 });
  if (git(destination, 'rev-parse', 'HEAD') !== origin.commit) {
    throw new Error('The downloaded Xcode source does not match its connected commit.');
  }
  return destination;
}

function checkedPath(path) {
  if (typeof path !== 'string' || !path.endsWith('.xcodeproj') || path.startsWith('/') ||
      path.includes('\\') || path.includes('//') || path.includes('\0') ||
      path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('Choose an Xcode project inside the source repository.');
  }
  return path;
}

function repositoryId(remote) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote);
  if (!match || !PART.test(match[1]) || !PART.test(match[2])) {
    throw new Error('The source needs an original GitHub repository remote.');
  }
  return `github:${match[1]}/${match[2]}`;
}

function checkedTree(root, commit, projectPath) {
  const rows = execFileSync('git', ['-C', root, 'ls-tree', '-r', '-z', '--long', commit], { maxBuffer: 20_000_000 });
  let count = 0;
  let bytes = 0;
  let hasProject = false;
  for (const row of rows.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d{6}) blob ([0-9a-f]{40})\s+(\d+)\t(.+)$/.exec(row);
    if (!match || match[1] !== '100644' && match[1] !== '100755') {
      throw new Error('Xcode source links and submodules are not supported.');
    }
    const path = match[4];
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part =>
      !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f]/.test(part))) {
      throw new Error('The source repository has an unsafe file path.');
    }
    count++;
    bytes += Number(match[3]);
    if (count > 10_000 || bytes > 300_000_000) throw new Error('The source repository exceeds this native build limit.');
    if (path === `${projectPath}/project.pbxproj`) hasProject = true;
  }
  if (!hasProject) throw new Error('The selected Xcode project is not in the pinned commit.');
  return { file_count: count, source_bytes: bytes };
}

export async function describeNativeXcodeSource({ sourceRoot, projectPath, schemes, expectedCommit, connectedOrigin }) {
  if (!isAbsolute(sourceRoot ?? '')) throw new Error('Use an absolute source repository folder.');
  const root = await realpath(sourceRoot);
  if (git(root, 'rev-parse', '--show-toplevel') !== root) throw new Error('Choose the root of the original repository.');
  if (!COMMIT.test(expectedCommit ?? '') || git(root, 'rev-parse', 'HEAD') !== expectedCommit) {
    throw new Error('The original repository is not at the expected commit.');
  }
  const xcode_project = checkedPath(projectPath);
  if (!schemes || typeof schemes !== 'object' || Array.isArray(schemes) ||
      !Object.keys(schemes).length || Object.keys(schemes).some(target => !['ios', 'macos'].includes(target)) ||
      Object.values(schemes).some(scheme => !SCHEME.test(scheme ?? '') || !scheme.trim())) {
    throw new Error('Choose an Xcode app scheme for each native target.');
  }
  // Read the saved repository URL so credential transport rewrites cannot alter source identity.
  const repository = repositoryId(git(root, 'config', '--get', 'remote.origin.url'));
  if (!connectedOrigin || connectedOrigin.kind !== 'github-repository' ||
      connectedOrigin.commit !== expectedCommit ||
      `github:${connectedOrigin.owner}/${connectedOrigin.repo}`.toLowerCase() !== repository.toLowerCase() ||
      !/^[a-f0-9]{32}$/.test(connectedOrigin.project_id ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(connectedOrigin.branch ?? '')) {
    throw new Error('The local Xcode source does not match the connected repository and pinned commit.');
  }
  const tree = checkedTree(root, expectedCommit, xcode_project);
  return { root, repository, commit: expectedCommit, connectedOrigin: { ...connectedOrigin }, xcode_project, schemes: { ...schemes }, ...tree,
    revision: versionOf(`${repository}\0${expectedCommit}`),
    entry_version: versionOf(`${repository}\0${expectedCommit}\0${xcode_project}\0${JSON.stringify(schemes)}`) };
}

export function nativeProjectFromXcodeSource(source, { id, name, targets, connectedOrigin }) {
  if (!Array.isArray(targets) || !targets.length || targets.some(target => !['ios', 'macos'].includes(target)) ||
      new Set(targets).size !== targets.length || targets.some(target => !source.schemes[target])) {
    throw new Error('Choose iPhone or Mac native targets with Xcode schemes.');
  }
  return checkedAppProject({ schema: 'trillion.app-project', id, name,
    source: { kind: 'repository-source', id: `${source.repository}@${source.commit}`, revision: source.revision,
      origin: connectedOrigin,
      native: { kind: 'xcode-project', project_path: source.xcode_project, schemes: source.schemes },
      coverage: { routes: 'source-dependent', assets: 'source-dependent', browser_code: 'not-imported',
        server_code: 'source-dependent', sign_in: 'source-dependent', native_code: 'kept' } },
    pages: [{ id: 'app', path: '/', source_path: `${source.xcode_project}/project.pbxproj`,
      presenter: { kind: 'native-screen', ref: { kind: 'xcode-target', id: 'app', version: source.entry_version } } }],
    assets: [], behaviors: [], capabilities: [], permissions: [],
    // Buildable means this target has a checked local Xcode build owner; the
    // builder reports success only after xcodebuild produces its .app.
    outputs: targets.map(target => ({ target, presenter: 'native-screen', status: 'buildable' })) });
}

export function checkedNativeXcodeBuildProject(input, source, targets) {
  const project = checkedAppProject(input);
  const declaredTargets = project.outputs.map(row => row.target);
  const expected = nativeProjectFromXcodeSource(source, {
    id: project.id, name: project.name, targets: declaredTargets, connectedOrigin: source.connectedOrigin });
  if (JSON.stringify(project) !== JSON.stringify(expected) || targets.some(target => !declaredTargets.includes(target))) {
    throw new Error('The native app project does not match its original repository and commit.');
  }
  const unavailable = targets.find(target => {
    const output = project.outputs.find(row => row.target === target);
    return output?.presenter !== 'native-screen' || output.status !== 'buildable';
  });
  if (unavailable) throw new Error(`The ${unavailable} target has no checked Xcode build path.`);
  return project;
}
