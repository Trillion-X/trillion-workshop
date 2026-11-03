import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGrapesJsExport,
  checkedPublicAppEditorSource,
  grapesJsImportModel,
  publicAppEditorImageAssets,
  publicAppEditorPages,
  publicAppEditorRoute,
  publicAppEditorRoutePage,
  publicAppEditorRoutePages,
} from '../src/public-app-editor-model.mjs';

test('canvas styles resolve relative assets from each original stylesheet without changing source CSS', () => {
  const styles = 'h1{background:url(../../images/header.png?crop=1#art)}@import "../shared.css";p{mask:url(#icon);cursor:url(https://external.example/cursor.png),auto}';
  const source = checkedPublicAppEditorSource({ id: 'sheet-resources', actions: [], files: {
    'index.html': '<h1>Home</h1>',
    'about/index.html': '<link rel="stylesheet" href="../styles/nested/page.css"><h1>About</h1>',
    'styles/nested/page.css': styles,
  } });
  const model = grapesJsImportModel(source, { htmlPath: 'about/index.html' });
  assert.equal(model.route, '/about/');
  assert.deepEqual(model.css, [{ path: 'styles/nested/page.css', content: styles }]);
  assert.equal(model.canvas_css, 'h1{background:url(/images/header.png?crop=1#art)}@import "/styles/shared.css";p{mask:url(#icon);cursor:url(https://external.example/cursor.png),auto}');
  assert.equal(model.files['styles/nested/page.css'], styles);
  const saved = applyGrapesJsExport(source, { htmlPath: 'about/index.html', html: model.html,
    css: model.css.map(row => row.content).join('\n'), expectedRevision: source.revision });
  assert.equal(saved.files['styles/nested/page.css'], styles);
});

test('the visual editor lists only app-owned image files for placement', () => {
  const source = checkedPublicAppEditorSource({ id: 'with-assets', actions: [], files: {
    'index.html': '<h1>Home</h1>',
    'images/class-photo.png': 'data:image/png;base64,YQ==',
    'images/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"><title>Logo</title></svg>',
    'docs/guide.pdf': 'data:application/pdf;base64,YQ==',
    'scripts/site.js': 'console.log("site")',
  } });
  assert.deepEqual(publicAppEditorImageAssets(source), [
    { path: 'images/class-photo.png', url: '/images/class-photo.png', label: 'class photo', mediaType: 'image/png' },
    { path: 'images/logo.svg', url: '/images/logo.svg', label: 'logo', mediaType: 'image/svg+xml' },
  ]);
});

test('route list includes linked SPA routes without treating assets or external links as pages', () => {
  const source = checkedPublicAppEditorSource({
    id: 'multi-page',
    actions: [{ id: 'ask', record_kind: 'question', fields: [{ id: 'email', type: 'email', required: true }] }],
    files: {
      'index.html': '<html><body><div id="app"></div><a href="/features/">Features</a><a href="https://other.example/team/">Team</a><script type="module" src="/assets/app.js"></script></body></html>',
      'about/index.html': '<main><h1>About</h1></main>',
      'assets/app.js': 'const routes = [{ path: "/pricing" }, { path: "/api/status" }];',
      'assets/site.css': 'main { color: black }',
    },
  });

  assert.deepEqual(publicAppEditorPages(source), ['index.html', 'about/index.html']);
  const pages = publicAppEditorRoutePages(source);
  assert.deepEqual(pages.map(page => page.route), ['/', '/about/', '/features/', '/pricing/']);
  const features = publicAppEditorRoutePage(source, 'route:/features/');
  assert.equal(features.kind, 'client');
  assert.equal(features.html_path, 'index.html');
  assert.equal(features.visual_supported, false);
  const model = grapesJsImportModel(source, { htmlPath: features.html_path, route: features.route });
  assert.equal(model.route, '/features/');
  assert.equal(model.html_path, 'index.html');
});

test('editing a file-backed page preserves other pages and assets', () => {
  const source = checkedPublicAppEditorSource({
    id: 'multi-page',
    actions: [{ id: 'ask', record_kind: 'question', fields: [{ id: 'email', type: 'email', required: true }] }],
    files: {
      'index.html': '<h1>Home</h1>',
      'about/index.html': '<html><head><link rel="stylesheet" href="../shared.css"></head><body><h1>About</h1></body></html>',
      'shared.css': 'h1 { color: green }',
      'app.js': 'console.log("unchanged")',
    },
  });
  const model = grapesJsImportModel(source, { htmlPath: 'about/index.html' });
  assert.equal(publicAppEditorRoute('about/index.html'), '/about/');
  assert.deepEqual(model.css_paths, ['shared.css']);
  const edited = applyGrapesJsExport(source, {
    htmlPath: model.html_path,
    cssPath: model.css_paths[0],
    html: model.html.replace('About', 'Our story'),
    css: 'h1 { color: blue }',
    expectedRevision: source.revision,
  });
  assert.equal(edited.files['index.html'], source.files['index.html']);
  assert.equal(edited.files['app.js'], source.files['app.js']);
  assert.deepEqual(edited.actions, source.actions);
  assert.match(edited.files['about/index.html'], /Our story/);
  assert.equal(edited.files['shared.css'], 'h1 { color: blue }');
  assert.throws(() => grapesJsImportModel(source, { htmlPath: 'missing/index.html' }), /not part of this app/);
});

test('saving an inline-styled page keeps its head styles without inventing an empty CSS file', () => {
  const source = checkedPublicAppEditorSource({ id: 'inline-styles', actions: [], files: {
    'index.html': '<!doctype html><html><head><style>h1{color:forestgreen}</style></head><body><h1>Before</h1></body></html>',
  } });
  const model = grapesJsImportModel(source);
  assert.deepEqual(model.css_paths, []);
  const edited = applyGrapesJsExport(source, { html: model.html.replace('Before', 'After'), css: '', expectedRevision: source.revision });
  assert.deepEqual(Object.keys(edited.files), ['index.html']);
  assert.match(edited.files['index.html'], /<style>h1\{color:forestgreen\}<\/style>/);
  assert.match(edited.files['index.html'], /<h1 data-trillion-element="e1">After<\/h1>/);
  const styled = applyGrapesJsExport(edited, { html: edited.files['index.html'], css: 'h1{color:blue}', expectedRevision: edited.revision });
  assert.equal(styled.files['index.editor.css'], 'h1{color:blue}');
  assert.match(styled.files['index.html'], /<style>h1\{color:forestgreen\}<\/style>[\s\S]*<link rel="stylesheet" href="\/index\.editor\.css">/);
  const savedAgain = applyGrapesJsExport(styled, { html: styled.files['index.html'], css: 'h1{color:blue}', cssPath: 'index.editor.css', expectedRevision: styled.revision });
  assert.equal((savedAgain.files['index.html'].match(/index\.editor\.css/g) ?? []).length, 1);
});

test('a page-only edit keeps every linked stylesheet byte for other pages', () => {
  const source = checkedPublicAppEditorSource({ id: 'shared-styles', actions: [], files: {
    'index.html': '<html><head><link rel="stylesheet" href="/styles/base.css"></head><body><h1>Home</h1></body></html>',
    'pages/about.html': '<html><head><link rel="stylesheet" href="../styles/base.css"><link rel="stylesheet" href="../styles/about.css"></head><body><h1>About</h1></body></html>',
    'styles/base.css': 'body { margin: 3rem auto; }',
    'styles/about.css': 'h1 { color: navy; }',
  } });
  const model = grapesJsImportModel(source, { htmlPath: 'pages/about.html' });
  assert.deepEqual(model.css_paths, ['styles/base.css', 'styles/about.css']);
  const edited = applyGrapesJsExport(source, { htmlPath: model.html_path, html: model.html.replace('About', 'Our story'),
    css: model.css.map(file => file.content).join('\n'), cssPath: model.css_paths[0], expectedRevision: source.revision });
  assert.deepEqual(edited.changed_files, ['pages/about.html']);
  assert.equal(edited.files['styles/base.css'], source.files['styles/base.css']);
  assert.equal(edited.files['styles/about.css'], source.files['styles/about.css']);
  assert.equal(edited.files['index.html'], source.files['index.html']);
});
