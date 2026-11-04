import test from 'node:test';
import assert from 'node:assert/strict';
import { appProjectFromImportedSite, appProjectFromPublicApp, appProjectFromPublicAppDraft, checkedAppProject } from '../src/app-project.mjs';

const installation = 'a'.repeat(32);

test('folder import describes editable routes, kept files, and absent backend and native source', () => {
  const imported = {
    can_publish: true,
    files: {
      'index.html': '<!doctype html><title>Home</title><script src="app.js"></script>',
      'about/index.html': '<!doctype html><title>About</title>',
      'app.js': 'document.title = "Ready";',
      'images/logo.png': 'data:image/png;base64,iVBORw0KGgo=',
    }, warnings: ['Inline scripts may be blocked.'],
  };
  const project = appProjectFromImportedSite({ id: 'sample-site', name: 'Sample', imported });
  assert.deepEqual(project.pages.map(page => [page.path, page.source_path, page.presenter.kind]), [
    ['/', 'index.html', 'editable-file'], ['/about/', 'about/index.html', 'editable-file'],
  ]);
  assert.deepEqual(project.assets.map(asset => asset.path), ['app.js', 'images/logo.png']);
  assert.deepEqual(project.behaviors, [{ id: 'script:app.js', kind: 'local-script', source_path: 'app.js' }]);
  assert.equal(project.source.coverage.server_code, 'not-imported');
  assert.equal(project.source.coverage.native_code, 'not-imported');
  assert.deepEqual(project.outputs.map(output => [output.target, output.status]), [
    ['web', 'draft'], ['ios', 'unsupported'], ['macos', 'unsupported'],
  ]);
  assert.deepEqual(checkedAppProject(project), project);
});

test('URL copy keeps skipped source findings and does not claim complete route coverage', () => {
  const project = appProjectFromImportedSite({ id: 'copied-site', name: 'Copied', imported: {
    can_publish: true,
    files: { 'index.html': '<h1>Copied</h1>' },
    source_url: 'https://example.com/original/?view=full',
    skipped: [{ address: 'https://example.com/private', reason: 'Sign-in required' }], warnings: [],
  } });
  assert.equal(project.source.origin_url, 'https://example.com/original/?view=full');
  assert.equal(project.source.coverage.routes, 'source-dependent');
  assert.equal(project.source.coverage.browser_code, 'not-imported');
  assert.deepEqual(project.source.skipped, [{ address: 'https://example.com/private', reason: 'Sign-in required' }]);
});

test('indexed folder previews retain bounded pages while carrying the full file authority', () => {
  const files = { 'index.html': '<h1>Home</h1>' };
  for (let page = 1; page < 200; page++) files[`page-${String(page).padStart(3, '0')}.html`] = `<h1>${page}</h1>`;
  for (let asset = 0; asset < 312; asset++) files[`asset-${String(asset).padStart(3, '0')}.txt`] = 'x';
  const authority = { schema: 'trillion.public-app-file-index', version: 1, root: 'a'.repeat(64),
    file_count: 600, byte_count: 100_000, page_count: 250 };
  const project = appProjectFromImportedSite({ id: 'large-site', name: 'Large site', imported: {
    can_publish: true, files, files_index: authority, warnings: [],
  } });
  assert.equal(project.pages.length, 200);
  assert.deepEqual(project.source.file_authority, authority);
  assert.equal(project.source.revision, `1f:${authority.root}`);
  assert.deepEqual(checkedAppProject(project), project);
  assert.throws(() => appProjectFromImportedSite({ id: 'bad-preview', name: 'Bad preview', imported: {
    can_publish: true, files, files_index: { ...authority, byte_count: 1 }, warnings: [],
  } }), /exceeds its indexed authority/);
});

test('a published URL copy still says its original browser code was not imported', () => {
  const source = { id: 'copied', actions: [], files: { 'index.html': '<h1>Copied</h1>' },
    project_origin: { kind: 'public-url-copy', origin_url: 'https://example.com/', skipped: [], warnings: [] } };
  const project = appProjectFromPublicApp({ installation_id: installation,
    public_url: 'https://copied.sites.gettrillion.ai/', name: 'Copied', source });
  assert.equal(project.source.coverage.browser_code, 'not-imported');
  assert.equal(project.source.coverage.server_code, 'not-imported');
  assert.equal(project.source.coverage.native_code, 'not-imported');
});

test('publishing changes output status but never claims original server or native code', () => {
  const source = { id: 'sample', actions: [{ id: 'contact', record_kind: 'contacts', fields: [] }],
    files: { 'index.html': '<h1>Published</h1>', 'app.js': 'console.log("kept")' } };
  const project = appProjectFromPublicApp({ installation_id: installation,
    public_url: 'https://sample.sites.gettrillion.ai/', name: 'Sample', source });
  assert.deepEqual(project.behaviors.map(row => row.kind), ['visitor-action', 'local-script']);
  assert.equal(project.outputs[0].status, 'published');
  assert.equal(project.outputs[1].presenter, 'webview');
  assert.equal(project.source.coverage.server_code, 'not-imported');
  assert.equal(project.source.coverage.native_code, 'not-imported');
  assert.throws(() => checkedAppProject({ ...project, assets: [{ path: '../secret.js', media_type: 'text/javascript; charset=utf-8' }] }),
    /invalid path|file path/i);
});

test('indexed public app source keeps its server revision and file authority through draft adaptation', async () => {
  const authority = { schema: 'trillion.public-app-file-index', version: 1, root: 'd'.repeat(64),
    file_count: 900, byte_count: 9_000, page_count: 240 };
  const source = { id: 'sample', actions: [], files: { 'index.html': '<h1>Home</h1>' },
    file_index: authority, revision: `1f:${'e'.repeat(64)}` };
  const project = appProjectFromPublicApp({ installation_id: installation,
    public_url: 'https://sample.sites.gettrillion.ai/', name: 'Sample', source });
  assert.equal(project.source.revision, source.revision);
  assert.deepEqual(project.source.file_authority, authority);
  assert.deepEqual(checkedAppProject(project), project);
  const draft = appProjectFromPublicAppDraft({ installation_id: installation,
    public_url: 'https://sample.sites.gettrillion.ai/', name: 'Sample', draft: source });
  assert.equal(draft.source.revision, source.revision);
  assert.deepEqual(draft.source.file_authority, authority);
  assert.equal(draft.pages[0].presenter.kind, 'editable-file');
  assert.throws(() => appProjectFromPublicApp({ installation_id: installation,
    public_url: 'https://sample.sites.gettrillion.ai/', name: 'Sample', source: { ...source, revision: undefined } }),
  /exact revision/);
});

test('shared project can describe a native source without claiming a native publisher exists', () => {
  const version = `1f:${'d'.repeat(64)}`;
  const project = checkedAppProject({ schema: 'trillion.app-project', id: 'sample-native', name: 'Sample',
    source: { kind: 'repository-source', id: 'repo:sample', revision: version,
      coverage: { routes: 'kept', assets: 'kept', browser_code: 'not-imported', server_code: 'source-dependent',
        sign_in: 'source-dependent', native_code: 'kept' } },
    pages: [{ id: 'home', path: '/', source_path: 'App/Home.swift',
      presenter: { kind: 'native-screen', ref: { kind: 'swift-view', id: 'home', version } } }],
    assets: [{ path: 'Assets/icon.heic', media_type: 'image/heic' }],
    behaviors: [{ id: 'open-home', kind: 'source-module', source_path: 'App/Navigation.swift' }],
    capabilities: [], permissions: [{ kind: 'camera', purpose: 'Take a picture for the customer.' }],
    outputs: [{ target: 'ios', presenter: 'native-screen', status: 'unsupported',
      reason: 'No native source publisher is connected.' }],
  });
  assert.equal(project.pages[0].presenter.kind, 'native-screen');
  assert.deepEqual(project.outputs.map(row => row.target), ['ios']);
  assert.throws(() => checkedAppProject({ ...project, pages: [{ ...project.pages[0], source_path: '../Home.swift' }] }),
    /source file|file path/i);
});
