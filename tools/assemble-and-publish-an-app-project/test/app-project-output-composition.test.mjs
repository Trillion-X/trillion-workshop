import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appProjectFromImportedSite, appProjectFromPublicAppDraft, checkedAppProject } from '../src/app-project.mjs';
import { appProjectForTarget, assembleEditableAppProject } from '../src/app-project-assembly.mjs';
import { publicAppDefinitionFromImportedProject } from '../src/app-project-publish.mjs';
import { rewriteMountedWebFileContent, unmountWebFileContent, rewriteWebCapabilitySlots, webCapabilityId } from '../src/app-project-output-composition.mjs';
import { checkedPublicAppEditorSource } from '../../edit-a-site-visually/src/public-app-editor-model.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const version = `1f:${'b'.repeat(64)}`;
const imported = (files, extras = {}) => ({ can_publish: true, files, warnings: [], ...extras });
const project = (id, name, source) => appProjectFromImportedSite({ id, name, imported: source });
const uploaded = files => Object.fromEntries(Object.entries(files).map(([path, content]) => {
  const bytes = new TextEncoder().encode(content);
  return [path, {
    blob_ref: `maker:${'a'.repeat(64)}:1f:${bytesToHex(blake3(bytes))}`,
    media_type: path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'image/svg+xml',
    size: bytes.length,
  }];
}));

test('mounted HTML and CSS edits recover source-relative links without changing their published routes', () => {
  const source = '<a href="/guide.html?from=home&amp;kind=notes">Guide</a><img srcset="/assets/a.svg 1x, /assets/b.svg 2x">';
  const mounted = rewriteMountedWebFileContent('notes', '/notes', 'index.html', source);
  const edited = mounted.replace('Guide</a>', 'Edited guide</a>');
  const restored = unmountWebFileContent('notes', '/notes', 'index.html', edited);
  assert.equal(restored, source.replace('Guide</a>', 'Edited guide</a>'));
  assert.equal(rewriteMountedWebFileContent('notes', '/notes', 'index.html', restored), edited);
  const css = 'h1 { color: teal; background: url("/assets/mark.svg?size=2"); }';
  const mountedCss = rewriteMountedWebFileContent('notes', '/notes', 'styles.css', css);
  const editedCss = mountedCss.replace('teal', 'orange');
  assert.equal(unmountWebFileContent('notes', '/notes', 'styles.css', editedCss), css.replace('teal', 'orange'));
  assert.throws(() => unmountWebFileContent('notes', '/notes', 'index.html', '<a href="/elsewhere/">Home</a>'), /outside its/);
});

test('mounted pages keep only Trillion capability runtime assets at the app root', () => {
  const source = '<link rel="stylesheet" href="/capabilities/runtime.css"><script src="/capabilities/runtime.js" defer=""></script><a href="/guide/">Guide</a>';
  const mounted = rewriteMountedWebFileContent('notes', '/notes', 'index.html', source);
  assert.match(mounted, /href="\/capabilities\/runtime\.css"/);
  assert.match(mounted, /src="\/capabilities\/runtime\.js"/);
  assert.match(mounted, /href="\/notes\/guide\/"/);
  assert.equal(unmountWebFileContent('notes', '/notes', 'index.html', mounted), source);
  assert.throws(() => rewriteMountedWebFileContent('notes', '/notes', 'index.html', '<script src="/other.js"></script>'), /browser behavior/);
});

function twoSiteAssembly(secondaryFiles = {
  'index.html': '<!doctype html><title>Notes</title><a href="/guide.html">Guide</a><a href="/about/">About</a><link rel="stylesheet" href="/styles.css"><img srcset="data:image/svg+xml,%3Csvg%3E 1x, /assets/mark.svg 2x">',
  'guide.html': '<!doctype html><title>Guide</title>',
  'styles.css': 'h1 { color: teal; background: url("/assets/mark.svg"); }',
  'assets/mark.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
}) {
  const rootFiles = {
    'index.html': '<!doctype html><title>Home</title><a href="/about/">About</a><link rel="stylesheet" href="styles.css">',
    'about/index.html': '<!doctype html><title>About</title>',
    'styles.css': 'body { color: navy; }',
  };
  const rootImport = imported(rootFiles);
  const secondaryImport = imported(secondaryFiles);
  const secondary = project('notes-site', 'Notes', secondaryImport);
  const placed = checkedAppProject({ ...secondary, capabilities: [{ id: 'read-notes', page_id: 'index.html', access: 'public',
    ref: { kind: 'published-workflow', id: 'workflow:notes', version, operation: 'open' },
    presentation: { title: 'Read the notes', description: 'Open the notes and their guide.', style: 'card' } }] });
  return {
    assembly: assembleEditableAppProject({ id: 'combined-site', name: 'Combined Site', sources: [
      { key: 'notes', project: placed, targets: ['web'] },
      { key: 'site', project: project('home-site', 'Home', rootImport), targets: ['web'] },
    ] }),
    imported: { notes: secondaryImport, site: rootImport },
  };
}

test('saved Sites assembly publishes both mounted sources, mapped placements, and source history', () => {
  const { assembly, imported: sources } = twoSiteAssembly();
  const output = appProjectForTarget(assembly, 'web');
  assert.deepEqual(output.pages.map(page => [page.path, page.source_path]), [
    ['/about/', 'about/index.html'], ['/notes/', 'notes/index.html'],
    ['/notes/guide.html', 'notes/guide.html'], ['/','index.html'],
  ].sort(([a], [b]) => a.localeCompare(b)));
  const definition = publicAppDefinitionFromImportedProject(assembly, sources, {
    notes: uploaded(sources.notes.files), site: uploaded(sources.site.files),
  });

  assert.equal(definition.id, 'combined-site');
  assert.deepEqual(Object.keys(definition.files).sort(), [
    'about/index.html', 'index.html', 'notes/assets/mark.svg', 'notes/guide.html', 'notes/index.html',
    'notes/styles.css', 'styles.css',
  ]);
  assert.equal(definition.files['notes/index.html'], '<!doctype html><title>Notes</title><a href="/notes/guide.html">Guide</a><a href="/notes/about/">About</a><link rel="stylesheet" href="/notes/styles.css"><img srcset="data:image/svg+xml,%3Csvg%3E 1x, /notes/assets/mark.svg 2x">');
  assert.equal(definition.files['notes/styles.css'], 'h1 { color: teal; background: url("/notes/assets/mark.svg"); }');
  assert.deepEqual(definition.placed_capabilities, [{
    id: 'notes-read-notes', page_path: 'notes/index.html', access: 'public',
    capability: { kind: 'published-workflow', id: 'workflow:notes', version, operation: 'open' },
    presentation: { title: 'Read the notes', description: 'Open the notes and their guide.', style: 'card' },
  }]);
  assert.match(definition.project_origin.warnings.join('\n'), /Source notes: site-folder notes-site at 1f:/);
  assert.match(definition.project_origin.warnings.join('\n'), /Source site: site-folder home-site at 1f:/);
});

test('publishing a composed source maps the actual HTML slots to its namespaced endpoints', () => {
  const { assembly, imported: sources } = twoSiteAssembly({
    'index.html': '<h1>Notes</h1><section data-trillion-placement="read-notes"></section>',
  });
  const definition = publicAppDefinitionFromImportedProject(assembly, sources, {
    notes: uploaded(sources.notes.files), site: uploaded(sources.site.files),
  });
  const slot = /data-trillion-placement="([^"]+)"/.exec(definition.files['notes/index.html'])[1];
  assert.equal(slot, 'notes-read-notes');
  assert.ok(definition.placed_capabilities.some(row => row.id === slot && row.page_path === 'notes/index.html'));
});

test('the installed site stays the composed root and keeps its visitor actions and placements', () => {
  const installation_id = 'a'.repeat(32);
  const rootFiles = { 'index.html': '<!doctype html><title>Home</title>',
    'styles.css': 'body { color: navy; }' };
  const action = { id: 'apply', record_kind: 'home-inquiry', fields: [{ id: 'note', type: 'text' }] };
  const rootDraft = checkedPublicAppEditorSource({ id: 'home-app', actions: [action], files: rootFiles,
    placed_capabilities: [{ id: 'home-guide', page_path: 'index.html', access: 'public', capability: {
      kind: 'published-workflow', id: 'workflow:home-guide', version, operation: 'open',
    } }] });
  const projectOrigin = { kind: 'site-folder', skipped: [], warnings: [] };
  const rootProject = appProjectFromPublicAppDraft({ installation_id, public_url: 'https://home.sites.gettrillion.ai/',
    name: 'Home', draft: { ...rootDraft, project_origin: projectOrigin } });
  const notesImport = imported({ 'index.html': '<!doctype html><title>Notes</title>' });
  const notesProject = checkedAppProject({ ...project('notes-site', 'Notes', notesImport), capabilities: [{
    id: 'read-notes', page_id: 'index.html', access: 'public',
    ref: { kind: 'published-workflow', id: 'workflow:notes', version, operation: 'open' },
    presentation: { title: 'Read the notes', description: 'Open the notes.', style: 'card' },
  }] });
  const assembly = assembleEditableAppProject({ id: rootProject.id, name: 'Home', sources: [
    { key: 'site', project: rootProject, targets: ['web'] },
    { key: 'notes', project: notesProject, targets: ['web'] },
  ] });
  const definition = publicAppDefinitionFromImportedProject(assembly, {
    site: { can_publish: true, files: rootDraft.files, installation_revision: rootDraft.revision,
      actions: rootDraft.actions, project_origin: projectOrigin },
    notes: notesImport,
  }, { site: uploaded(rootDraft.files), notes: uploaded(notesImport.files) });

  assert.equal(definition.actions[0].id, 'apply');
  assert.deepEqual(Object.keys(definition.files).sort(), ['index.html', 'notes/index.html', 'styles.css']);
  assert.deepEqual(definition.placed_capabilities.map(row => [row.id, row.page_path, row.capability.id]).sort(), [
    ['home-guide', 'index.html', 'workflow:home-guide'],
    ['notes-read-notes', 'notes/index.html', 'workflow:notes'],
  ]);
  assert.equal(definition.project_origin.kind, projectOrigin.kind);
  assert.deepEqual(definition.project_origin.skipped, projectOrigin.skipped);
  assert.match(definition.project_origin.warnings.join('\n'), /Source site: public-app-installation/);
  assert.match(definition.project_origin.warnings.join('\n'), /Source notes: site-folder/);
});

test('composed capability slots use their source ids, preserve installed ids, and reverse cleanly', () => {
  const ref = { kind: 'published-workflow', id: 'workflow:shared', version, operation: 'open' };
  const site = { key: 'site', project: { source: { kind: 'public-app-installation' }, capabilities: [{ id: 'same', page_id: 'index.html', ref }] } };
  const notes = { key: 'notes', project: { source: { kind: 'site-folder' }, capabilities: [{ id: 'same', page_id: 'index.html', ref }] } };
  const siteHtml = '<div data-trillion-placement="same"></div>';
  const notesHtml = '<!-- <div data-trillion-placement="same"> --><script>"<div data-trillion-placement=\'same\'>"</script><aside data-trillion-placement="same"></aside><div data-trillion-placement=\'same\'></div><section data-trillion-placement=same></section><p data-trillion-placement="unknown"></p>';

  assert.equal(webCapabilityId('site', site.project, 'same'), 'same');
  assert.equal(webCapabilityId('notes', notes.project, 'same'), 'notes-same');
  const mappedSite = rewriteWebCapabilitySlots(site, 'index.html', siteHtml);
  const mappedNotes = rewriteWebCapabilitySlots(notes, 'index.html', notesHtml);
  assert.equal(mappedSite, siteHtml);
  assert.equal(mappedNotes, notesHtml
    .replace('data-trillion-placement="same"></aside>', 'data-trillion-placement="notes-same"></aside>')
    .replace("data-trillion-placement='same'></div>", "data-trillion-placement='notes-same'></div>")
    .replace('data-trillion-placement=same></section>', 'data-trillion-placement=notes-same></section>'));
  assert.equal(rewriteWebCapabilitySlots(notes, 'index.html', mappedNotes), mappedNotes);
  assert.equal(rewriteWebCapabilitySlots(notes, 'index.html', mappedNotes, { reverse: true }), notesHtml);
  assert.equal(rewriteWebCapabilitySlots(notes, 'index.txt', notesHtml), notesHtml);
});

test('composed installed and sibling capability ids fail closed on collision', () => {
  const installation_id = 'c'.repeat(32);
  const projectOrigin = { kind: 'site-folder', skipped: [], warnings: [] };
  const ref = { kind: 'published-workflow', id: 'workflow:shared', version, operation: 'open' };
  const rootDraft = checkedPublicAppEditorSource({ id: 'home-app', actions: [], files: { 'index.html': '<!doctype html>' },
    placed_capabilities: [{ id: 'notes-same', page_path: 'index.html', access: 'public', capability: ref }] });
  const rootProject = appProjectFromPublicAppDraft({ installation_id, public_url: 'https://home.sites.gettrillion.ai/',
    name: 'Home', draft: { ...rootDraft, project_origin: projectOrigin } });
  const sibling = checkedAppProject({ ...project('notes-site', 'Notes', imported({ 'index.html': '<!doctype html>' })),
    capabilities: [{ id: 'same', page_id: 'index.html', access: 'public', ref }] });
  const assembly = assembleEditableAppProject({ id: rootProject.id, name: 'Home', sources: [
    { key: 'site', project: rootProject, targets: ['web'] },
    { key: 'notes', project: sibling, targets: ['web'] },
  ] });
  assert.throws(() => appProjectForTarget(assembly, 'web'), /colliding web capability id/);
});

test('multiple copied URLs retain the home origin and every sibling URL in provenance', () => {
  const root = imported({ 'index.html': '<!doctype html><title>Home</title>' }, { source_url: 'https://home.example/' });
  const guide = imported({ 'index.html': '<!doctype html><title>Guide</title>' }, { source_url: 'https://guide.example/' });
  const assembly = assembleEditableAppProject({ id: 'copied-sites', name: 'Copied Sites', sources: [
    { key: 'site', project: project('home-copy', 'Home', root), targets: ['web'] },
    { key: 'guide', project: project('guide-copy', 'Guide', guide), targets: ['web'] },
  ] });
  const definition = publicAppDefinitionFromImportedProject(assembly, { site: root, guide }, {
    site: uploaded(root.files), guide: uploaded(guide.files),
  });

  assert.equal(definition.project_origin.kind, 'public-url-copy');
  assert.equal(definition.project_origin.origin_url, 'https://home.example/');
  assert.match(definition.project_origin.warnings.join('\n'), /guide\.example/);
});

test('a copied home site supplies files_from while mounted siblings keep their own checked refs', () => {
  const notes = {
    'index.html': '<!doctype html><title>Notes</title>',
  };
  const root = {
    ...twoSiteAssembly(notes),
  };
  const identity = `1f:${'c'.repeat(64)}`;
  const copiedRoot = { ...root.imported.site, site_file_identity: identity,
    source_file_path: 'trillion-import.json', files: { ...root.imported.site.files,
      'trillion-import.json': '{"source_url":"https://example.test/"}' } };
  const assembly = assembleEditableAppProject({ id: 'combined-site', name: 'Combined Site', sources: [
    { key: 'site', project: project('home-site', 'Home', copiedRoot), targets: ['web'] },
    { key: 'notes', project: project('notes-site', 'Notes', root.imported.notes), targets: ['web'] },
  ] });
  const definition = publicAppDefinitionFromImportedProject(assembly,
    { site: copiedRoot, notes: root.imported.notes }, { notes: uploaded(root.imported.notes.files) });

  assert.equal(definition.files_from, identity);
  assert.deepEqual(Object.keys(definition.files).sort(), ['notes/index.html', 'trillion-import.json']);
  assert.match(definition.files['trillion-import.json'], /example\.test/);
  assert.equal(definition.files['notes/index.html'].media_type, 'text/html; charset=utf-8');
});

test('mounted sites refuse unsafe encoded and traversal references and JavaScript behavior', () => {
  for (const files of [
    { 'index.html': '<!doctype html><a href="/%2e%2e/private">Private</a>' },
    { 'index.html': '<!doctype html><a href="/&#x2e;&#x2e;/private">Private</a>' },
    { 'index.html': '<!doctype html><a href="/../private">Private</a>' },
    { 'index.html': '<!doctype html><a href="/%2f%2fevil.example/">External</a>' },
    { 'styles.css': 'body { background: url("/../private.svg"); }', 'index.html': '<!doctype html><link rel="stylesheet" href="styles.css">' },
    { 'styles.css': 'body { background: url(\\2f logo.svg); }', 'index.html': '<!doctype html><link rel="stylesheet" href="styles.css">' },
    { 'index.html': '<!doctype html><img src="icon.svg">', 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"><image href="/logo.svg"></image></svg>' },
    { 'index.html': '<!doctype html><script>run()</script>' },
    { 'index.html': '<!doctype html><a href="../private">Private</a>' },
  ]) {
    const { assembly, imported: sources } = twoSiteAssembly(files);
    assert.throws(() => publicAppDefinitionFromImportedProject(assembly, sources, {
      notes: uploaded(files), site: uploaded(sources.site.files),
    }), /notes source/);
  }
});

test('HTML entity slashes are rewritten while encoded traversal is rejected', () => {
  const { assembly, imported: sources } = twoSiteAssembly({
    'index.html': '<!doctype html><a href="&#47;guide.html?from=home&amp;kind=notes">Guide</a>',
  });
  const definition = publicAppDefinitionFromImportedProject(assembly, sources, {
    notes: uploaded(sources.notes.files), site: uploaded(sources.site.files),
  });
  assert.equal(definition.files['notes/index.html'], '<!doctype html><a href="/notes/guide.html?from=home&amp;kind=notes">Guide</a>');
});

test('unquoted srcset rewrites every candidate under the source mount', () => {
  const { assembly, imported: sources } = twoSiteAssembly({
    'index.html': '<!doctype html><img srcset=/one.png 1x, /two.png 2x>',
  });
  const definition = publicAppDefinitionFromImportedProject(assembly, sources, {
    notes: uploaded(sources.notes.files), site: uploaded(sources.site.files),
  });
  assert.equal(definition.files['notes/index.html'], '<!doctype html><img srcset=/notes/one.png 1x, /notes/two.png 2x>');
});

test('the imported about-page fixture keeps its contained parent-relative stylesheet', () => {
  const fixtureFiles = {
    'index.html': readFileSync(new URL('./fixtures/public-app-import/site/index.html', import.meta.url), 'utf8'),
    'about/index.html': readFileSync(new URL('./fixtures/public-app-import/site/about/index.html', import.meta.url), 'utf8'),
    'styles.css': readFileSync(new URL('./fixtures/public-app-import/site/styles.css', import.meta.url), 'utf8'),
  };
  const { assembly, imported: sources } = twoSiteAssembly(fixtureFiles);
  const definition = publicAppDefinitionFromImportedProject(assembly, sources, {
    notes: uploaded(sources.notes.files), site: uploaded(sources.site.files),
  });
  assert.match(definition.files['notes/about/index.html'], /href="\.\.\/styles\.css"/);
  assert.match(definition.files['notes/about/index.html'], /href="\/notes\/"/);
});

test('mounted HTML refuses entity-obfuscated JavaScript schemes and escaping entity traversal', () => {
  for (const href of [
    '&#x6a;avascript:alert(1)',
    'java&#9;script:alert(1)',
    '&#46&#46;/private',
  ]) {
    const { assembly, imported: sources } = twoSiteAssembly({
      'index.html': `<!doctype html><a href="${href}">Blocked</a>`,
    });
    assert.throws(() => publicAppDefinitionFromImportedProject(assembly, sources, {
      notes: uploaded(sources.notes.files), site: uploaded(sources.site.files),
    }), /unsafe encoded or traversal/);
  }
});

test('the composed publisher refuses a same-path upload that differs from its imported source', () => {
  const { assembly, imported: sources } = twoSiteAssembly();
  const mismatched = uploaded(sources.notes.files);
  mismatched['index.html'] = uploaded({ 'index.html': '<!doctype html><title>Changed</title>' })['index.html'];
  assert.throws(() => publicAppDefinitionFromImportedProject(assembly, sources, {
    notes: mismatched, site: uploaded(sources.site.files),
  }), /uploaded notes file index\.html does not match/);
});

test('web file collisions and multiple native source targets remain refused', () => {
  const root = project('home-site', 'Home', imported({
    'index.html': '<!doctype html><title>Home</title>',
    'notes/styles.css': 'body { color: navy; }',
  }));
  const notes = project('notes-site', 'Notes', imported({
    'index.html': '<!doctype html><title>Notes</title>',
    'styles.css': 'h1 { color: teal; }',
  }));
  const colliding = assembleEditableAppProject({ id: 'combined-site', name: 'Combined Site', sources: [
    { key: 'site', project: root, targets: ['web'] }, { key: 'notes', project: notes, targets: ['web'] },
  ] });
  assert.throws(() => appProjectForTarget(colliding, 'web'), /conflicts with/);

  const native = name => checkedAppProject({ schema: 'trillion.app-project', id: name.toLowerCase().replaceAll(' ', '-'), name,
    source: { kind: 'repository-source', id: name, revision: version,
      coverage: { routes: 'kept', assets: 'kept', browser_code: 'not-imported', server_code: 'not-imported', sign_in: 'not-imported', native_code: 'kept' } },
    pages: [{ id: 'home', path: '/', source_path: 'Home.swift', presenter: { kind: 'native-screen', ref: { kind: 'swift-view', id: 'home', version } } }],
    assets: [], behaviors: [], capabilities: [], permissions: [],
    outputs: [{ target: 'ios', presenter: 'native-screen', status: 'buildable' }],
  });
  assert.throws(() => assembleEditableAppProject({ id: 'native-set', name: 'Native Set', sources: [
    { key: 'native-one', project: native('Native One'), targets: ['ios'] },
    { key: 'native-two', project: native('Native Two'), targets: ['ios'] },
  ] }), /Two source projects provide \/ for ios/);
});
