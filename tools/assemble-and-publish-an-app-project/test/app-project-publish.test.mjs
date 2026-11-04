import test from 'node:test';
import assert from 'node:assert/strict';
import { appProjectFromImportedSite } from '../src/app-project.mjs';
import { assembleEditableAppProject } from '../src/app-project-assembly.mjs';
import { publicAppDefinitionFromImportedProject } from '../src/app-project-publish.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const ref = (media_type, size) => ({
  blob_ref: `maker:${'a'.repeat(64)}:1f:${'b'.repeat(64)}`, media_type, size,
});
// A completed upload of these exact words, named by their identity as the file store names it.
const uploadOf = (content, media_type) => {
  const bytes = new TextEncoder().encode(content);
  return { blob_ref: `maker:${'a'.repeat(64)}:1f:${bytesToHex(blake3(bytes))}`, media_type, size: bytes.length };
};

test('folder project publishes only after every checked source file has uploaded', () => {
  const imported = { can_publish: true, files: { 'index.html': '<h1>Home</h1>', 'styles.css': 'h1{color:blue}' }, warnings: [] };
  const project = appProjectFromImportedSite({ id: 'my-site', name: 'My site', imported });
  const uploaded = {
    'index.html': ref('text/html; charset=utf-8', 13),
    'styles.css': ref('text/css; charset=utf-8', 14),
  };
  assert.deepEqual(publicAppDefinitionFromImportedProject(project, imported, uploaded),
    { id: 'my-site', actions: [], files: uploaded,
      project_origin: { kind: 'site-folder', skipped: [], warnings: [] } });
  assert.throws(() => publicAppDefinitionFromImportedProject(project, imported, { 'index.html': uploaded['index.html'] }),
    /Every site file/);
  assert.throws(() => publicAppDefinitionFromImportedProject(project,
    { ...imported, files: { ...imported.files, 'index.html': '<h1>Changed</h1>' } }, uploaded), /imported site changed/);
});

test('public URL project keeps its source details when publishing from a saved copy', () => {
  const imported = { can_publish: true, files: {
    'index.html': '<h1>Copied</h1>', 'trillion-import.json': '{"source_url":"https://example.com/"}',
  }, source_url: 'https://example.com/', source_file_path: 'trillion-import.json',
  site_file_identity: `1f:${'c'.repeat(64)}`, skipped: [], warnings: [] };
  const project = appProjectFromImportedSite({ id: 'copy-site', name: 'Copy', imported });
  assert.deepEqual(publicAppDefinitionFromImportedProject(project, imported), {
    id: 'copy-site', actions: [], files_from: imported.site_file_identity,
    files: { 'trillion-import.json': imported.files['trillion-import.json'] },
    project_origin: { kind: 'public-url-copy', origin_url: 'https://example.com/', skipped: [], warnings: [] },
  });
});

test('browser folder imports publish only the finalized owner-scoped import handle', () => {
  const fileImport = { import_id: 'a'.repeat(32), session_id: '12345678-1234-1234-1234-123456789abc' };
  const imported = { can_publish: true, files: { 'index.html': '<h1>Home</h1>' }, file_import: fileImport,
    files_index: { schema: 'trillion.public-app-file-index', version: 1, root: 'd'.repeat(64),
      file_count: 800, byte_count: 80_000, page_count: 220 }, warnings: [] };
  const project = appProjectFromImportedSite({ id: 'browser-site', name: 'Browser site', imported });
  assert.deepEqual(publicAppDefinitionFromImportedProject(project, imported), {
    id: 'browser-site', actions: [], file_import: fileImport,
    project_origin: { kind: 'site-folder', skipped: [], warnings: [] },
  });
  assert.throws(() => publicAppDefinitionFromImportedProject(project, imported,
    { 'index.html': uploadOf('<h1>Home</h1>', 'text/html; charset=utf-8') }), /cannot be combined/);
  assert.throws(() => publicAppDefinitionFromImportedProject(project,
    { ...imported, file_import: { ...fileImport, session_id: '12345678-1234-1234-1234-123456789abd' } }), /site import changed/);
});

test('segmented copied sites publish through the saved identity with only bounded overrides', () => {
  const imported = { can_publish: true, files: {
    'index.html': '<h1>Copied</h1>', 'trillion-import.json': '{"source_url":"https://example.com/"}',
  }, files_index: { schema: 'trillion.public-app-file-index', version: 1, root: 'a'.repeat(64),
    file_count: 700, byte_count: 70_000, page_count: 260 }, source_url: 'https://example.com/',
  source_file_path: 'trillion-import.json', site_file_identity: `1f:${'c'.repeat(64)}`, skipped: [], warnings: [] };
  const project = appProjectFromImportedSite({ id: 'large-copy', name: 'Large copy', imported });
  assert.deepEqual(publicAppDefinitionFromImportedProject(project, imported), {
    id: 'large-copy', actions: [], files_from: imported.site_file_identity,
    files: { 'trillion-import.json': imported.files['trillion-import.json'] },
    project_origin: { kind: 'public-url-copy', origin_url: 'https://example.com/', skipped: [], warnings: [] },
  });
  assert.throws(() => publicAppDefinitionFromImportedProject(project,
    { ...imported, files_index: { ...imported.files_index, root: 'b'.repeat(64) } }), /imported site changed/);
});

test('an indexed preview cannot publish as a complete flat site without its saved identity', () => {
  const imported = { can_publish: true, files: { 'index.html': '<h1>Home</h1>' },
    files_index: { schema: 'trillion.public-app-file-index', version: 1, root: 'a'.repeat(64),
      file_count: 900, byte_count: 90_000, page_count: 250 }, warnings: [] };
  const project = appProjectFromImportedSite({ id: 'large-site', name: 'Large site', imported });
  assert.throws(() => publicAppDefinitionFromImportedProject(project, imported,
    { 'index.html': uploadOf('<h1>Home</h1>', 'text/html; charset=utf-8') }), /saved file identity/);
});

test('the web publisher selects the web source from a checked multi-output project', () => {
  const imported = { can_publish: true, files: { 'index.html': '<h1>Copied</h1>' }, warnings: [] };
  const web = appProjectFromImportedSite({ id: 'copy-site', name: 'Copy', imported });
  const native = { schema: 'trillion.app-project', id: 'copy-site-native', name: 'Copy native',
    source: { kind: 'repository-source', id: 'github:example/copy-native@' + 'a'.repeat(40),
      revision: `1f:${'b'.repeat(64)}`, coverage: { routes: 'source-dependent', assets: 'source-dependent',
        browser_code: 'not-imported', server_code: 'source-dependent', sign_in: 'source-dependent', native_code: 'kept' } },
    pages: [{ id: 'app', path: '/', source_path: 'App/Home.swift',
      presenter: { kind: 'native-screen', ref: { kind: 'swift-view', id: 'home', version: `1f:${'c'.repeat(64)}` } } }],
    assets: [], behaviors: [], capabilities: [], permissions: [],
    outputs: ['ios', 'macos'].map(target => ({ target, presenter: 'native-screen', status: 'buildable' })) };
  const project = assembleEditableAppProject({ id: 'copy-site', name: 'Copy', sources: [
    { key: 'website', project: web, targets: ['web'] },
    { key: 'native', project: native, targets: ['ios', 'macos'] },
  ] });
  // A composed project is handed each web source's imported files and completed uploads by its key (631bdc09).
  const upload = uploadOf('<h1>Copied</h1>', 'text/html; charset=utf-8');
  const definition = publicAppDefinitionFromImportedProject(project, { website: imported }, { website: { 'index.html': upload } });
  assert.deepEqual(definition, {
    id: 'copy-site', actions: [], files: { 'index.html': upload },
    project_origin: { kind: 'site-folder', skipped: [], warnings: [] },
  });
  assert.throws(() => publicAppDefinitionFromImportedProject(project, { website: imported }, { website: { 'index.html': ref('text/html; charset=utf-8', 15) } }),
    /does not match the current source/, 'an upload of other words is refused');
});
