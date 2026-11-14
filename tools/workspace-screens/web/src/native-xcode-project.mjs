// The same checked app-project description can be prepared in Sites and
// verified later by the local Xcode builder against its checked-out source.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkedAppProject } from './app-project.mjs';

const COMMIT = /^[0-9a-f]{40}$/;
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SCHEME = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,119}$/;
const versionOf = value => `1f:${bytesToHex(blake3(new TextEncoder().encode(value)))}`;

function checkedDescriptor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['repository', 'commit', 'xcode_project', 'schemes'].includes(key))) {
    throw new Error('Choose a connected GitHub repository and Xcode project.');
  }
  const remote = /^github:([^/]+)\/([^/]+)$/.exec(input.repository ?? '');
  if (!remote || !PART.test(remote[1]) || !PART.test(remote[2])) {
    throw new Error('The source needs an original GitHub repository.');
  }
  if (!COMMIT.test(input.commit ?? '')) throw new Error('The source needs its exact Git commit.');
  const projectPath = input.xcode_project;
  if (typeof projectPath !== 'string' || !projectPath.endsWith('.xcodeproj') || projectPath.startsWith('/') ||
      projectPath.includes('\\') || projectPath.includes('//') || projectPath.includes('\0') ||
      projectPath.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('Choose an Xcode project inside the source repository.');
  }
  const schemes = input.schemes;
  if (!schemes || typeof schemes !== 'object' || Array.isArray(schemes) ||
      !Object.keys(schemes).length || Object.keys(schemes).some(target => !['ios', 'macos'].includes(target)) ||
      Object.values(schemes).some(scheme => !SCHEME.test(scheme ?? '') || !scheme.trim())) {
    throw new Error('Choose an iPhone or Mac app scheme.');
  }
  return { repository: input.repository, commit: input.commit, xcode_project: projectPath,
    schemes: Object.fromEntries(['ios', 'macos'].filter(target => schemes[target]).map(target => [target, schemes[target]])) };
}

export function nativeXcodeSourceIdentity(input) {
  const source = checkedDescriptor(input);
  return {
    revision: versionOf(`${source.repository}\0${source.commit}`),
    entry_version: versionOf(`${source.repository}\0${source.commit}\0${source.xcode_project}\0${JSON.stringify(source.schemes)}`),
  };
}

export function nativeProjectFromXcodeDescriptor(input, { id, name, targets, connectedOrigin } = {}) {
  const source = checkedDescriptor(input);
  const remote = /^github:([^/]+)\/([^/]+)$/.exec(source.repository);
  if (!connectedOrigin || connectedOrigin.kind !== 'github-repository' ||
      connectedOrigin.commit !== source.commit ||
      connectedOrigin.owner?.toLowerCase() !== remote[1].toLowerCase() ||
      connectedOrigin.repo?.toLowerCase() !== remote[2].toLowerCase()) {
    throw new Error('The Xcode project must retain the matching connected GitHub repository and commit.');
  }
  targets ??= Object.keys(source.schemes);
  if (!Array.isArray(targets) || !targets.length || targets.some(target => !['ios', 'macos'].includes(target)) ||
      new Set(targets).size !== targets.length || targets.some(target => !source.schemes[target])) {
    throw new Error('Choose iPhone or Mac native targets with Xcode schemes.');
  }
  const { revision, entry_version } = nativeXcodeSourceIdentity(source);
  return checkedAppProject({ schema: 'trillion.app-project', id, name,
    source: { kind: 'repository-source', id: `${source.repository}@${source.commit}`, revision,
      origin: connectedOrigin,
      native: { kind: 'xcode-project', project_path: source.xcode_project, schemes: source.schemes },
      coverage: { routes: 'source-dependent', assets: 'source-dependent', browser_code: 'not-imported',
        server_code: 'source-dependent', sign_in: 'source-dependent', native_code: 'kept' } },
    pages: [{ id: 'app', path: '/', source_path: `${source.xcode_project}/project.pbxproj`,
      presenter: { kind: 'native-screen', ref: { kind: 'xcode-target', id: 'app', version: entry_version } } }],
    assets: [], behaviors: [], capabilities: [], permissions: [],
    outputs: targets.map(target => ({ target, presenter: 'native-screen', status: 'unsupported',
      reason: 'A connected Xcode project cannot be built or signed from Sites.' })) });
}
