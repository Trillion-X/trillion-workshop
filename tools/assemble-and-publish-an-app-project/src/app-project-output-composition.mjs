// Compose same-target app descriptors without inventing a second source owner.
// The editable assembly remains the provenance map; this is the checked output
// handed to one target's existing publisher or builder.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkedAppProject } from './app-project.mjs';
import { mountedWebFile, mountedWebRoute, webSourceMounts } from './app-project-web-mounts.mjs';
import { rewriteElementAttributeValues } from '../../shared-code/src/public-app-element-addresses.mjs';
import { mapCssResourceUrls } from '../../edit-a-site-visually/parts/ui/read-data/css-resource-urls.mjs';

export function webCapabilityId(key, project, id) {
  return key === 'site' && project?.source?.kind === 'public-app-installation' ? id : `${key}-${id}`;
}

/** Map the known capability slots in one source page to (or from) its web output ids. */
export function rewriteWebCapabilitySlots({ key, project }, path, content, { reverse = false } = {}) {
  if (!/\.html$/i.test(path) || typeof content !== 'string') return content;
  const sourceToOutput = new Map();
  const outputToSource = new Map();
  for (const capability of project?.capabilities ?? []) {
    if (capability.page_id !== path) continue;
    const outputId = webCapabilityId(key, project, capability.id);
    const existingSource = outputToSource.get(outputId);
    if (existingSource !== undefined && existingSource !== capability.id) {
      throw new Error(`The ${key} source has colliding web capability ids.`);
    }
    const existingOutput = sourceToOutput.get(capability.id);
    if (existingOutput !== undefined && existingOutput !== outputId) {
      throw new Error(`The ${key} source has colliding capability ids.`);
    }
    sourceToOutput.set(capability.id, outputId);
    outputToSource.set(outputId, capability.id);
  }
  const mapping = reverse ? outputToSource : sourceToOutput;
  return rewriteElementAttributeValues(content, 'data-trillion-placement', value => mapping.get(decodeHtmlReferences(value)));
}

function decodeHtmlReferences(value) {
  return value
    .replace(/&#(?:x([\da-f]+)|(\d+));?/gi, (reference, hex, decimal) => {
      const point = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd';
    })
    .replace(/&(sol|period|colon|amp|tab|newline|quest|num);?/gi, (reference, name) => ({
      sol: '/', period: '.', colon: ':', amp: '&', tab: '\t', newline: '\n', quest: '?', num: '#',
    })[name.toLowerCase()] ?? reference);
}

function referencePath(value) {
  const normalized = decodeHtmlReferences(value).trim();
  const end = normalized.search(/[?#]/);
  return end < 0 ? normalized : normalized.slice(0, end);
}

function rootRelative(value) {
  return /^\/(?!\/)/.test(referencePath(value));
}

const trillionRuntimeAsset = value => ['/capabilities/runtime.js', '/capabilities/runtime.css'].includes(referencePath(value));

function rawSuffixAfterPath(value, path) {
  const raw = value.trim();
  let rawIndex = 0;
  let pathIndex = 0;
  while (rawIndex < raw.length && pathIndex < path.length) {
    if (raw[rawIndex] === '&') {
      const entity = raw.slice(rawIndex).match(/^&(?:#x[\da-f]+;?|#\d+;?|(?:sol|period|colon|amp|tab|newline|quest|num);?)/i)?.[0];
      if (entity) {
        const decoded = decodeHtmlReferences(entity);
        if (path.startsWith(decoded, pathIndex)) {
          rawIndex += entity.length;
          pathIndex += decoded.length;
          continue;
        }
      }
    }
    if (raw[rawIndex] !== path[pathIndex]) return decodeHtmlReferences(raw).slice(path.length);
    rawIndex++;
    pathIndex++;
  }
  return raw.slice(rawIndex);
}

function unsafeMountedReference(value, sourcePath) {
  const decoded = decodeHtmlReferences(value).trim();
  const compact = decoded.replace(/[\u0000-\u0020\u007f]/g, '');
  if (/^javascript:/i.test(compact)) return true;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(compact)) return false;
  const path = referencePath(value);
  if (/^(?:%2f|\\0*2f)/i.test(path) || /%(?:2f|5c|0*2e)/i.test(path) || /\\/.test(path)) return true;
  let decodedPath;
  try { decodedPath = decodeURIComponent(path); } catch { return true; }
  if (/[\u0000-\u001f\u007f]/.test(decodedPath)) return true;
  const stack = path.startsWith('/') ? [] : (sourcePath?.split('/').slice(0, -1) ?? []);
  for (const segment of decodedPath.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!stack.length) return true;
      stack.pop();
    } else stack.push(segment);
  }
  return false;
}

function rewriteReference(value, mount, key, sourcePath) {
  if (trillionRuntimeAsset(value)) return value;
  if (unsafeMountedReference(value, sourcePath)) {
    throw new Error(`The ${key} source has an unsafe encoded or traversal reference that cannot be mounted under ${mount}/.`);
  }
  if (!rootRelative(value)) return value;
  const path = referencePath(value);
  return `${mount}${path}${rawSuffixAfterPath(value, path)}`;
}

function unmountReference(value, mount, key, sourcePath) {
  if (trillionRuntimeAsset(value)) return value;
  if (unsafeMountedReference(value, sourcePath)) {
    throw new Error(`The ${key} source has an unsafe encoded or traversal reference that cannot be safely edited under ${mount}/.`);
  }
  if (!rootRelative(value)) return value;
  const path = referencePath(value);
  if (path !== mount && !path.startsWith(`${mount}/`)) {
    throw new Error(`The ${key} source has a root link outside its /${key}/ mount.`);
  }
  const unmounted = path.slice(mount.length) || '/';
  return `${unmounted}${rawSuffixAfterPath(value, path)}`;
}

function rewriteCssReferences(content, key, mount, sourcePath, rewrite = value => rewriteReference(value, mount, key, sourcePath)) {
  if (/\\[\s/\\]|\\[0-9a-f]{1,6}\s?/i.test(content)) {
    throw new Error(`The ${key} source has CSS escapes that cannot be safely mounted under ${mount}/.`);
  }
  return mapCssResourceUrls(content, rewrite);
}

function eachSrcsetUrl(value, rewrite) {
  let index = 0;
  let output = '';
  while (index < value.length) {
    const prefixStart = index;
    while (index < value.length && /[\s,]/.test(value[index])) index++;
    output += value.slice(prefixStart, index);
    if (index >= value.length) break;
    const urlStart = index;
    while (index < value.length && !/\s/.test(value[index])) index++;
    const rawUrl = value.slice(urlStart, index);
    const trailingCommas = rawUrl.match(/,+$/)?.[0] ?? '';
    const url = trailingCommas ? rawUrl.slice(0, -trailingCommas.length) : rawUrl;
    output += rewrite(url) + trailingCommas;
    if (trailingCommas) continue;
    const descriptorStart = index;
    while (index < value.length && value[index] !== ',') index++;
    output += value.slice(descriptorStart, index);
    if (index < value.length) output += value[index++];
  }
  return output;
}

/** Rewrite safe root-relative static references so they stay inside a source mount. */
export function rewriteMountedWebFileContent(key, mount, path, content) {
  if (!mount || typeof content !== 'string' || content.startsWith('data:')) return content;
  assertMountedWebFilesAreSafe(key, mount, { [path]: content });
  let output = content;
  if (/\.html$/i.test(path)) {
    const attributes = /\b(?:href|src|action|poster|formaction|data|cite|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    output = output.replace(attributes, (attribute, doubleQuoted, singleQuoted, bare) => {
      const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
      return attribute.replace(value, rewriteReference(value, mount, key, path));
    });
    const srcsets = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^>]*?))(?=\s+[a-zA-Z_:][\w:.-]*\s*=|\s*\/?>)/gi;
    output = output.replace(srcsets, (attribute, doubleQuoted, singleQuoted, bare) => {
      const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
      const rewritten = eachSrcsetUrl(value, url => rewriteReference(url, mount, key, path));
      return attribute.replace(value, rewritten);
    });
  }
  if (/\.(?:html|css)$/i.test(path)) output = rewriteCssReferences(output, key, mount, path);
  return output;
}

/** Recover source-relative static links from the exact mounted form used by the public app editor. */
export function unmountWebFileContent(key, mount, path, content) {
  if (!mount || typeof content !== 'string' || content.startsWith('data:')) return content;
  let output = content;
  const rewrite = value => unmountReference(value, mount, key, path);
  if (/\.html$/i.test(path)) {
    const attributes = /\b(?:href|src|action|poster|formaction|data|cite|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    output = output.replace(attributes, (attribute, doubleQuoted, singleQuoted, bare) => {
      const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
      return attribute.replace(value, rewrite(value));
    });
    const srcsets = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^>]*?))(?=\s+[a-zA-Z_:][\w:.-]*\s*=|\s*\/?>)/gi;
    output = output.replace(srcsets, (attribute, doubleQuoted, singleQuoted, bare) => {
      const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
      return attribute.replace(value, eachSrcsetUrl(value, rewrite));
    });
  }
  if (/\.(?:html|css)$/i.test(path)) output = rewriteCssReferences(output, key, mount, path, rewrite);
  if (rewriteMountedWebFileContent(key, mount, path, output) !== content) {
    throw new Error(`The ${key} source edit cannot be mapped back to its original mounted file safely.`);
  }
  return output;
}

/** Refuse mounted web bytes whose references or executable behavior need rewriting. */
export function assertMountedWebFilesAreSafe(key, mount, files) {
  if (!mount) return;
  for (const [path, content] of Object.entries(files ?? {})) {
    if (typeof content !== 'string' || content.startsWith('data:')) continue;
    if (/\.html$/i.test(path)) {
      const withoutTrillionRuntime = content.replace(/<script\s+src=(['"])\/capabilities\/runtime\.js\1\s+defer(?:=(?:""|''))?\s*>\s*<\/script\s*>/gi, '');
      if (/<\s*script\b|<\s*base\b|\bsrcdoc\s*=|\son[a-z]+\s*=|\bjavascript\s*:/i.test(withoutTrillionRuntime)) {
        throw new Error(`The ${key} source has browser behavior that cannot be safely mounted under ${mount}/.`);
      }
      const attributes = /\b(?:href|src|action|poster|formaction|data|cite|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
      for (const match of content.matchAll(attributes)) {
        if (unsafeMountedReference(match[1] ?? match[2] ?? match[3] ?? '', path)) throw new Error(`The ${key} source has an unsafe encoded or traversal reference that cannot be safely mounted under ${mount}/.`);
      }
      const srcsets = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^>]*?))(?=\s+[a-zA-Z_:][\w:.-]*\s*=|\s*\/?>)/gi;
      for (const match of content.matchAll(srcsets)) {
        let unsafe = false;
        eachSrcsetUrl(match[1] ?? match[2] ?? match[3] ?? '', url => {
          unsafe ||= unsafeMountedReference(url, path);
          return url;
        });
        if (unsafe) {
          throw new Error(`The ${key} source has an unsafe encoded or traversal image that cannot be safely mounted under ${mount}/.`);
        }
      }
    }
    if (/\.svg$/i.test(path)) {
      if (/<\s*script\b|\son[a-z]+\s*=|\bjavascript\s*:/i.test(content)) {
        throw new Error(`The ${key} source has SVG browser behavior that cannot be safely mounted under ${mount}/.`);
      }
      const attributes = /\b(?:href|src|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
      for (const match of content.matchAll(attributes)) {
        const value = match[1] ?? match[2] ?? match[3] ?? '';
        if (unsafeMountedReference(value, path) || rootRelative(value)) {
          throw new Error(`The ${key} source has an SVG link that cannot be safely mounted under ${mount}/.`);
        }
      }
    }
    if (/\.(?:html|css|svg)$/i.test(path)) {
      const cssUrls = /(?:url\(\s*|@import\s*(?:url\(\s*)?)(?:"([^"]*)"|'([^']*)'|([^\s)';]+))/gi;
      for (const match of content.matchAll(cssUrls)) {
        const value = match[1] ?? match[2] ?? match[3] ?? '';
        if (unsafeMountedReference(value, path) || (/\.svg$/i.test(path) && rootRelative(value))) throw new Error(`The ${key} source has a style asset that cannot be safely mounted under ${mount}/.`);
      }
    }
  }
}

const TARGETS = ['web', 'ios', 'macos'];
const json = value => JSON.stringify(value);
const revisionOf = value => `1f:${bytesToHex(blake3(new TextEncoder().encode(json(value))))}`;

function checkedTargetSource(source, target) {
  if (!source) throw new Error(`The ${target} source project is unavailable.`);
  const project = checkedAppProject(source.project);
  if (!source.targets.includes(target)) throw new Error(`The ${target} source project is unavailable.`);
  const output = project.outputs.find(row => row.target === target);
  if (!output || output.status === 'unsupported') throw new Error(`The ${target} source project is unavailable.`);
  return { key: source.key, project, output };
}

function validateWebSources(sources, { id, name }) {
  const usedRoutes = new Set();
  const usedPaths = new Map();
  const pages = [];
  const assets = [];
  const behaviors = [];
  const capabilities = [];
  const usedCapabilityIds = new Set();
  const permissions = [];
  const sourceEntries = [];
  const provenance = [];

  const mounts = webSourceMounts(sources);
  if (sources.length > 1 && sources.some(row => row.project.permissions.length)) {
    throw new Error('A composed web output cannot carry native device permissions.');
  }
  for (const { key, project, output } of sources) {
    if (output.presenter !== 'editable-file') {
      throw new Error(`The ${key} source is not an editable site folder that can be composed.`);
    }
    const mount = mounts.get(key) ?? '';
    if (mount && (project.behaviors.some(row => row.kind === 'local-script' || row.kind === 'source-module') ||
        project.assets.some(asset => /\.m?js$/i.test(asset.path)))) {
      throw new Error(`The ${key} source has JavaScript whose paths cannot be safely mounted.`);
    }
    sourceEntries.push({ key, id: project.source.id, kind: project.source.kind,
      revision: project.source.revision });
    const origin = project.source.origin_url ?? project.source.origin?.origin_url ?? 'selected site folder';
    provenance.push(`Source ${key}: ${project.source.kind} ${project.source.id} at ${project.source.revision}; origin ${origin}.`);
    for (const skipped of project.source.skipped ?? []) {
      provenance.push(`Source ${key}: skipped ${skipped.address} because ${skipped.reason}`);
    }
    for (const warning of project.source.warnings ?? []) provenance.push(`Source ${key}: ${warning}`);
    for (const page of project.pages) {
      const path = mountedWebRoute(mount, page.path);
      if (usedRoutes.has(path)) throw new Error(`Two source projects provide ${path} for web.`);
      usedRoutes.add(path);
      const source_path = mountedWebFile(mount, page.source_path);
      const next = { ...page, id: `${key}:${page.id}`, path, source_path,
        presenter: { kind: 'editable-file', path: source_path } };
      pages.push(next);
      const previous = usedPaths.get(source_path);
      if (previous) throw new Error(`The ${key} source file ${source_path} conflicts with ${previous}.`);
      usedPaths.set(source_path, key);
    }
    for (const asset of project.assets) {
      const path = mountedWebFile(mount, asset.path);
      const previous = usedPaths.get(path);
      if (previous) throw new Error(`The ${key} source file ${path} conflicts with ${previous}.`);
      usedPaths.set(path, key);
      assets.push({ ...asset, path });
    }
    for (const behavior of project.behaviors) {
      if (behavior.kind === 'visitor-action' && key !== 'site') {
        throw new Error(`The ${key} source has a visitor action without its action definition.`);
      }
      if (mount) {
        throw new Error(`The ${key} source behavior cannot be safely mounted under /${key}/.`);
      }
      behaviors.push({ ...behavior, id: `${key}-${behavior.id}`,
        ...(behavior.source_path ? { source_path: mountedWebFile(mount, behavior.source_path) } : {}) });
    }
    for (const capability of project.capabilities) {
      const id = webCapabilityId(key, project, capability.id);
      if (id.length > 80) throw new Error(`The ${key} source has a placement id that cannot be carried to the web output.`);
      if (usedCapabilityIds.has(id)) throw new Error(`The ${key} source has a colliding web capability id ${id}.`);
      usedCapabilityIds.add(id);
      capabilities.push({ ...capability, id, page_id: `${key}:${capability.page_id}` });
    }
    for (const permission of project.permissions) {
      const prior = permissions.find(row => row.kind === permission.kind);
      if (prior && prior.purpose !== permission.purpose) {
        throw new Error(`The ${key} source has a conflicting ${permission.kind} permission purpose.`);
      }
      if (!prior) permissions.push(permission);
    }
  }

  const rootSource = [...sources].sort((a, b) => a.key.localeCompare(b.key))
    .find(source => !(mounts.get(source.key) ?? ''));
  if (!rootSource) throw new Error('The web output has no home source.');
  const sourceKind = rootSource.project.source.origin?.kind ?? rootSource.project.source.kind;
  const sourceRevision = revisionOf(sourceEntries);
  if (provenance.length > 100 || provenance.some(row => row.length > 500)) {
    throw new Error('The web sources have too much origin history to keep in one publication record.');
  }
  const identity = { id,
    source: { kind: sourceKind, id: `assembly:${id}`,
      revision: sourceRevision,
      ...(sourceKind === 'public-url-copy' && (rootSource.project.source.origin_url ?? rootSource.project.source.origin?.origin_url)
        ? { origin_url: rootSource.project.source.origin_url ?? rootSource.project.source.origin.origin_url } : {}),
      coverage: {
        routes: sources.some(row => row.project.source.coverage.routes !== 'kept') ? 'source-dependent' : 'kept',
        assets: sources.some(row => row.project.source.coverage.assets !== 'kept') ? 'source-dependent' : 'kept',
        browser_code: sources.some(row => row.project.source.coverage.browser_code === 'source-dependent') ? 'source-dependent' :
          sources.some(row => row.project.source.coverage.browser_code === 'kept') ? 'kept' : 'not-imported',
        server_code: sources.some(row => row.project.source.coverage.server_code !== 'not-imported') ? 'source-dependent' : 'not-imported',
        sign_in: sources.some(row => row.project.source.coverage.sign_in !== 'not-imported') ? 'source-dependent' : 'not-imported',
        native_code: 'not-imported',
      },
      warnings: [...new Set(provenance)],
    },
    pages: pages.sort((a, b) => a.path.localeCompare(b.path)),
    assets: assets.sort((a, b) => a.path.localeCompare(b.path)),
    behaviors: behaviors.sort((a, b) => a.id.localeCompare(b.id)),
    capabilities: capabilities.sort((a, b) => a.id.localeCompare(b.id)),
    permissions: permissions.filter((row, index) => permissions.findIndex(other => other.kind === row.kind) === index),
    outputs: [{ target: 'web', presenter: 'editable-file', status: sources.some(row => row.output.status === 'draft') ? 'draft' : 'published' }],
  };
  return checkedAppProject({ schema: 'trillion.app-project', name, ...identity });
}

/** Build a web output from multiple same-kind, noncolliding web source projects. */
export function composeWebAppProject({ id, name, sources }) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,79}$/.test(id) ||
      typeof name !== 'string' || !name.trim() || name.length > 80) {
    throw new Error('The web output needs its app project name and id.');
  }
  if (!Array.isArray(sources) || !sources.length || sources.length > 20 ||
      sources.some(source => !source || typeof source.key !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(source.key)) ||
      new Set(sources.map(source => source.key)).size !== sources.length) {
    throw new Error('A web output needs one or more uniquely named source projects.');
  }
  const selected = sources.map(source => ({ ...checkedTargetSource(source, 'web'), targets: ['web'] }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return validateWebSources(selected, { id, name: name.trim() });
}

/** Select one source when there is one; compose only the web target when there are several. */
export function composeAppProjectOutput(assembly, target) {
  if (!TARGETS.includes(target)) throw new Error('Choose a web, iPhone, or Mac app target.');
  const selected = assembly.outputs.find(row => row.target === target)?.sources ?? [];
  if (selected.length === 1) return checkedTargetSource(
    assembly.sources.find(source => source.key === selected[0].source), target).project;
  if (target !== 'web') throw new Error(`The ${target} output currently needs one source project; this project has ${selected.length}.`);
  if (!selected.length) throw new Error(`This app project does not support a ${target} output.`);
  const sources = selected.map(row => assembly.sources.find(source => source.key === row.source));
  if (sources.some(source => !source)) throw new Error(`The ${target} source project is unavailable.`);
  return composeWebAppProject({ id: assembly.id, name: assembly.name, sources });
}
