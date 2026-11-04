// test/public-app-element-addresses.test.mjs
//
// Every drawn element of an app page gets an address that stays with it (src/public-app-element-addresses.mjs), the
// editor reads and saves pages with them, and an AI edit can change one element by its address.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pageElements, setElement, withElementAddresses } from '../../shared-code/src/public-app-element-addresses.mjs';
import { applyGrapesJsExport, applyPublicAppEditorCommands, checkedPublicAppEditorSource, grapesJsImportModel } from '../src/public-app-editor-model.mjs';

const PAGE = `<!doctype html><html><head><title>A <b>title</b></title><style>.a > p { color: red }</style>
<script>if (1 < 2) document.write('<p>no</p>')</script></head>
<body><!-- <div>not a tag</div> --><main class="a"><h1>Hello</h1><p data-x='1 > 0'>Words &amp; more</p><img src="a.png"/></main></body></html>`;

test('every drawn element gets an address; comments, scripts, styles and the head do not', () => {
  const addressed = withElementAddresses(PAGE);
  assert.deepEqual(pageElements(addressed).map(e => [e.element, e.tag]), [['e0', 'body'], ['e1', 'main'], ['e2', 'h1'], ['e3', 'p'], ['e4', 'img']]);
  assert.match(addressed, /<img src="a.png" data-trillion-element="e4"\/>/);
  assert.match(addressed, /<!-- <div>not a tag<\/div> -->/);
  assert.match(addressed, /document\.write\('<p>no<\/p>'\)/);
  assert.equal(withElementAddresses(addressed), addressed, 'a fully addressed page is unchanged');
});

test('addresses stay put: a new element gets the next one, and a pasted copy gets its own', () => {
  const addressed = withElementAddresses(PAGE);
  const edited = addressed.replace('<h1 data-trillion-element="e2">Hello</h1>', '<h2>New</h2><h1 data-trillion-element="e2">Hello</h1><h1 data-trillion-element="e2">Hello</h1>');
  const again = pageElements(withElementAddresses(edited));
  assert.deepEqual(again.map(e => `${e.tag}:${e.element}`), ['body:e0', 'main:e1', 'h2:e5', 'h1:e2', 'h1:e6', 'p:e3', 'img:e4']);
});

test('one element changes by its address: attributes set and removed, words replaced, safely written', () => {
  const addressed = withElementAddresses(PAGE);
  const changed = setElement(addressed, { element: 'e3', attributes: { 'data-x': null, class: 'lead "big"' }, text: 'Fish < chips' });
  assert.match(changed, /<p data-trillion-element="e3" class="lead &quot;big&quot;">Fish &lt; chips<\/p>/);
  assert.throws(() => setElement(addressed, { element: 'e1', text: 'x' }), /holds more than words/);
  assert.throws(() => setElement(addressed, { element: 'e9', text: 'x' }), /No element e9/);
  assert.throws(() => setElement(addressed, { element: 'e3', attributes: { 'data-trillion-element': 'e7' } }), /cannot be set/);
});

test('the editor reads and saves addressed pages, and an AI edit can name an element', () => {
  const app = checkedPublicAppEditorSource({ id: 'site', actions: [], files: { 'index.html': PAGE } });
  const opened = grapesJsImportModel(app);
  assert.match(opened.html, /<h1 data-trillion-element="e2">Hello<\/h1>/);
  const saved = applyGrapesJsExport(app, { html: '<main><h1>Hi</h1></main>', css: '', expectedRevision: app.revision });
  assert.match(saved.files['index.html'], /<main data-trillion-element="e0"><h1 data-trillion-element="e1">Hi<\/h1><\/main>/);
  const edited = applyPublicAppEditorCommands(app, { expectedRevision: app.revision, commands: [{ type: 'set-element', path: 'index.html', element: 'e2', text: 'Welcome' }] });
  assert.match(edited.files['index.html'], /<h1 data-trillion-element="e2">Welcome<\/h1>/);
  assert.match(edited.files['index.html'], /<p data-x='1 > 0' data-trillion-element="e3">/, 'the rest of the page keeps its addresses');
});
