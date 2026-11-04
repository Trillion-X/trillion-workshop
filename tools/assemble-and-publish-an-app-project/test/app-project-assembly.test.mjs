import test from 'node:test';
import assert from 'node:assert/strict';
import { appProjectFromImportedSite, appProjectFromPinnedRepository, appProjectFromPublicApp, checkedAppProject } from '../src/app-project.mjs';
import {
  assembleEditableAppProject,
  checkedEditableAppProject,
  replaceEditableAppProjectSource,
} from '../src/app-project-assembly.mjs';

const version = `1f:${'b'.repeat(64)}`;
const webProject = () => {
  const imported = { can_publish: true, files: {
    'index.html': '<!doctype html><title>Sample Builder</title>',
    'about/index.html': '<!doctype html><title>About</title>',
    'styles.css': 'body { color: navy; }',
  }, warnings: [] };
  const project = appProjectFromImportedSite({ id: 'sample-builder-web', name: 'Sample Builder', imported });
  return checkedAppProject({ ...project, capabilities: [
    { id: 'notes-tool', page_id: 'index.html', access: 'public',
      ref: { kind: 'workshop-tool', id: 'tool:sample-builder', version, operation: 'run' },
      presentation: { title: 'Make a note', description: 'Open the shared note form.', style: 'card' } },
    { id: 'read-workflow', page_id: 'about/index.html', access: 'public',
      ref: { kind: 'published-workflow', id: 'workflow:sample-builder', version },
      presentation: { title: 'Read the method', description: 'Use the shared reading workflow.', style: 'plain' } },
  ] });
};

const nativeProject = (name = 'Sample Builder Native') => checkedAppProject({
  schema: 'trillion.app-project', id: 'sample-builder-native', name,
  source: { kind: 'repository-source', id: 'github:example/sample-builder-native@commit', revision: version,
    coverage: { routes: 'kept', assets: 'kept', browser_code: 'not-imported',
      server_code: 'source-dependent', sign_in: 'source-dependent', native_code: 'kept' } },
  pages: [{ id: 'app', path: '/', source_path: 'App/Home.swift',
    presenter: { kind: 'native-screen', ref: { kind: 'swift-view', id: 'home', version } } }],
  assets: [], behaviors: [], capabilities: [], permissions: [],
  outputs: ['ios', 'macos'].map(target => ({ target, presenter: 'native-screen', status: 'buildable' })),
});

test('web routes, native screens, and shared placements form one saved editable project', () => {
  const project = assembleEditableAppProject({ id: 'sample-builder', name: 'Sample Builder', sources: [
    { key: 'web', project: webProject(), targets: ['web'] },
    { key: 'native', project: nativeProject(), targets: ['ios', 'macos'] },
  ] });

  assert.deepEqual(project.pages.map(page => [page.id, page.path, page.presenter.kind, page.targets]), [
    ['native:app', '/', 'native-screen', ['ios', 'macos']],
    ['web:index.html', '/', 'editable-file', ['web']],
    ['web:about/index.html', '/about/', 'editable-file', ['web']],
  ]);
  assert.deepEqual(project.outputs.map(output => [output.target, output.sources.map(source => source.source)]), [
    ['ios', ['native']], ['macos', ['native']], ['web', ['web']],
  ]);
  assert.deepEqual(project.capabilities.map(row => [row.source, row.page_id, row.ref.kind, row.presentation.style]), [
    ['web', 'web:index.html', 'workshop-tool', 'card'],
    ['web', 'web:about/index.html', 'published-workflow', 'plain'],
  ]);
  assert.deepEqual(checkedEditableAppProject(JSON.parse(JSON.stringify(project))), project);
});

test('source replacement advances the saved project revision and preserves sibling source and placements', () => {
  const project = assembleEditableAppProject({ id: 'sample-builder', name: 'Sample Builder', sources: [
    { key: 'web', project: webProject(), targets: ['web'] },
    { key: 'native', project: nativeProject(), targets: ['ios', 'macos'] },
  ] });
  const revised = replaceEditableAppProjectSource(project, 'native', nativeProject('Sample Builder Native Updated'));

  assert.notEqual(revised.revision, project.revision);
  assert.deepEqual(revised.capabilities, project.capabilities);
  assert.deepEqual(revised.sources.find(source => source.key === 'web'), project.sources.find(source => source.key === 'web'));
  assert.equal(revised.sources.find(source => source.key === 'native').project.name, 'Sample Builder Native Updated');
});

test('the assembly rejects route collisions on a shared target and edited derived rows', () => {
  const published = appProjectFromPublicApp({ installation_id: 'a'.repeat(32),
    public_url: 'https://sample-builder.example/', name: 'Sample Builder', source: {
      id: 'a'.repeat(32), actions: [], files: { 'index.html': '<h1>Sample Builder</h1>', 'about/index.html': '<h1>About</h1>' },
    } });
  assert.throws(() => assembleEditableAppProject({ id: 'sample-builder', name: 'Sample Builder', sources: [
    { key: 'web', project: published, targets: ['ios'] },
    { key: 'native', project: nativeProject(), targets: ['ios'] },
  ] }), /Two source projects provide \/ for ios/);

  const project = assembleEditableAppProject({ id: 'sample-builder', name: 'Sample Builder', sources: [
    { key: 'web', project: webProject(), targets: ['web'] },
    { key: 'native', project: nativeProject(), targets: ['ios', 'macos'] },
  ] });
  assert.throws(() => checkedEditableAppProject({ ...project,
    capabilities: project.capabilities.slice(1),
  }), /does not match its source projects/);
});

test('a pinned GitHub web snapshot keeps its repository identity and route source paths in the assembly', () => {
  const project = { id: 'a'.repeat(32), provider: 'github', owner: 'Example', repo: 'sample-builder',
    branch: 'main', commit: 'c'.repeat(40) };
  const web = appProjectFromPinnedRepository({ id: 'sample-builder-web', name: 'Sample Builder', project,
    snapshot: { project_id: project.id, owner: 'example', repo: project.repo, branch: project.branch,
      commit: project.commit, files: { 'index.html': '<title>Home</title>', 'about/index.html': '<title>About</title>',
        'styles/site.css': 'main { color: navy; }', 'scripts/site.js': 'start();' } } });
  const assembly = assembleEditableAppProject({ id: 'sample-builder', name: 'Sample Builder', sources: [
    { key: 'github', project: web, targets: ['web'] },
  ] });

  assert.deepEqual(assembly.sources[0].project.source, web.source);
  assert.equal(web.source.id, `github:Example/sample-builder@${project.commit}`);
  assert.deepEqual(web.source.origin, { kind: 'github-repository', project_id: project.id,
    owner: 'Example', repo: 'sample-builder', branch: 'main', commit: project.commit });
  assert.deepEqual(assembly.pages.map(page => [page.path, page.source_path]), [
    ['/', 'index.html'], ['/about/', 'about/index.html'],
  ]);
  assert.deepEqual(assembly.sources[0].project.assets.map(asset => asset.path), ['scripts/site.js', 'styles/site.css']);
  assert.deepEqual(checkedEditableAppProject(JSON.parse(JSON.stringify(assembly))), assembly);
});

test('a running GitHub app is saved as a hosted page with its backend and sign-in left at the origin', () => {
  const project = { id: 'a'.repeat(32), provider: 'github', owner: 'Example', repo: 'dynamic-app',
    branch: 'main', commit: 'c'.repeat(40), live_url: 'https://app.example.com/' };
  const app = appProjectFromPinnedRepository({ id: 'dynamic-app-web', name: 'Dynamic App', project,
    snapshot: { kind: 'running-web-origin', project_id: project.id, owner: project.owner,
      repo: project.repo, branch: project.branch, commit: project.commit, url: project.live_url } });
  const assembly = assembleEditableAppProject({ id: 'dynamic-app', name: 'Dynamic App', sources: [
    { key: 'live', project: app, targets: ['web'] },
  ] });

  assert.equal(app.source.origin.kind, 'github-repository');
  assert.equal(app.source.origin.commit, project.commit);
  assert.equal(app.source.coverage.routes, 'source-dependent');
  assert.equal(app.source.coverage.assets, 'source-dependent');
  assert.equal(app.source.coverage.browser_code, 'source-dependent');
  assert.equal(app.source.coverage.server_code, 'source-dependent');
  assert.equal(app.source.coverage.sign_in, 'source-dependent');
  assert.equal(app.source.coverage.native_code, 'not-imported');
  assert.deepEqual(assembly.pages.map(page => [page.path, page.presenter]), [[ '/',
    { kind: 'hosted-web', url: 'https://app.example.com/' } ]]);
  assert.deepEqual(assembly.sources[0].project.assets, []);
  assert.deepEqual(checkedEditableAppProject(JSON.parse(JSON.stringify(assembly))), assembly);
});

test('a saved running source keeps every locked build input with its GitHub origin', () => {
  const project = { id: 'a'.repeat(32), provider: 'github', owner: 'Example', repo: 'dynamic-app',
    branch: 'main', commit: 'c'.repeat(40), live_url: 'https://app.example.com/' };
  const build_inputs = { schema: 'trillion.source-build-inputs/v1', inputs: [
    { repository: 'Example/shared-ui', commit: 'd'.repeat(40), mount: 'shared-ui', paths: ['parts/ui'] },
  ] };
  const snapshot = { kind: 'running-web-origin', project_id: project.id, owner: project.owner,
    repo: project.repo, branch: project.branch, commit: project.commit, url: project.live_url, build_inputs };
  const app = appProjectFromPinnedRepository({ id: 'dynamic-app-web', name: 'Dynamic App', project, snapshot });
  const assembly = assembleEditableAppProject({ id: 'dynamic-app', name: 'Dynamic App', sources: [
    { key: 'live', project: app, targets: ['web'] },
  ] });
  assert.deepEqual(assembly.sources[0].project.source.origin.build_inputs, build_inputs);
  assert.deepEqual(checkedEditableAppProject(JSON.parse(JSON.stringify(assembly))), assembly);
  assert.throws(() => appProjectFromPinnedRepository({ id: 'dynamic-app-web', name: 'Dynamic App', project,
    snapshot: { ...snapshot, build_inputs: { ...build_inputs, inputs: [{ ...build_inputs.inputs[0], paths: ['../outside'] }] } } }),
  /source build lock/);
});

test('a multi-route running app joins a saved Sites project without dropping sibling routes or its GitHub pin', () => {
  const project = { id: 'a'.repeat(32), provider: 'github', owner: 'Example', repo: 'dynamic-app',
    branch: 'main', commit: 'c'.repeat(40), live_url: 'https://app.example.com/' };
  const app = appProjectFromPinnedRepository({ id: 'dynamic-app-web', name: 'Dynamic App', project,
    snapshot: { kind: 'running-web-origin', project_id: project.id, owner: project.owner,
      repo: project.repo, branch: project.branch, commit: project.commit, url: project.live_url,
      routes: ['/', '/for-you', '/articles/one/'] } });
  const assembly = assembleEditableAppProject({ id: 'sample-builder', name: 'Sample Builder', sources: [
    { key: 'site', project: webProject(), targets: ['web'] },
    { key: 'dynamic', project: app, targets: ['web'] },
  ] });

  assert.deepEqual(app.source.origin, { kind: 'github-repository', project_id: project.id,
    owner: 'Example', repo: 'dynamic-app', branch: 'main', commit: project.commit });
  assert.deepEqual(app.pages.map(page => [page.path, page.presenter.url]), [
    ['/', 'https://app.example.com/'], ['/articles/one/', 'https://app.example.com/articles/one/'],
    ['/for-you', 'https://app.example.com/for-you'],
  ]);
  assert.deepEqual(assembly.pages.filter(page => page.source === 'site').map(page => page.path).sort(), ['/', '/about/']);
  assert.deepEqual(assembly.pages.filter(page => page.source === 'dynamic').map(page => page.path).sort(), [
    '/dynamic/', '/dynamic/articles/one/', '/dynamic/for-you',
  ]);
  assert.deepEqual(assembly.sources.map(row => row.key).sort(), ['dynamic', 'site']);
  assert.equal(checkedEditableAppProject(JSON.parse(JSON.stringify(assembly))).revision, assembly.revision);
});

test('a repository adapter refuses an unpinned or mismatched source snapshot', () => {
  const project = { id: 'a'.repeat(32), provider: 'github', owner: 'owner', repo: 'sample', branch: 'main', commit: 'c'.repeat(40) };
  const snapshot = { project_id: project.id, owner: project.owner, repo: project.repo,
    branch: project.branch, commit: project.commit, files: { 'index.html': '<title>Home</title>' } };
  assert.throws(() => appProjectFromPinnedRepository({ id: 'sample-web', name: 'Sample',
    project: { ...project, commit: null }, snapshot }), /pinned to an exact commit/);
  assert.throws(() => appProjectFromPinnedRepository({ id: 'sample-web', name: 'Sample', project,
    snapshot: { ...snapshot, commit: 'd'.repeat(40) } }), /pinned commit/);
  assert.throws(() => appProjectFromPinnedRepository({ id: 'sample-web', name: 'Sample', project,
    snapshot: { ...snapshot, project_id: 'b'.repeat(32) } }), /pinned commit/);
});
