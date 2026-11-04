// Save several checked source adapters as one editable project index. Source
// projects remain owned by their existing web, repository, and native adapters.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkedAppProject } from './app-project.mjs';
import { composeWebAppProject } from './app-project-output-composition.mjs';
import { mountedWebFile, mountedWebRoute, webSourceMounts } from './app-project-web-mounts.mjs';

const KEY = /^[a-z][a-z0-9-]{1,63}$/;
const TARGETS = ['web', 'ios', 'macos'];
const json = value => JSON.stringify(value);
const revisionOf = value => `1f:${bytesToHex(blake3(new TextEncoder().encode(json(value))))}`;

function selectedSources(inputs) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 20) {
    throw new Error('An editable app project needs between one and twenty source projects.');
  }
  const keys = new Set();
  return inputs.map(input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['key', 'project', 'targets'].includes(key)) ||
        !KEY.test(input.key ?? '') || keys.has(input.key)) {
      throw new Error('Each source project needs a unique, simple key.');
    }
    keys.add(input.key);
    const project = checkedAppProject(input.project);
    const available = project.outputs.filter(output => output.status !== 'unsupported').map(output => output.target);
    const targets = input.targets ?? available;
    if (!Array.isArray(targets) || !targets.length || targets.some(target => !TARGETS.includes(target)) ||
        new Set(targets).size !== targets.length || targets.some(target => !available.includes(target))) {
      throw new Error(`The ${input.key} source cannot provide those app targets.`);
    }
    return { key: input.key, targets: [...targets].sort(), project };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

function pageTargets(page, project, selected) {
  const supported = new Set(project.outputs.filter(output => selected.includes(output.target) && output.status !== 'unsupported' &&
    (page.presenter.kind === 'native-screen'
      ? output.presenter === 'native-screen'
      : page.presenter.kind === 'editable-file'
        ? output.target === 'web' && output.presenter === 'editable-file'
        : output.target === 'web' ? output.presenter === 'hosted-web' : output.presenter === 'webview'))
    .map(output => output.target));
  return selected.filter(target => supported.has(target)).sort();
}

function build(id, name, sources) {
  const pages = [];
  const assets = [];
  const behaviors = [];
  const capabilities = [];
  const outputs = new Map();
  const routeTargets = new Set();
  const webMounts = webSourceMounts(sources);

  for (const source of sources) {
    for (const output of source.project.outputs) {
      if (!source.targets.includes(output.target) || output.status === 'unsupported') continue;
      const rows = outputs.get(output.target) ?? [];
      rows.push({ source: source.key, presenter: output.presenter, status: output.status,
        ...(output.reason ? { reason: output.reason } : {}) });
      outputs.set(output.target, rows);
    }
    for (const page of source.project.pages) {
      const targets = pageTargets(page, source.project, source.targets);
      if (!targets.length) continue;
      const groups = new Map();
      for (const target of targets) {
        const mount = target === 'web' ? webMounts.get(source.key) ?? '' : '';
        const path = target === 'web' ? mountedWebRoute(mount, page.path) : page.path;
        const routeTarget = `${target}\0${path}`;
        if (routeTargets.has(routeTarget)) throw new Error(`Two source projects provide ${path} for ${target}.`);
        routeTargets.add(routeTarget);
        const source_path = target === 'web' ? mountedWebFile(mount, page.source_path) : page.source_path;
        const presenter = page.presenter.kind === 'editable-file' ? { kind: 'editable-file', path: source_path } : page.presenter;
        const signature = JSON.stringify({ path, source_path, presenter });
        const group = groups.get(signature) ?? { path, source_path, presenter, targets: [] };
        group.targets.push(target);
        groups.set(signature, group);
      }
      for (const [signature, group] of groups) pages.push({
        id: `${source.key}:${page.id}${groups.size === 1 || group.targets.includes('web') ? '' : `:${group.targets.join('-')}`}`,
        source: source.key, source_page: page.id, ...group,
      });
    }
    for (const asset of source.project.assets) assets.push({ source: source.key, ...asset });
    for (const behavior of source.project.behaviors) behaviors.push({ source: source.key, ...behavior });
    for (const capability of source.project.capabilities) capabilities.push({
      ...capability, id: `${source.key}:${capability.id}`, source: source.key,
      page_id: `${source.key}:${capability.page_id}`,
    });
  }

  const sourceRows = sources.map(({ key, targets, project }) => ({ key, targets, project }));
  const identity = { schema: 'trillion.editable-app-project', id, name,
    sources: sourceRows, pages, assets, behaviors, capabilities,
    outputs: [...outputs].sort(([a], [b]) => a.localeCompare(b))
      .map(([target, rows]) => ({ target, sources: rows.sort((a, b) => a.source.localeCompare(b.source)) })) };
  return { ...identity, revision: revisionOf(identity) };
}

/** Combine existing source adapters into one checked, serializable editor project. */
export function assembleEditableAppProject({ id, name, sources }) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,79}$/.test(id) ||
      typeof name !== 'string' || !name.trim() || name.length > 80 || /[\\/\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('The editable app project needs a name and id.');
  }
  return build(id, name.trim(), selectedSources(sources));
}

/** Validate a saved assembly by rebuilding it from its embedded source projects. */
export function checkedEditableAppProject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['schema', 'id', 'name', 'revision', 'sources', 'pages', 'assets', 'behaviors', 'capabilities', 'outputs'].includes(key)) ||
      input.schema !== 'trillion.editable-app-project' || typeof input.revision !== 'string') {
    throw new Error('The editable app project is invalid.');
  }
  const checked = assembleEditableAppProject({ id: input.id, name: input.name,
    sources: input.sources?.map(row => ({ key: row.key, project: row.project, targets: row.targets })) });
  if (json(checked) !== json(input)) throw new Error('The editable app project does not match its source projects.');
  return checked;
}

/** Replace one adapter snapshot while keeping every other source and its target selection. */
export function replaceEditableAppProjectSource(input, key, project) {
  const current = checkedEditableAppProject(input);
  if (!current.sources.some(source => source.key === key)) throw new Error(`The ${key} source is not in this app project.`);
  return assembleEditableAppProject({ id: current.id, name: current.name,
    sources: current.sources.map(source => ({ key: source.key,
      project: source.key === key ? project : source.project, targets: source.targets })) });
}

/** Select a target. A native WebKit build may use the checked whole published site. */
export function appProjectForTarget(input, target, { publishedProject } = {}) {
  if (!TARGETS.includes(target)) throw new Error('Choose a web, iPhone, or Mac app target.');
  if (input?.schema === 'trillion.app-project') {
    const project = checkedAppProject(input);
    const output = project.outputs.find(row => row.target === target);
    if (!output || output.status === 'unsupported') throw new Error(`This app project does not support a ${target} output.`);
    return project;
  }
  const assembly = checkedEditableAppProject(input);
  const output = assembly.outputs.find(row => row.target === target);
  if (!output) throw new Error(`This app project does not support a ${target} output.`);
  if (output.sources.length === 1) {
    const selected = assembly.sources.find(source => source.key === output.sources[0].source);
    if (!selected || !selected.targets.includes(target)) throw new Error(`The ${target} source project is unavailable.`);
    const sourceOutput = selected.project.outputs.find(row => row.target === target);
    if (!sourceOutput || sourceOutput.status === 'unsupported' || sourceOutput.presenter !== output.sources[0].presenter ||
        sourceOutput.status !== output.sources[0].status) {
      throw new Error(`The ${target} source no longer matches this app project.`);
    }
    if (target !== 'web' && publishedProject && selected.project.source.kind === 'public-app-installation') {
      const published = checkedAppProject(publishedProject);
      if (published.source.kind !== 'public-app-installation' ||
          published.source.id !== selected.project.source.id ||
          published.outputs.find(row => row.target === target)?.status !== 'buildable' ||
          published.outputs.find(row => row.target === target)?.presenter !== 'webview') {
        throw new Error('The published site no longer matches this native app target.');
      }
      const selectedHome = selected.project.pages.find(page => page.path === '/');
      const publishedHome = published.pages.find(page => page.path === '/');
      if (!selectedHome || !publishedHome ||
          new URL(selectedHome.presenter.url).origin !== new URL(publishedHome.presenter.url).origin) {
        throw new Error('The published site address changed. Reload the Sites project.');
      }
      const webSources = new Set(assembly.outputs.find(row => row.target === 'web')?.sources.map(row => row.source) ?? []);
      const expectedPages = assembly.pages.filter(page => page.targets.includes('web'))
        .map(page => [page.path, page.source_path]).sort((a, b) => a[0].localeCompare(b[0]));
      const actualPages = published.pages.map(page => [page.path, page.source_path])
        .sort((a, b) => a[0].localeCompare(b[0]));
      const mounts = webSourceMounts(assembly.sources);
      const expectedAssets = assembly.assets.filter(asset => webSources.has(asset.source))
        .map(asset => mountedWebFile(mounts.get(asset.source) ?? '', asset.path)).sort();
      const actualAssets = published.assets.map(asset => asset.path).sort();
      if (json(expectedPages) !== json(actualPages) || json(expectedAssets) !== json(actualAssets)) {
        throw new Error('The published site routes or files changed. Reload the Sites project before building.');
      }
      return published;
    }
    return selected.project;
  }
  if (target !== 'web') {
    throw new Error(`The ${target} output currently needs one source project; this project has ${output.sources.length}.`);
  }
  const sources = output.sources.map(row => {
    const source = assembly.sources.find(item => item.key === row.source);
    if (!source || !source.targets.includes(target)) throw new Error(`The ${target} source project is unavailable.`);
    const sourceOutput = source.project.outputs.find(item => item.target === target);
    if (!sourceOutput || sourceOutput.status === 'unsupported' || sourceOutput.presenter !== row.presenter ||
        sourceOutput.status !== row.status) throw new Error(`The ${target} source no longer matches this app project.`);
    return source;
  });
  return composeWebAppProject({ id: assembly.id, name: assembly.name, sources });
}
