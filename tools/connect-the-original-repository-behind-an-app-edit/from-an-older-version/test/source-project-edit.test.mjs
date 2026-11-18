import test from 'node:test';
import assert from 'node:assert/strict';
import { applySourceEdit, resolveSourceSelection, sourceSelectionFingerprint } from '../src/source-project-edit.mjs';

const commit = 'a'.repeat(40);
const file_sha = 'b'.repeat(40);
const selected = (tag, text, attributes, extra = {}) => {
  const selection = { project_id: 'project-one', revision: commit, route: '/about', frame: 'main',
    element: { tag, text, attributes, selector: `#${attributes.id ?? 'chosen'}` }, ...extra };
  return { ...selection, fingerprint: sourceSelectionFingerprint(selection) };
};
const resolve = (selection, path, source) => resolveSourceSelection({ selection, path, source, file_sha, commit });

test('a marked HTML element resolves and changes only its literal text span', () => {
  const source = '<main>\n  <h1 id="hero" data-trillion-source="hero-title">  Welcome &amp; stay  </h1>\n  <button>Continue</button>\n</main>\n';
  const selection = selected('h1', 'Welcome & stay', { id: 'hero', 'data-trillion-source': 'hero-title' });
  const found = resolve(selection, 'index.html', source);
  assert.equal(found.status, 'resolved');
  assert.equal(found.locator.evidence.marker, 'hero-title');
  const edit = applySourceEdit({ source, file_sha, commit, locator: found.locator, intent: { kind: 'text', value: 'Come <inside>' } });
  assert.equal(edit.status, 'ready');
  assert.equal(edit.content, source.replace('Welcome &amp; stay', 'Come &lt;inside&gt;'));
  assert.match(edit.content, /<button>Continue<\/button>/);
  assert.equal(applySourceEdit({ source: `${source} `, file_sha, commit, locator: found.locator,
    intent: { kind: 'text', value: 'New' } }).status, 'conflict');
});

test('a unique unmarked JSX element uses rendered text, stable attributes, ancestry and revision', () => {
  const source = `export default function App() {
  return <section id="pricing"><h2 className="plan-title" data-testid="plan-heading">Starter plan</h2></section>;
}\n`;
  const selection = selected('h2', 'Starter plan', { class: 'plan-title', 'data-testid': 'plan-heading' },
    { ancestors: [{ tag: 'section', attributes: { id: 'pricing' } }] });
  const found = resolveSourceSelection({ selection, files: { 'src/App.tsx': source }, file_shas: { 'src/App.tsx': file_sha },
    project: { id: 'project-one', revision: commit }, complete_source_set: true });
  assert.equal(found.status, 'resolved');
  assert.deepEqual(found.locator.evidence.attributes, ['data-testid', 'class']);
  const edit = applySourceEdit({ source, file_sha, commit, locator: found.locator, intent: { kind: 'text', value: 'Better plan' } });
  assert.equal(edit.status, 'ready');
  assert.equal(edit.content, source.replace('Starter plan</h2>', 'Better plan</h2>'));
  assert.equal(resolveSourceSelection({ selection: { ...selection, revision: 'c'.repeat(40) }, files: { 'src/App.tsx': source },
    project: { id: 'project-one', revision: commit }, complete_source_set: true }).status, 'conflict');
});

test('unmarked Vue and Svelte source can resolve uniquely across bounded candidate files', () => {
  const selection = selected('p', 'A simple answer', { id: 'answer' });
  const files = {
    'src/Page.vue': '<template><p id="answer">A simple answer</p></template>',
    'src/Other.svelte': '<p id="other">A different answer</p>',
    'dist/index.html': '<p id="answer">A simple answer</p>',
  };
  const ambiguous = resolveSourceSelection({ project: { id: 'project-one', revision: commit }, selection, files, complete_source_set: true });
  assert.equal(ambiguous.status, 'ambiguous');
  delete files['dist/index.html'];
  const found = resolveSourceSelection({ project: { id: 'project-one', revision: commit }, selection, files, complete_source_set: true });
  assert.equal(found.status, 'resolved');
  assert.equal(found.locator.path, 'src/Page.vue');
});

test('a duplicate marker is ambiguous and a marker inside a script string is ignored', () => {
  const selection = selected('h1', 'Title', { 'data-trillion-source': 'shared' });
  const source = '<h1 data-trillion-source="shared">Title</h1><h1 data-trillion-source="shared">Other</h1>';
  assert.equal(resolve(selection, 'index.html', source).status, 'ambiguous');
  const script = 'const fake = "<h1 data-trillion-source=\\"shared\\">Wrong</h1>"; return <h1 data-trillion-source="shared">Title</h1>;';
  assert.equal(resolve(selection, 'src/View.jsx', script).status, 'resolved');
});

test('existing inline CSS and JSX style literals keep their surrounding syntax', () => {
  const html = '<h1 data-trillion-source="heading" style="color: red; padding: 8px">Title</h1>';
  const selection = selected('h1', 'Title', { 'data-trillion-source': 'heading' });
  const htmlLocator = resolve(selection, 'index.html', html).locator;
  const htmlEdit = applySourceEdit({ source: html, file_sha, commit, locator: htmlLocator,
    intent: { kind: 'style', property: 'color', value: 'blue' } });
  assert.equal(htmlEdit.content, html.replace('color: red', 'color: blue'));

  const jsx = 'export default () => <h1 data-trillion-source="heading" style={{ color: \'red\', padding: \'8px\' }}>Title</h1>;';
  const jsxLocator = resolve(selection, 'src/View.tsx', jsx).locator;
  const jsxEdit = applySourceEdit({ source: jsx, file_sha, commit, locator: jsxLocator,
    intent: { kind: 'style', property: 'color', value: 'blue' } });
  assert.equal(jsxEdit.status, 'ready');
  assert.equal(jsxEdit.content, jsx.replace("color: 'red'", "color: 'blue'"));
});

test('safe existing link, local image, and class attributes change only their quoted value', () => {
  const link = '<a data-trillion-source="cta" href="/old?a=1&amp;b=2">Read more</a>';
  const linkSelection = selected('a', 'Read more', { 'data-trillion-source': 'cta', href: '/old?a=1&b=2' });
  const linkLocator = resolve(linkSelection, 'index.html', link).locator;
  const linkEdit = applySourceEdit({ source: link, file_sha, commit, locator: linkLocator,
    intent: { kind: 'attribute', name: 'href', value: '/new?a=1&b=2' } });
  assert.equal(linkEdit.status, 'ready');
  assert.equal(linkEdit.content, link.replace('/old?a=1&amp;b=2', '/new?a=1&amp;b=2'));

  const image = `export default () => <img data-trillion-source="hero" src='../images/old.png' className='old-hero' alt='Hero' />;`;
  const imageSelection = selected('img', '', { 'data-trillion-source': 'hero', src: '../images/old.png' });
  const imageLocator = resolve(imageSelection, 'src/Page.tsx', image).locator;
  const imageEdit = applySourceEdit({ source: image, file_sha, commit, locator: imageLocator,
    intent: { kind: 'attribute', name: 'src', value: '../images/new.png' } });
  assert.equal(imageEdit.status, 'ready');
  assert.equal(imageEdit.content, image.replace('../images/old.png', '../images/new.png'));

  const classEdit = applySourceEdit({ source: image, file_sha, commit, locator: imageLocator,
    intent: { kind: 'attribute', name: 'class', value: 'hero-card md:hover:hero-card-wide' } });
  assert.equal(classEdit.status, 'ready');
  assert.equal(classEdit.content, image.replace("className='old-hero'", "className='hero-card md:hover:hero-card-wide'"));
});

test('attribute edits reject unsafe URLs, element mismatches, dynamic values, and missing attributes', () => {
  const source = '<img data-trillion-source="photo" src="photos/current.png" alt="Portrait">';
  const selection = selected('img', '', { 'data-trillion-source': 'photo', src: 'photos/current.png' });
  const locator = resolve(selection, 'index.html', source).locator;
  const attempt = value => applySourceEdit({ source, file_sha, commit, locator,
    intent: { kind: 'attribute', name: 'src', value } });
  assert.equal(attempt('javascript:alert(1)').status, 'unsupported');
  assert.equal(attempt('//tracking.example/pixel.png').status, 'unsupported');
  assert.equal(attempt('data:image/svg+xml,<svg/>').status, 'unsupported');
  assert.equal(applySourceEdit({ source, file_sha, commit, locator,
    intent: { kind: 'attribute', name: 'href', value: 'https://example.com/' } }).status, 'unsupported');
  const dynamicSource = '<img data-trillion-source="photo" src={imagePath} alt="Portrait">';
  const dynamicSelection = selected('img', '', { 'data-trillion-source': 'photo', src: 'photos/current.png' });
  const dynamicLocator = resolve(dynamicSelection, 'src/Page.tsx', dynamicSource).locator;
  assert.equal(applySourceEdit({ source: dynamicSource, file_sha, commit, locator: dynamicLocator,
    intent: { kind: 'attribute', name: 'src', value: 'photos/new.png' } }).status, 'unsupported');
});

test('dynamic child text, missing style and weak fallback fail explicitly', () => {
  const selection = selected('h1', 'Hello', { id: 'greeting' });
  assert.equal(resolveSourceSelection({ selection, files: { 'src/View.tsx': 'return <h1 id="greeting">{name}</h1>' },
    project: { id: 'project-one', revision: commit }, complete_source_set: true }).status, 'unsupported');
  const weak = selected('h1', 'Hello', {});
  assert.equal(resolve(weak, 'src/View.tsx', 'return <h1>Hello</h1>').status, 'unsupported');
  const markup = '<h1 id="greeting">Hello</h1>';
  const found = resolveSourceSelection({ selection, files: { 'index.html': markup }, file_shas: { 'index.html': file_sha },
    project: { id: 'project-one', revision: commit }, complete_source_set: true });
  assert.equal(found.status, 'resolved');
  assert.equal(applySourceEdit({ source: markup, file_sha, commit, locator: found.locator,
    intent: { kind: 'style', property: 'color', value: 'blue' } }).status, 'unsupported');
});

test('an unsupported template with the same element evidence prevents false attribution', () => {
  const selection = selected('h1', 'Starter plan', { id: 'plan' });
  const result = resolveSourceSelection({ selection, project: { id: 'project-one', revision: commit },
    files: { 'src/App.tsx': 'return <h1 id="plan">Starter plan</h1>;',
      'src/Page.astro': '<h1 id="plan">Starter plan</h1>' }, complete_source_set: true });
  assert.equal(result.status, 'unsupported');
});

test('repeated data-backed rendered text yields bounded candidates without choosing a source', () => {
  const selection = selected('h1', 'Navigate better with shared context', { class: 'hero' }, { route: '/' });
  const files = {
    'src/Page.tsx': 'return <h1 className="hero">{copy.hero[0]} {copy.hero[1]}</h1>;',
    'src/copy.ts': "const copy = { hero: ['Navigate better', 'with shared context'] };",
    'src/pages.json': '{"heading":"Navigate better with shared context"}',
  };
  for (let index = 0; index < 140; index++) files[`src/other-${index}.json`] = index < 10
    ? '{"heading":"Navigate better with shared context"}' : '{"heading":"A different page"}';
  const result = resolveSourceSelection({ selection, project: { id: 'project-one', revision: commit },
    files, complete_source_set: true });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.locator, undefined);
  assert.equal(result.candidate_count, 12);
  assert.equal(result.candidate_files.length, 8);
  assert.equal(result.candidate_files[0].match, 'full_text');
  assert.ok(result.candidate_files.every(row => !('source' in row)));
});

test('a unique JSON-backed rendered string resolves and edits only that pinned data value', () => {
  const selection = selected('h1', 'A durable heading', { class: 'hero' }, { route: '/guide/' });
  const files = { 'src/Guide.tsx': 'return <h1 className="hero">{copy.guide.heading}</h1>;',
    'src/copy.json': '{\n  "guide": { "heading": "A durable heading", "other": "Leave this alone" }\n}' };
  const found = resolveSourceSelection({ project: { id: 'project-one', revision: commit }, selection,
    files, file_shas: { 'src/copy.json': file_sha }, complete_source_set: true });
  assert.equal(found.status, 'resolved');
  assert.equal(found.locator.path, 'src/copy.json');
  assert.equal(found.locator.language, 'json');

  const edit = applySourceEdit({ source: files['src/copy.json'], file_sha, commit, locator: found.locator,
    intent: { kind: 'text', value: 'A heading that helps people choose' } });
  assert.equal(edit.status, 'ready');
  assert.deepEqual(JSON.parse(edit.content), { guide: { heading: 'A heading that helps people choose', other: 'Leave this alone' } });
  assert.equal(applySourceEdit({ source: `${files['src/copy.json']} `, file_sha, commit, locator: found.locator,
    intent: { kind: 'text', value: 'Changed' } }).status, 'conflict');
});

test('repeated JSON copy values stay ambiguous instead of choosing one data field', () => {
  const selection = selected('h1', 'Same heading everywhere', { class: 'hero' });
  const files = { 'src/home.json': '{"heading":"Same heading everywhere"}',
    'src/guide.json': '{"heading":"Same heading everywhere"}' };
  const found = resolveSourceSelection({ project: { id: 'project-one', revision: commit }, selection,
    files, complete_source_set: true });
  assert.equal(found.status, 'ambiguous');
  assert.equal(found.locator, undefined);
});
