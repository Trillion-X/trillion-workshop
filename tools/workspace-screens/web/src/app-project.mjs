// One app project describes its source, pages and capabilities without choosing
// a web, iPhone or Mac build. Presenters state what they really render.
import { checkedPublicAppEditorSource, publicAppEditorRoute, publicAppEditorRoutePages } from 'trillion-workshop/tools/edit-a-site-visually/src/public-app-editor-model.mjs';
import { checkedPublicAppFiles, MAX_PUBLIC_APP_FILES, publicAppFilePath, publicAppMediaType } from 'trillion-workshop/tools/shared-code/src/public-app-files.mjs';
import { checkedPublicCardPresentation } from 'trillion-workshop/tools/edit-a-site-visually/src/public-app-capabilities.mjs';
import { publicPublishedCapabilityAdapter } from 'trillion-workshop/tools/edit-a-site-visually/src/public-app-published-contract.mjs';
import { checkedPublicSiteUrl } from './public-app-import.mjs';
import { MAX_INDEX_BYTES, MAX_INDEX_FILES } from './public-app-file-index.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkedSourceBuildInputs } from './source-build-inputs.mjs';
import { privateHost } from 'trillion-workshop/tools/refuse-requests-to-private-addresses/public-address.mjs';

const ID = /^[a-z][a-z0-9-]{1,79}$/;
const REVISION = /^1f:[a-f0-9]{64}$/;
const INSTALLATION = /^[a-f0-9]{32}$/;
const FILE_INDEX_SCHEMA = 'trillion.public-app-file-index';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys, what) => {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${what} is invalid.`);
};

function publicHttpsOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The app needs a public HTTPS address.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !host.includes('.') || privateHost(host) ||
      /^\d+(?:\.\d+){3}\.?$/.test(host) || host.includes(':') || url.search || url.hash) {
    throw new Error('The app needs a public HTTPS address.');
  }
  return url;
}

function checkedPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') ||
      value.includes('?') || value.includes('#') || value.length > 500) throw new Error('An app page has an invalid path.');
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw new Error('An app page has an invalid path.'); }
  if (decoded.split('/').some(part => part === '.' || part === '..') || decoded.startsWith('//')) {
    throw new Error('An app page has an invalid path.');
  }
  return value;
}

export function checkedAppProjectFileAuthority(input) {
  exact(input, ['schema', 'version', 'root', 'file_count', 'byte_count', 'page_count'], 'The app file authority');
  if (input.schema !== FILE_INDEX_SCHEMA || input.version !== 1 || !/^[a-f0-9]{64}$/.test(input.root ?? '') ||
      !Number.isSafeInteger(input.file_count) || input.file_count < 1 || input.file_count > MAX_INDEX_FILES ||
      !Number.isSafeInteger(input.byte_count) || input.byte_count < 0 || input.byte_count > MAX_INDEX_BYTES ||
      !Number.isSafeInteger(input.page_count) || input.page_count < 1 || input.page_count > input.file_count) {
    throw new Error('The app file authority is invalid.');
  }
  return { schema: input.schema, version: input.version, root: input.root,
    file_count: input.file_count, byte_count: input.byte_count, page_count: input.page_count };
}

export function checkedAppProjectFileImport(input) {
  exact(input, ['import_id', 'session_id'], 'The app file import');
  if (!INSTALLATION.test(input.import_id ?? '') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.session_id ?? '')) {
    throw new Error('The app file import is invalid.');
  }
  return { import_id: input.import_id, session_id: input.session_id };
}

function checkFilePreviewFitsAuthority(authority, files) {
  if (!authority) return;
  const checked = checkedPublicAppFiles(files);
  const paths = Object.keys(checked);
  const previewBytes = Object.values(checked).reduce((sum, file) => sum + file.size, 0);
  const previewPages = paths.filter(path => path.endsWith('.html')).length;
  if (paths.length > authority.file_count || previewBytes > authority.byte_count || previewPages > authority.page_count) {
    throw new Error('The app file preview exceeds its indexed authority.');
  }
}

// This is the recorded source of a copy, not a claim that its original server
// or private pages were transferred. Keep it with the installed app across edits.
export function checkedAppProjectOrigin(input) {
  if (input?.kind === 'github-repository') {
    exact(input, ['kind', 'project_id', 'owner', 'repo', 'branch', 'commit', 'build_inputs', 'source_account_id', 'connection'], 'The app project origin');
    if (input.source_account_id !== undefined && (typeof input.source_account_id !== 'string' || !input.source_account_id || input.source_account_id.length > 200)) throw new Error('The source account is invalid.');
    if (input.connection !== undefined && input.connection !== 'provenance') throw new Error('The source connection kind is invalid.');
    if (!/^[a-f0-9]{32}$/.test(input.project_id ?? '') ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.owner ?? '') ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.repo ?? '') ||
        !/^(?!\/|.*(?:\/\/|\.\.|@\{|\\|\s))[A-Za-z0-9._\/-]{1,200}$/.test(input.branch ?? '') ||
        !/^[0-9a-f]{40}$/.test(input.commit ?? '')) throw new Error('The app project origin is invalid.');
    return { kind: input.kind, project_id: input.project_id, owner: input.owner,
      repo: input.repo, branch: input.branch, commit: input.commit,
      ...(input.source_account_id === undefined ? {} : { source_account_id: input.source_account_id }),
      ...(input.connection === undefined ? {} : { connection: input.connection }),
      ...(input.build_inputs === undefined ? {} : { build_inputs: checkedSourceBuildInputs(input.build_inputs) }) };
  }
  exact(input, ['kind', 'origin_url', 'skipped', 'warnings'], 'The app project origin');
  if (!['site-folder', 'public-url-copy'].includes(input.kind)) throw new Error('The app project origin is invalid.');
  if (input.kind === 'public-url-copy' && !input.origin_url ||
      input.kind === 'site-folder' && input.origin_url !== undefined) throw new Error('The app project origin is invalid.');
  const origin_url = input.origin_url === undefined ? undefined : checkedPublicSiteUrl(input.origin_url);
  if (!Array.isArray(input.skipped) || input.skipped.length > 100 || input.skipped.some(row =>
    !object(row) || Object.keys(row).some(key => !['address', 'reason'].includes(key)) ||
    typeof row.address !== 'string' || typeof row.reason !== 'string' || !row.reason.trim())) {
    throw new Error('The skipped source pages are invalid.');
  }
  if (!Array.isArray(input.warnings) || input.warnings.length > 100 || input.warnings.some(row =>
    typeof row !== 'string' || !row.trim() || row.length > 500)) throw new Error('The source warnings are invalid.');
  return { kind: input.kind, ...(origin_url ? { origin_url } : {}),
    skipped: input.skipped.map(row => ({ address: row.address, reason: row.reason })), warnings: [...input.warnings] };
}

export function checkedAppProject(input) {
  exact(input, ['schema', 'id', 'name', 'source', 'pages', 'assets', 'behaviors', 'capabilities', 'permissions', 'outputs'], 'The app project');
  if (input.schema !== 'trillion.app-project' || !ID.test(input.id ?? '') ||
      typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 ||
      /[\\/\u0000-\u001f\u007f]/.test(input.name)) {
    throw new Error('The app project needs a name and id.');
  }
  exact(input.source, ['kind', 'id', 'revision', 'coverage', 'origin_url', 'skipped', 'warnings', 'origin', 'native', 'file_authority', 'file_import'], 'The app source');
  if (!ID.test(input.source.kind ?? '') || typeof input.source.id !== 'string' || !input.source.id ||
      input.source.id.length > 200 || !REVISION.test(input.source.revision ?? '')) {
    throw new Error('The app source needs its exact revision.');
  }
  exact(input.source.coverage, ['routes', 'assets', 'browser_code', 'server_code', 'sign_in', 'native_code'], 'The source coverage');
  const coverage = {};
  for (const key of ['routes', 'assets', 'browser_code', 'server_code', 'sign_in', 'native_code']) {
    if (!['kept', 'not-imported', 'source-dependent'].includes(input.source.coverage[key])) {
      throw new Error(`The source must say what happened to ${key.replaceAll('_', ' ')}.`);
    }
    coverage[key] = input.source.coverage[key];
  }
  const origin_url = input.source.origin_url === undefined ? undefined : checkedPublicSiteUrl(input.source.origin_url);
  const sourceOrigin = input.source.origin === undefined ? undefined : checkedAppProjectOrigin(input.source.origin);
  const fileAuthority = input.source.file_authority === undefined ? undefined : checkedAppProjectFileAuthority(input.source.file_authority);
  const fileImport = input.source.file_import === undefined ? undefined : checkedAppProjectFileImport(input.source.file_import);
  if (fileImport && !fileAuthority) throw new Error('The app file import needs its indexed files.');
  let native;
  if (input.source.native !== undefined) {
    exact(input.source.native, ['kind', 'project_path', 'schemes'], 'The native source');
    const { kind, project_path, schemes } = input.source.native;
    if (kind !== 'xcode-project' || sourceOrigin?.kind !== 'github-repository' ||
        typeof project_path !== 'string' || !project_path.endsWith('.xcodeproj') || project_path.startsWith('/') ||
        project_path.includes('\\') || project_path.includes('//') || project_path.includes('\0') ||
        project_path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
        !object(schemes) || !Object.keys(schemes).length || Object.keys(schemes).some(target => !['ios', 'macos'].includes(target)) ||
        Object.values(schemes).some(scheme => typeof scheme !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,119}$/.test(scheme) || !scheme.trim())) {
      throw new Error('The native source must name an Xcode project and schemes from a connected GitHub repository.');
    }
    native = { kind, project_path, schemes: { ...schemes } };
  }
  if (input.source.skipped !== undefined && (!Array.isArray(input.source.skipped) || input.source.skipped.length > 100 ||
      input.source.skipped.some(row => !object(row) || Object.keys(row).some(key => !['address', 'reason'].includes(key)) ||
        typeof row.address !== 'string' || typeof row.reason !== 'string' || !row.reason.trim()))) {
    throw new Error('The skipped source pages are invalid.');
  }
  if (input.source.warnings !== undefined && (!Array.isArray(input.source.warnings) || input.source.warnings.length > 100 ||
      input.source.warnings.some(row => typeof row !== 'string' || !row.trim() || row.length > 500))) {
    throw new Error('The source warnings are invalid.');
  }
  if (!Array.isArray(input.pages) || !input.pages.length || input.pages.length > MAX_PUBLIC_APP_FILES ||
      (fileAuthority && input.pages.length > fileAuthority.page_count)) throw new Error('The app needs pages.');
  const pageIds = new Set();
  const pagePaths = new Set();
  let origin;
  const pages = input.pages.map(page => {
    exact(page, ['id', 'path', 'source_path', 'presenter'], 'An app page');
    if (typeof page.id !== 'string' || !page.id || page.id.length > 500 || pageIds.has(page.id)) throw new Error('App page ids must be distinct.');
    pageIds.add(page.id);
    const path = checkedPath(page.path);
    if (pagePaths.has(path)) throw new Error('App page paths must be distinct.');
    pagePaths.add(path);
    if (publicAppFilePath(page.source_path) !== page.source_path) {
      throw new Error('An app page needs its source file.');
    }
    exact(page.presenter, page.presenter?.kind === 'editable-file' ? ['kind', 'path'] :
      page.presenter?.kind === 'native-screen' ? ['kind', 'ref'] : ['kind', 'url'], 'The app page presenter');
    let presenter;
    if (page.presenter.kind === 'hosted-web') {
      const url = publicHttpsOrigin(page.presenter.url);
      if (url.pathname !== path || (origin && url.origin !== origin)) throw new Error('App pages must use their declared paths on one HTTPS origin.');
      origin = url.origin;
      presenter = { kind: 'hosted-web', url: url.href };
    } else if (page.presenter.kind === 'editable-file' && page.presenter.path === page.source_path && page.source_path.endsWith('.html')) {
      presenter = { kind: 'editable-file', path: page.source_path };
    } else if (page.presenter.kind === 'native-screen') {
      exact(page.presenter.ref, ['kind', 'id', 'version'], 'The native screen reference');
      if (!ID.test(page.presenter.ref.kind ?? '') || !ID.test(page.presenter.ref.id ?? '') ||
          !REVISION.test(page.presenter.ref.version ?? '')) throw new Error('The native screen reference is invalid.');
      presenter = { kind: 'native-screen', ref: { ...page.presenter.ref } };
    } else throw new Error('This app page presenter is not supported.');
    return { id: page.id, path, source_path: page.source_path, presenter };
  });
  if (!pages.some(page => page.path === '/')) throw new Error('The app needs a home page.');
  if (!Array.isArray(input.assets) || input.assets.length > 512 ||
      (fileAuthority && input.assets.length > fileAuthority.file_count - fileAuthority.page_count)) throw new Error('The app assets are invalid.');
  const assetPaths = new Set();
  const assets = input.assets.map(asset => {
    exact(asset, ['path', 'media_type'], 'An app asset');
    if (publicAppFilePath(asset.path) !== asset.path || assetPaths.has(asset.path) ||
        typeof asset.media_type !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[ a-z0-9=.+-]+)?$/i.test(asset.media_type)) {
      throw new Error('An app asset has an invalid path or type.');
    }
    assetPaths.add(asset.path);
    return { path: asset.path, media_type: asset.media_type };
  });
  if (!Array.isArray(input.behaviors) || input.behaviors.length > 200) throw new Error('The app behaviors are invalid.');
  const behaviorIds = new Set();
  const behaviors = input.behaviors.map(behavior => {
    exact(behavior, ['id', 'kind', 'source_path'], 'An app behavior');
    if (typeof behavior.id !== 'string' || !behavior.id || behaviorIds.has(behavior.id) ||
        !['visitor-action', 'local-script', 'source-module'].includes(behavior.kind) ||
        (behavior.kind === 'local-script' && (!assetPaths.has(behavior.source_path) || !/\.m?js$/i.test(behavior.source_path))) ||
        (behavior.kind === 'source-module' && publicAppFilePath(behavior.source_path) !== behavior.source_path) ||
        (behavior.kind === 'visitor-action' && behavior.source_path !== undefined)) {
      throw new Error('An app behavior reference is invalid.');
    }
    behaviorIds.add(behavior.id);
    return { id: behavior.id, kind: behavior.kind, ...(behavior.source_path ? { source_path: behavior.source_path } : {}) };
  });
  if (!Array.isArray(input.capabilities) || input.capabilities.length > 100) throw new Error('The app has too many capabilities.');
  const capabilityIds = new Set();
  const capabilities = input.capabilities.map(row => {
    exact(row, ['id', 'page_id', 'access', 'ref', 'presentation'], 'An app capability');
    if (!ID.test(row.id ?? '') || capabilityIds.has(row.id) || !pageIds.has(row.page_id) ||
        !['public', 'signed-in'].includes(row.access)) throw new Error('An app capability has an invalid page or access.');
    capabilityIds.add(row.id);
    exact(row.ref, ['kind', 'id', 'version', 'operation'], 'An app capability reference');
    if (!ID.test(row.ref.kind ?? '') || typeof row.ref.id !== 'string' || !row.ref.id || row.ref.id.length > 200 ||
        !REVISION.test(row.ref.version ?? '') || (row.ref.operation !== undefined && !['open', 'run'].includes(row.ref.operation))) {
      throw new Error('An app capability reference is invalid.');
    }
    // A visitor action's form words are checked against its fields where the placement is checked
    // (checkedPlacedCapabilities, src/public-app-capabilities.mjs); here they only travel with it.
    const formWords = row.ref.kind === 'visitor-action';
    if (row.presentation !== undefined && (formWords ? row.presentation === null || typeof row.presentation !== 'object' || Array.isArray(row.presentation)
      : row.access !== 'public' || !publicPublishedCapabilityAdapter(row.ref.kind))) {
      throw new Error('A public card needs a published source and public access.');
    }
    const presentation = formWords ? row.presentation : checkedPublicCardPresentation(row.presentation);
    return { id: row.id, page_id: row.page_id, access: row.access,
      ref: { kind: row.ref.kind, id: row.ref.id, version: row.ref.version,
        ...(row.ref.operation ? { operation: row.ref.operation } : {}) },
      ...(presentation ? { presentation } : {}) };
  });
  if (!Array.isArray(input.permissions) || input.permissions.length > 30) throw new Error('The app permissions are invalid.');
  const permissionKinds = new Set();
  const permissions = input.permissions.map(permission => {
    exact(permission, ['kind', 'purpose'], 'An app permission');
    if (!ID.test(permission.kind ?? '') || permissionKinds.has(permission.kind) ||
        typeof permission.purpose !== 'string' || !permission.purpose.trim() || permission.purpose.length > 200) {
      throw new Error('An app permission is invalid.');
    }
    permissionKinds.add(permission.kind);
    return { kind: permission.kind, purpose: permission.purpose.trim() };
  });
  if (!Array.isArray(input.outputs) || !input.outputs.length || input.outputs.length > 3) throw new Error('The app outputs are invalid.');
  const targets = new Set();
  const outputs = input.outputs.map(output => {
    exact(output, ['target', 'presenter', 'status', 'reason'], 'An app output');
    if (!['web', 'ios', 'macos'].includes(output.target) || targets.has(output.target) ||
        !['hosted-web', 'webview', 'editable-file', 'native-screen'].includes(output.presenter) ||
        !['published', 'buildable', 'draft', 'unsupported'].includes(output.status) ||
        (output.status === 'unsupported' ? typeof output.reason !== 'string' || !output.reason.trim() : output.reason !== undefined)) {
      throw new Error('An app output is invalid.');
    }
    targets.add(output.target);
    return { target: output.target, presenter: output.presenter, status: output.status,
      ...(output.reason ? { reason: output.reason } : {}) };
  });
  return { schema: input.schema, id: input.id, name: input.name.trim(),
    source: { kind: input.source.kind, id: input.source.id, revision: input.source.revision, coverage,
      ...(origin_url ? { origin_url } : {}),
      ...(input.source.skipped ? { skipped: input.source.skipped.map(row => ({ address: row.address, reason: row.reason })) } : {}),
      ...(input.source.warnings ? { warnings: [...input.source.warnings] } : {}),
      ...(sourceOrigin ? { origin: sourceOrigin } : {}), ...(native ? { native } : {}),
      ...(fileAuthority ? { file_authority: fileAuthority } : {}),
      ...(fileImport ? { file_import: fileImport } : {}) },
    pages, assets, behaviors, capabilities, permissions, outputs };
}

// A folder or public URL contributes only copied, hostable files. The project
// retains that boundary until publishing creates a current installation.
export function appProjectFromImportedSite({ id, name, imported }) {
  if (!imported?.can_publish || !object(imported.files) || !Object.hasOwn(imported.files, 'index.html')) {
    throw new Error('Choose an imported site that can be published.');
  }
  const fileAuthority = imported.files_index === undefined ? undefined : checkedAppProjectFileAuthority(imported.files_index);
  const fileImport = imported.file_import === undefined ? undefined : checkedAppProjectFileImport(imported.file_import);
  if (fileImport && !fileAuthority) throw new Error('The app file import needs its indexed files.');
  const files = Object.fromEntries(Object.entries(checkedPublicAppFiles(imported.files)).map(([path, file]) => [path, file.source]));
  checkFilePreviewFitsAuthority(fileAuthority, files);
  const paths = Object.keys(files).sort((a, b) =>
    a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b));
  const pages = paths.filter(path => path.endsWith('.html')).map(path => ({
    id: path, path: publicAppEditorRoute(path), source_path: path,
    presenter: { kind: 'editable-file', path },
  }));
  const scripts = paths.filter(path => /\.m?js$/i.test(path));
  const revision = fileAuthority ? `1f:${fileAuthority.root}` : `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(
    Object.fromEntries(paths.map(path => [path, files[path]]))))))}`;
  return checkedAppProject({ schema: 'trillion.app-project', id, name,
    source: { kind: imported.source_url ? 'public-url-copy' : 'site-folder', id,
      revision, ...(fileAuthority ? { file_authority: fileAuthority } : {}),
      ...(fileImport ? { file_import: fileImport } : {}),
      ...(imported.source_url ? { origin_url: imported.source_url } : {}),
      coverage: { routes: imported.source_url ? 'source-dependent' : 'kept',
        assets: imported.source_url ? 'source-dependent' : 'kept',
        browser_code: imported.source_url ? 'not-imported' : 'source-dependent',
        server_code: 'not-imported', sign_in: 'not-imported', native_code: 'not-imported' },
      skipped: imported.skipped ?? [], warnings: imported.warnings ?? [] },
    pages,
    assets: paths.filter(path => !path.endsWith('.html')).map(path => ({ path, media_type: publicAppMediaType(path) })),
    behaviors: scripts.map(path => ({ id: `script:${path}`, kind: 'local-script', source_path: path })),
    capabilities: [], permissions: [],
    outputs: [{ target: 'web', presenter: 'editable-file', status: 'draft' },
      { target: 'ios', presenter: 'webview', status: 'unsupported', reason: 'Publish the site before making an iPhone app.' },
      { target: 'macos', presenter: 'webview', status: 'unsupported', reason: 'Publish the site before making a Mac app.' }],
  });
}

/** Adapt files already read from the exact pinned commit of a connected GitHub repository. */
export function appProjectFromPinnedRepository({ id, name, project, snapshot }) {
  const sameRepo = (left, right) => typeof left === 'string' && typeof right === 'string' &&
    left.toLowerCase() === right.toLowerCase();
  if (!object(project) || !/^[a-f0-9]{32}$/.test(project.id ?? '') || project.provider !== 'github' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(project.owner ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(project.repo ?? '') ||
      !/^(?!\/|.*(?:\/\/|\.\.|@\{|\\|\s))[A-Za-z0-9._\/-]{1,200}$/.test(project.branch ?? '') ||
      !/^[0-9a-f]{40}$/.test(project.commit ?? '')) {
    throw new Error('Choose a GitHub project pinned to an exact commit.');
  }
  if (!object(snapshot) || snapshot.project_id !== project.id ||
      !sameRepo(snapshot.owner, project.owner) || !sameRepo(snapshot.repo, project.repo) ||
      snapshot.branch !== project.branch || snapshot.commit !== project.commit) {
    throw new Error('The repository files must come from this project’s pinned commit.');
  }
  const buildInputs = snapshot.build_inputs === undefined ? undefined : checkedSourceBuildInputs(snapshot.build_inputs);
  const origin = { kind: 'github-repository', project_id: project.id, owner: project.owner,
    repo: project.repo, branch: project.branch, commit: project.commit,
    ...(project.source_account_id ? { source_account_id: project.source_account_id } : {}),
    ...(buildInputs ? { build_inputs: buildInputs } : {}) };
  if (snapshot.kind === 'running-web-origin') {
    if (snapshot.routes !== undefined && (!Array.isArray(snapshot.routes) || snapshot.routes.length > 100)) {
      throw new Error('A running app can add at most 100 linked routes.');
    }
    if (snapshot.url !== project.live_url || typeof snapshot.url !== 'string') {
      throw new Error('The hosted page must use this repository connection’s running app address.');
    }
    const address = publicHttpsOrigin(snapshot.url);
    if (address.pathname !== '/' || address.search || address.hash) {
      throw new Error('The hosted app address must be a public HTTPS origin.');
    }
    const revision = `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify({
      kind: snapshot.kind, project_id: project.id, commit: project.commit, url: address.href, buildInputs,
    }))))}`;
    const routes = [...new Set(['/', ...(snapshot.routes ?? [])])].map(checkedPath)
      .sort((left, right) => left === '/' ? -1 : right === '/' ? 1 : left.localeCompare(right));
    if (routes.length > 100) throw new Error('A running app can add at most 100 linked routes.');
    const pages = routes.map(path => {
      const token = bytesToHex(blake3(new TextEncoder().encode(path))).slice(0, 24);
      const source_path = path === '/' ? 'external-app/index.html' : `external-app/routes/${token}/index.html`;
      return { id: `running-app:${token}`, path, source_path,
        presenter: { kind: 'hosted-web', url: new URL(path, address).href } };
    });
    return checkedAppProject({ schema: 'trillion.app-project', id, name,
      source: { kind: 'repository-source', id: `github:${project.owner}/${project.repo}@${project.commit}`,
        revision,
        coverage: { routes: 'source-dependent', assets: 'source-dependent', browser_code: 'source-dependent',
          server_code: 'source-dependent', sign_in: 'source-dependent', native_code: 'not-imported' },
        origin },
      pages,
      assets: [], behaviors: [], capabilities: [], permissions: [],
      outputs: [{ target: 'web', presenter: 'hosted-web', status: 'published' },
        { target: 'ios', presenter: 'webview', status: 'unsupported', reason: 'The connected native app source is not included.' },
        { target: 'macos', presenter: 'webview', status: 'unsupported', reason: 'The connected native app source is not included.' }],
    });
  }
  if (!object(snapshot.files)) throw new Error('The repository files must come from this project’s pinned commit.');
  const imported = { can_publish: true, files: snapshot.files, warnings: snapshot.warnings ?? [] };
  const copied = appProjectFromImportedSite({ id, name, imported });
  return checkedAppProject({ ...copied,
    source: { ...copied.source, kind: 'repository-source', id: `github:${project.owner}/${project.repo}@${project.commit}`,
      coverage: { routes: 'kept', assets: 'kept', browser_code: 'source-dependent',
        server_code: 'source-dependent', sign_in: 'source-dependent', native_code: 'not-imported' },
      origin },
  });
}

// The web editor is one source adapter. Its HTML files are not the app-project ontology.
export function appProjectFromPublicApp({ installation_id, public_url, name, source }) {
  if (!INSTALLATION.test(installation_id ?? '')) throw new Error('Choose a published app installation.');
  const fileAuthority = source?.file_index === undefined ? undefined : checkedAppProjectFileAuthority(source.file_index);
  const edited = checkedPublicAppEditorSource(source);
  checkFilePreviewFitsAuthority(fileAuthority, edited.files);
  const revision = fileAuthority
    ? (typeof source.revision === 'string' && REVISION.test(source.revision)
      ? source.revision : (() => { throw new Error('The installed app needs its exact revision.'); })())
    : edited.revision;
  const address = publicHttpsOrigin(public_url);
  if (address.pathname !== '/') throw new Error('Use the installed app home address.');
  const routes = publicAppEditorRoutePages(edited);
  const origin = source.project_origin === undefined ? undefined : checkedAppProjectOrigin(source.project_origin);
  const pageByFile = new Map(routes.filter(page => page.kind === 'file').map(page => [page.html_path, page.id]));
  const hasSignedIn = (edited.placed_capabilities ?? []).some(row => row.access === 'signed-in');
  const nativeOutput = target => ({ target, presenter: 'webview',
    ...(hasSignedIn ? { status: 'unsupported', reason: 'A sign-in return for this native app is not available.' } : { status: 'buildable' }) });
  return checkedAppProject({ schema: 'trillion.app-project', id: `app-${installation_id}`, name,
    source: { kind: 'public-app-installation', id: installation_id, revision,
      ...(fileAuthority ? { file_authority: fileAuthority } : {}),
      coverage: { routes: origin?.kind === 'public-url-copy' ? 'source-dependent' : 'kept',
        assets: origin?.kind === 'public-url-copy' ? 'source-dependent' : 'kept',
        browser_code: origin?.kind === 'public-url-copy' ? 'not-imported' : 'source-dependent',
        server_code: 'not-imported', sign_in: origin ? 'not-imported' : 'source-dependent', native_code: 'not-imported' },
      ...(origin ? { origin } : {}) },
    pages: routes.map(page => ({ id: page.id, path: page.route, source_path: page.html_path,
      presenter: { kind: 'hosted-web', url: new URL(page.route, address).href } })),
    assets: Object.keys(edited.files).filter(path => !path.endsWith('.html')).sort().map(path =>
      ({ path, media_type: publicAppMediaType(path) })),
    behaviors: [...edited.actions.map(action => ({ id: action.id, kind: 'visitor-action' })),
      ...Object.keys(edited.files).filter(path => /\.m?js$/i.test(path)).sort().map(path =>
        ({ id: `script:${path}`, kind: 'local-script', source_path: path }))],
    capabilities: (edited.placed_capabilities ?? []).map(row => ({ id: row.id,
      page_id: pageByFile.get(row.page_path), access: row.access, ref: row.capability,
      ...(row.presentation ? { presentation: row.presentation } : {}) })),
    permissions: [],
    outputs: [{ target: 'web', presenter: 'hosted-web', status: 'published' }, nativeOutput('ios'), nativeOutput('macos')],
  });
}

// The existing site draft owns editable files and placements. Describe that
// draft as a project without saving another copy of its source or claiming its
// pages are already public at the installation's address.
export function appProjectFromPublicAppDraft({ installation_id, public_url, name, draft }) {
  const project = appProjectFromPublicApp({ installation_id, public_url, name, source: draft });
  return checkedAppProject({ ...project,
    pages: project.pages.map(page => ({ ...page,
      presenter: { kind: 'editable-file', path: page.source_path } })),
    outputs: [{ target: 'web', presenter: 'editable-file', status: 'draft' },
      { target: 'ios', presenter: 'webview', status: 'unsupported', reason: 'Publish the site before making an iPhone app.' },
      { target: 'macos', presenter: 'webview', status: 'unsupported', reason: 'Publish the site before making a Mac app.' }],
  });
}

// A caller's project file is a proposal. Rebuild the publishable description
// from the installation owner before accepting it for a native bundle.
export async function currentPublicAppProject(project, readInstallation) {
  const proposed = checkedAppProject(project);
  if (proposed.source.kind !== 'public-app-installation' || !INSTALLATION.test(proposed.source.id)) {
    throw new Error('This app source has no current native build reader.');
  }
  const current = await readInstallation(proposed.source.id);
  if (current?.installation_id !== proposed.source.id) throw new Error('The installed app identity changed.');
  const live = appProjectFromPublicApp({ installation_id: current.installation_id,
    public_url: current.public_url, name: proposed.name, source: current });
  if (live.source.file_authority && proposed.source.file_authority) {
    const authority = live.source.file_authority;
    const includesRows = (whole, preview, key) => {
      const byKey = new Map(whole.map(row => [row[key], row]));
      return preview.every(row => JSON.stringify(byKey.get(row[key])) === JSON.stringify(row));
    };
    if (JSON.stringify(proposed.source) === JSON.stringify(live.source) &&
        JSON.stringify(proposed.outputs) === JSON.stringify(live.outputs) &&
        JSON.stringify(proposed.permissions) === JSON.stringify(live.permissions) &&
        JSON.stringify(proposed.capabilities) === JSON.stringify(live.capabilities) &&
        proposed.pages.length === authority.page_count &&
        proposed.pages.length + proposed.assets.length === authority.file_count &&
        includesRows(proposed.pages, live.pages, 'path') &&
        includesRows(proposed.assets, live.assets, 'path') &&
        includesRows(proposed.behaviors, live.behaviors, 'id')) return proposed;
    throw new Error('The installed app changed. Refresh its app project before building.');
  }
  if (JSON.stringify(live) !== JSON.stringify(proposed)) {
    throw new Error('The installed app changed. Refresh its app project before building.');
  }
  return live;
}
