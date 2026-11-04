// Turn an imported project into the existing public-app publication request.
// The project is checked against the current imported bytes at the last write.
import { appProjectFromImportedSite, checkedAppProject, checkedAppProjectFileImport } from './app-project.mjs';
import { appProjectForTarget, checkedEditableAppProject } from './app-project-assembly.mjs';
import { copiedPublicSitePublication } from './public-app-import.mjs';
import { checkedPublicAppFile, checkedPublicAppFiles, MAX_PUBLIC_APP_BYTES, MAX_PUBLIC_APP_FILES } from '../../shared-code/src/public-app-files.mjs';
import { assertMountedWebFilesAreSafe, rewriteMountedWebFileContent, rewriteWebCapabilitySlots } from './app-project-output-composition.mjs';
import { mountedWebFile, webSourceMounts } from './app-project-web-mounts.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysEqual = (value, keys) => JSON.stringify(Object.keys(value ?? {}).sort()) === JSON.stringify([...keys].sort());

function currentFileImportHandle(source, imported) {
  const expected = source.file_import === undefined ? undefined : checkedAppProjectFileImport(source.file_import);
  const current = imported.file_import === undefined ? undefined : checkedAppProjectFileImport(imported.file_import);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error('The site import changed. Review it before publishing.');
  }
  return expected;
}

function sourceImportMatches(source, imported) {
  if (!object(imported) || !object(imported.files)) throw new Error(`The ${source.key} source import is unavailable.`);
  if (source.project.source.kind === 'public-app-installation') {
    if (source.key !== 'site' || imported.installation_revision !== source.project.source.revision) {
      throw new Error('The installed site changed. Reload it before publishing its sources.');
    }
    if (source.project.source.file_authority &&
        JSON.stringify(imported.file_index) !== JSON.stringify(source.project.source.file_authority)) {
      throw new Error('The installed site file index changed. Reload it before publishing its sources.');
    }
    const currentPaths = [...new Set([...source.project.pages.map(page => page.source_path),
      ...source.project.assets.map(asset => asset.path),
      ...source.project.behaviors.flatMap(behavior => behavior.source_path ? [behavior.source_path] : [])])].sort();
    if (!keysEqual(imported.files, currentPaths)) throw new Error('The installed site files changed. Reload it before publishing its sources.');
    return checkedPublicAppFiles(imported.files);
  }
  const current = appProjectFromImportedSite({ id: source.project.id, name: source.project.name, imported });
  // Placements and permissions are authored on the saved project. Every fact
  // about the imported files, routes, behavior, origin, and output stays owned
  // by the import and must still match at publication.
  const withProjectPlacements = { ...current, capabilities: source.project.capabilities,
    permissions: source.project.permissions };
  if (JSON.stringify(withProjectPlacements) !== JSON.stringify(source.project)) {
    throw new Error(`The ${source.key} imported site changed. Review it before publishing.`);
  }
  return checkedPublicAppFiles(imported.files);
}

function requireCompleteAuthorityPreview(source, imported) {
  const authority = source.project.source.file_authority;
  if (!authority || imported.site_file_identity || imported.file_import) return;
  const files = checkedPublicAppFiles(imported.files);
  const byteCount = Object.values(files).reduce((sum, file) => sum + file.size, 0);
  if (Object.keys(files).length !== authority.file_count || byteCount !== authority.byte_count) {
    throw new Error(`The ${source.key} indexed site needs its saved file identity before it can be published.`);
  }
}

function sourceUploadedFiles(source, imported, uploaded, mount, { useFilesFrom = false } = {}) {
  const paths = Object.keys(imported.files).sort();
  if (useFilesFrom) {
    const sourcePath = imported.source_file_path;
    if (!sourcePath || !Object.hasOwn(imported.files, sourcePath)) {
      throw new Error(`The ${source.key} copied site has no source details.`);
    }
    if (!Object.keys(uploaded).length) {
      const sourceFile = imported.files[sourcePath];
      const mountedText = mount && /\.html$|\.css$/i.test(sourcePath)
        ? rewriteMountedWebFileContent(source.key, mount, sourcePath, sourceFile) : sourceFile;
      const mapped = rewriteWebCapabilitySlots(source, sourcePath, mountedText);
      return { files: { [mountedWebFile(mount, sourcePath)]: mapped }, filesFrom: imported.site_file_identity };
    }
  }
  if (!keysEqual(uploaded, paths)) throw new Error(`Every ${source.key} site file must finish uploading before publishing.`);
  const files = {};
  for (const path of paths) {
    const targetPath = mountedWebFile(mount, path);
    const actual = checkedPublicAppFile(targetPath, uploaded[path]);
    const expected = checkedPublicAppFile(path, imported.files[path]);
    const expectedIdentity = expected.blob_ref
      ? expected.blob_ref.slice(expected.blob_ref.indexOf(':1f:'))
      : `:1f:${bytesToHex(blake3(expected.bytes))}`;
    if (!actual.blob_ref?.endsWith(expectedIdentity) || actual.size !== expected.size || actual.media_type !== expected.media_type) {
      throw new Error(`The uploaded ${source.key} file ${path} does not match the current source.`);
    }
    const mountedText = mount && /\.html$|\.css$/i.test(path)
      ? rewriteMountedWebFileContent(source.key, mount, path, imported.files[path])
      : imported.files[path];
    const composedText = rewriteWebCapabilitySlots(source, path, mountedText);
    files[targetPath] = composedText === imported.files[path] ? actual.source : composedText;
  }
  return { files, filesFrom: null };
}

function publicAppDefinitionFromAssembly(input, importedBySource, uploadedBySource) {
  const assembly = checkedEditableAppProject(input);
  const rows = assembly.outputs.find(row => row.target === 'web')?.sources ?? [];
  if (!rows.length) throw new Error('This app project does not support a web output.');
  if (!object(importedBySource) || !object(uploadedBySource) ||
      !keysEqual(importedBySource, rows.map(row => row.source)) ||
      Object.keys(uploadedBySource).some(key => !rows.some(row => row.source === key))) {
    throw new Error('Give each web source its current imported files and completed uploads.');
  }
  const proposed = checkedAppProject(appProjectForTarget(assembly, 'web'));
  const sources = rows.map(row => {
    const source = assembly.sources.find(item => item.key === row.source);
    if (!source || !source.targets.includes('web')) throw new Error(`The ${row.source} web source is unavailable.`);
    const output = source.project.outputs.find(item => item.target === 'web');
    if (!output || output.status === 'unsupported' || output.presenter !== row.presenter || output.status !== row.status) {
      throw new Error(`The ${row.source} web source no longer matches this app project.`);
    }
    return source;
  });
  if (sources.some(source => source.project.source.file_import || importedBySource[source.key]?.file_import)) {
    throw new Error('A saved site import must be published as one site source.');
  }
  if (!['site-folder', 'public-url-copy', 'public-app-installation'].includes(proposed.source.kind)) {
    throw new Error('Choose copied sites or site folders for a composed web output.');
  }

  const mounts = webSourceMounts(assembly.sources);
  const importedChecks = new Map();
  for (const source of sources) {
    const imported = importedBySource[source.key];
    const checked = sourceImportMatches(source, imported);
    requireCompleteAuthorityPreview(source, imported);
    importedChecks.set(source.key, checked);
    assertMountedWebFilesAreSafe(source.key, mounts.get(source.key) ?? '', imported.files);
  }

  const rootSource = sources.find(source => !(mounts.get(source.key) ?? ''));
  if (!rootSource) throw new Error('The composed web output has no home source.');
  const rootImported = importedBySource[rootSource.key];
  const rootUploads = uploadedBySource[rootSource.key] ?? {};
  const canUseFilesFrom = Boolean(rootImported.site_file_identity) && Object.keys(rootUploads).length === 0;
  const files = {};
  let filesFrom = null;
  for (const source of sources) {
    const imported = importedBySource[source.key];
    const uploaded = uploadedBySource[source.key] ?? {};
    const isRootIdentity = source === rootSource && canUseFilesFrom;
    const mapped = sourceUploadedFiles(source, imported, uploaded, mounts.get(source.key) ?? '', { useFilesFrom: isRootIdentity });
    if (mapped.filesFrom) {
      if (filesFrom) throw new Error('A composed web output can use one copied site file as its base.');
      filesFrom = mapped.filesFrom;
    }
    for (const [path, value] of Object.entries(mapped.files)) {
      if (Object.hasOwn(files, path)) throw new Error(`Two source projects publish the ${path} file.`);
      files[path] = value;
    }
  }

  let fileCount = 0;
  let totalBytes = 0;
  for (const checked of importedChecks.values()) {
    fileCount += Object.keys(checked).length;
    totalBytes += Object.values(checked).reduce((sum, file) => sum + file.size, 0);
  }
  if (fileCount > MAX_PUBLIC_APP_FILES || totalBytes > MAX_PUBLIC_APP_BYTES) {
    throw new Error(`The composed site exceeds the ${MAX_PUBLIC_APP_FILES} file or ${MAX_PUBLIC_APP_BYTES / 1_000_000} MB limit.`);
  }
  if (filesFrom) {
    for (const [path, content] of Object.entries(files)) checkedPublicAppFile(path, content);
    if (!Object.hasOwn(rootImported.files, 'index.html')) throw new Error('The copied home site has no index.html.');
  } else checkedPublicAppFiles(files);

  const pageById = new Map(proposed.pages.map(page => [page.id, page]));
  const placed_capabilities = proposed.capabilities.map(capability => {
    const page = pageById.get(capability.page_id);
    if (!page) throw new Error(`The ${capability.id} placement has no composed web page.`);
    return { id: capability.id, page_path: page.source_path, access: capability.access,
      capability: capability.ref, ...(capability.presentation ? { presentation: capability.presentation } : {}) };
  });
  const origin = proposed.source.kind === 'public-app-installation'
    ? rootImported.project_origin ?? rootSource.project.source.origin
    : { kind: proposed.source.kind,
      ...(proposed.source.origin_url ? { origin_url: proposed.source.origin_url } : {}),
      skipped: [], warnings: proposed.source.warnings ?? [] };
  const project_origin = origin ? {
    ...origin,
    warnings: [...new Set([...(origin.warnings ?? []), ...(proposed.source.warnings ?? [])])].slice(0, 100),
  } : undefined;
  return { id: proposed.id, actions: rootImported.actions ?? [], ...(filesFrom ? { files_from: filesFrom } : {}), files,
    ...(project_origin ? { project_origin } : {}),
    ...(placed_capabilities.length ? { placed_capabilities } : {}) };
}

export function publicAppDefinitionFromImportedProject(project, imported, uploadedFiles = {}) {
  if (project?.schema === 'trillion.editable-app-project') {
    return publicAppDefinitionFromAssembly(project, imported, uploadedFiles);
  }
  const proposed = checkedAppProject(project);
  if (!['site-folder', 'public-url-copy'].includes(proposed.source.kind)) {
    throw new Error('Choose a copied site or folder project.');
  }
  const fileImport = currentFileImportHandle(proposed.source, imported);
  const current = appProjectFromImportedSite({ id: proposed.id, name: proposed.name, imported });
  if (JSON.stringify(current) !== JSON.stringify(proposed)) {
    throw new Error('The imported site changed. Review it before publishing.');
  }
  if (proposed.source.file_authority && !imported.site_file_identity && !fileImport) {
    const files = checkedPublicAppFiles(imported.files);
    const byteCount = Object.values(files).reduce((sum, file) => sum + file.size, 0);
    if (Object.keys(files).length !== proposed.source.file_authority.file_count ||
        byteCount !== proposed.source.file_authority.byte_count) {
      throw new Error('The indexed site needs its saved file identity before it can be published.');
    }
  }
  const project_origin = { kind: proposed.source.kind,
    ...(proposed.source.origin_url ? { origin_url: proposed.source.origin_url } : {}),
    skipped: proposed.source.skipped ?? [], warnings: proposed.source.warnings ?? [] };
  if (fileImport) {
    if (!object(uploadedFiles) || Object.keys(uploadedFiles).length) {
      throw new Error('A saved site import cannot be combined with inline site files.');
    }
    return { id: proposed.id, actions: [], file_import: fileImport, project_origin };
  }
  if (imported.site_file_identity) {
    return { ...copiedPublicSitePublication(imported, proposed.id, imported.site_file_identity), project_origin };
  }
  const paths = Object.keys(imported.files).sort();
  if (JSON.stringify(Object.keys(uploadedFiles).sort()) !== JSON.stringify(paths)) {
    throw new Error('Every site file must finish uploading before publishing.');
  }
  checkedPublicAppFiles(uploadedFiles);
  return { id: proposed.id, actions: [], files: uploadedFiles, project_origin };
}
