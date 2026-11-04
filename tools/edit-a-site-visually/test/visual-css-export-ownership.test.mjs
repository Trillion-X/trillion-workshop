// test/visual-css-export-ownership.test.mjs
//
// Purpose: saving a page from the visual editor never writes its styles into a stylesheet another page shares, and a
// page linking several sheets keeps one combined sheet in their place (audit finding 68). The editor imports every
// linked sheet as one stylesheet; the export used to write that combination into the first linked file, leaving the
// second still linked (later in the cascade, overriding the edit) and giving every other page linking the first file
// this page's rules. It runs the real import and export.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGrapesJsExport, checkedPublicAppEditorSource, cssLinks, grapesJsImportModel } from '../src/public-app-editor-model.mjs';

const app = () => checkedPublicAppEditorSource({
  id: 'app',
  actions: [],
  files: {
    'index.html': '<html><head><link rel="stylesheet" href="a.css"><link rel="stylesheet" href="b.css"></head><body><h1>Home</h1></body></html>',
    'about.html': '<html><head><link rel="stylesheet" href="a.css"></head><body><h1>About</h1></body></html>',
    'a.css': 'h1 { color: red }',
    'b.css': 'p { color: gray }',
  },
});

test('a page linking several sheets saves into one sheet it owns, in their place (finding 68)', () => {
  const source = app();
  const model = grapesJsImportModel(source, { htmlPath: 'index.html' });
  assert.deepEqual(model.css_paths, ['a.css', 'b.css']);
  const saved = applyGrapesJsExport(source, { htmlPath: 'index.html', html: model.html, css: 'h1 { color: blue }\np { color: gray }', expectedRevision: source.revision });
  assert.equal(saved.files['a.css'], 'h1 { color: red }', 'the sheet the about page shares is unchanged');
  assert.equal(saved.files['b.css'], 'p { color: gray }');
  assert.deepEqual(cssLinks(saved.files['index.html'], 'index.html'), ['index.editor.css'], 'one sheet in place of the represented ones');
  assert.equal(saved.files['index.editor.css'], 'h1 { color: blue }\np { color: gray }');
  assert.deepEqual(cssLinks(saved.files['about.html'], 'about.html'), ['a.css']);
});

test("a page's own single sheet is still saved in place", () => {
  const source = checkedPublicAppEditorSource({ id: 'app', actions: [], files: { 'index.html': '<html><head><link rel="stylesheet" href="site.css"></head><body><h1>Hi</h1></body></html>', 'site.css': 'h1{color:red}' } });
  const model = grapesJsImportModel(source, { htmlPath: 'index.html' });
  const saved = applyGrapesJsExport(source, { htmlPath: 'index.html', html: model.html, css: 'h1{color:blue}', expectedRevision: source.revision });
  assert.equal(saved.files['site.css'], 'h1{color:blue}');
  assert.deepEqual(cssLinks(saved.files['index.html'], 'index.html'), ['site.css']);
});
