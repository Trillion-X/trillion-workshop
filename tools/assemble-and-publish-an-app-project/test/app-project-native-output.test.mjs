import test from 'node:test';
import assert from 'node:assert/strict';
import { appProjectFromPublicApp, checkedAppProject, currentPublicAppProject } from '../src/app-project.mjs';
import { appProjectForTarget, assembleEditableAppProject } from '../src/app-project-assembly.mjs';
import { publicAppRecordsCapabilityVersion } from '../../edit-a-site-visually/src/public-app-capabilities.mjs';

const installation = 'a'.repeat(32);
const source = {
  id: 'sample-app', actions: [],
  files: {
    'index.html': '<!doctype html><title>Sample</title><a href="/about.html">About</a>',
    'about.html': '<!doctype html><title>About</title><p>Current page</p>',
  },
};

test('published public app becomes one source-neutral project with live routes', () => {
  const project = appProjectFromPublicApp({ installation_id: installation,
    public_url: 'https://sample.sites.gettrillion.ai/', name: 'Sample', source });
  assert.equal(project.source.id, installation);
  assert.match(project.source.revision, /^1f:[a-f0-9]{64}$/);
  assert.deepEqual(project.pages.map(page => [page.path, page.presenter.url]), [
    ['/', 'https://sample.sites.gettrillion.ai/'],
    ['/about.html', 'https://sample.sites.gettrillion.ai/about.html'],
  ]);
  assert.deepEqual(project.capabilities, []);
});

test('the shared project keeps public card words and appearance across outputs', () => {
  const placed = { id: 'workflow-card', page_path: 'about.html', access: 'public',
    capability: { kind: 'published-workflow', id: 'workflow:sample', version: '1f:' + 'b'.repeat(64) },
    presentation: { title: 'A public heading', description: 'A public explanation', style: 'plain' } };
  const project = appProjectFromPublicApp({ installation_id: installation,
    public_url: 'https://sample.sites.gettrillion.ai/', name: 'Sample',
    source: { ...source, placed_capabilities: [placed] } });
  assert.deepEqual(project.capabilities[0].presentation, placed.presentation);
  assert.equal(project.capabilities[0].page_id, 'about.html');
  assert.throws(() => checkedAppProject({ ...project, capabilities: [{ ...project.capabilities[0], access: 'signed-in' }] }), /public card needs a published source and public access/);
});

test('project rejects private, mixed-origin and invented capability routes', () => {
  const project = appProjectFromPublicApp({ installation_id: installation,
    public_url: 'https://sample.sites.gettrillion.ai/', name: 'Sample', source });
  assert.throws(() => checkedAppProject({ ...project, pages: [
    { ...project.pages[0], presenter: { kind: 'hosted-web', url: 'http://127.0.0.1/' } },
    project.pages[1],
  ] }), /public HTTPS/);
  assert.throws(() => checkedAppProject({ ...project, pages: [project.pages[0],
    { ...project.pages[1], presenter: { kind: 'hosted-web', url: 'https://other.example/about.html' } },
  ] }), /one HTTPS origin/);
  assert.throws(() => checkedAppProject({ ...project, capabilities: [{
    id: 'invented', page_id: 'absent.html', access: 'public',
    ref: { kind: 'visitor-action', id: 'send', version: '1f:' + 'b'.repeat(64) },
  }] }), /invalid page or access/);
  assert.throws(() => checkedAppProject({ ...project, name: '../Other App' }), /name and id/);
});

test('native build accepts only the complete current installation', async () => {
  const public_url = 'https://sample.sites.gettrillion.ai/';
  const project = appProjectFromPublicApp({ installation_id: installation, public_url, name: 'Sample', source });
  const current = { ...source, installation_id: installation, public_url };
  const read = async id => { assert.equal(id, installation); return current; };
  assert.deepEqual(await currentPublicAppProject(project, read), project);
  await assert.rejects(currentPublicAppProject({ ...project, capabilities: [] }, async () => ({ ...current,
    placed_capabilities: [{ id: 'placed-records', page_path: 'index.html', access: 'signed-in',
      capability: { kind: 'installation-records', id: 'responses', version: publicAppRecordsCapabilityVersion } }],
  })), /installed app changed/);
  await assert.rejects(currentPublicAppProject(project, async () => ({ ...current,
    files: { ...source.files, 'index.html': '<!doctype html><title>Changed</title>' },
  })), /installed app changed/);
  await assert.rejects(currentPublicAppProject(project, async () => ({ ...current,
    public_url: 'https://other.example/' })), /installed app changed/);
  await assert.rejects(currentPublicAppProject(project, async () => ({ ...current,
    installation_id: 'b'.repeat(32) })), /identity changed/);
});

test('indexed native build checks the whole file authority while accepting pages beyond its preview', async () => {
  const public_url = 'https://sample.sites.gettrillion.ai/';
  const file_index = { schema: 'trillion.public-app-file-index', version: 1, root: 'b'.repeat(64),
    file_count: 3, byte_count: 1000, page_count: 2 };
  const current = { installation_id: installation, public_url, id: installation, actions: [],
    files: { 'index.html': '<h1>Sample</h1>' }, file_index, revision: `1f:${'c'.repeat(64)}` };
  const preview = appProjectFromPublicApp({ installation_id: installation, public_url, name: 'Sample', source: current });
  const full = checkedAppProject({ ...preview,
    pages: [...preview.pages, { id: 'guide/index.html', path: '/guide/', source_path: 'guide/index.html',
      presenter: { kind: 'hosted-web', url: `${public_url}guide/` } }],
    assets: [{ path: 'guide/style.css', media_type: 'text/css' }],
  });
  assert.deepEqual((await currentPublicAppProject(full, async () => current)).pages.map(page => page.path), ['/', '/guide/']);
  await assert.rejects(currentPublicAppProject(full, async () => ({ ...current,
    file_index: { ...file_index, root: 'd'.repeat(64) } })), /installed app changed/);
});

test('an assembled WebKit target stays a hosted webview with source-dependent server and sign-in', async () => {
  const public_url = 'https://sample.sites.gettrillion.ai/';
  const project = appProjectFromPublicApp({ installation_id: installation, public_url, name: 'Sample', source });
  const assembly = assembleEditableAppProject({ id: 'sample-output', name: 'Sample', sources: [
    { key: 'site', project, targets: ['ios', 'macos'] },
  ] });
  const iosProject = appProjectForTarget(assembly, 'ios');
  assert.equal(iosProject.outputs.find(row => row.target === 'ios').presenter, 'webview');
  assert.equal(iosProject.source.coverage.native_code, 'not-imported');
  assert.equal(iosProject.source.coverage.server_code, 'not-imported');
  assert.equal(iosProject.source.coverage.sign_in, 'source-dependent');
  assert.deepEqual(await currentPublicAppProject(iosProject, async () => ({ ...source,
    installation_id: installation, public_url,
  })), project);
});
