// Server-side adapter for the GrapesJS editor over an existing public app.
// The editable authority remains the app's HTML/CSS files; GrapesJS imports
// these in the browser and exports HTML/CSS back through this adapter. Other
// app files and visitor actions are carried through unchanged.

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkedPublicAppDefinition } from './public-app-definition.mjs';
import { checkedPlacedCapabilities } from './public-app-capabilities.mjs';
import { checkedPublicAppFiles, publicAppFilePath, publicAppMediaType } from '../../shared-code/src/public-app-files.mjs';
import { setElement, withElementAddresses } from '../../shared-code/src/public-app-element-addresses.mjs';
import { mapCssResourceUrls } from '../parts/ui/read-data/css-resource-urls.mjs';

const EDITABLE_TEXT_LIMIT = 1_000_000;
const COMMAND_LIMIT = 50;
const EDITABLE = new Set(['html', 'css']);
const ACTION_ID = /^[a-z][a-z0-9-]{1,79}$/;
const RECORD_KIND = /^[a-z][a-z0-9._-]{1,99}$/;
const FIELD_ID = /^[a-z][a-z0-9-]{1,79}$/;
const FIELD_TYPES = new Set(['text', 'email', 'number', 'boolean', 'date']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function checkedEditorFilePath(value) {
  let path;
  try { path = decodeURIComponent(String(value ?? '')); } catch { throw new Error('This file path is invalid.'); }
  path = path.replace(/^\/+/, '') || 'index.html';
  if (path.endsWith('/')) path += 'index.html';
  const pieces = path.split('/');
  if (pieces.some(part => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))) {
    throw new Error('This file path is invalid.');
  }
  return pieces.join('/');
}

function checkedActions(id, actions) {
  const checked = checkedPublicAppDefinition({ id, version: 'editor-source', actions }).actions;
  // Preserve the host's exact compact action schema and reject fields it would
  // otherwise silently drop during a publish round trip.
  if (!Array.isArray(actions) || actions.length !== checked.length) throw new Error('The visitor actions are invalid.');
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (!object(action) || Object.keys(action).some(key => !['id', 'record_kind', 'fields'].includes(key))) throw new Error('The visitor actions are invalid.');
    if (!ACTION_ID.test(action.id ?? '') || !RECORD_KIND.test(action.record_kind ?? '') || !Array.isArray(action.fields)) throw new Error('The visitor actions are invalid.');
    for (const field of action.fields) {
      if (!object(field) || Object.keys(field).some(key => !['id', 'type', 'required'].includes(key)) ||
          !FIELD_ID.test(field.id ?? '') || !FIELD_TYPES.has(field.type) || (own(field, 'required') && typeof field.required !== 'boolean')) {
        throw new Error('The visitor actions are invalid.');
      }
    }
  }
  return checked;
}

export const checkedPublicAppEditorActions = checkedActions;

function checkedFiles(input) {
  const checked = checkedPublicAppFiles(input);
  const files = Object.fromEntries(Object.entries(checked).map(([path, file]) => [path, file.source]));
  if (Object.entries(files).some(([path, value]) => (path.endsWith('.html') || path.endsWith('.css')) && typeof value !== 'string')) {
    throw new Error('App pages and styles need editable text.');
  }
  return files;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function publicAppEditorRevision({ id, actions, files, placed_capabilities }) {
  const checked = { id, actions: checkedActions(id, actions), files: checkedFiles(files) };
  const placements = checkedPlacedCapabilities(placed_capabilities, checked);
  const row = { ...checked, ...(placements === undefined ? {} : { placed_capabilities: placements }) };
  return `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(canonical(row)))) )}`;
}

/** Validate and clone the current `{id, actions, files}` host definition. */
export function checkedPublicAppEditorSource(input) {
  if (!object(input) || typeof input.id !== 'string') throw new Error('Choose a public app to edit.');
  const actions = checkedActions(input.id, input.actions);
  const files = checkedFiles(input.files);
  const placed_capabilities = checkedPlacedCapabilities(input.placed_capabilities, { files, actions });
  return { id: input.id, actions, files, ...(placed_capabilities === undefined ? {} : { placed_capabilities }),
    revision: publicAppEditorRevision({ id: input.id, actions, files, placed_capabilities }) };
}

export function requirePublicAppEditorRevision(actual, expected) {
  if (typeof expected !== 'string' || !expected || actual !== expected) {
    throw new Error('This app changed elsewhere. Reload it before saving your edit.');
  }
  return true;
}

function editablePath(path) {
  const checked = checkedEditorFilePath(path);
  if (!EDITABLE.has(checked.split('.').at(-1)?.toLowerCase())) throw new Error('Edit the app HTML or CSS file.');
  return checked;
}

/** Every HTML file is an editable page; file paths remain the host's route authority. */
export function publicAppEditorPages(input) {
  const source = checkedPublicAppEditorSource(input);
  return Object.keys(source.files).filter(path => path.toLowerCase().endsWith('.html')).sort((a, b) =>
    a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b));
}

/** App-owned image files available to place in the visual editor. */
export function publicAppEditorImageAssets(input) {
  const source = checkedPublicAppEditorSource(input);
  return Object.keys(source.files).flatMap(path => {
    let mediaType;
    try {
      if (publicAppFilePath(path) !== path) return [];
      mediaType = publicAppMediaType(path);
    } catch { return []; }
    if (!mediaType.startsWith('image/')) return [];
    const name = path.split('/').at(-1);
    const label = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    return [{ path, url: `/${path.split('/').map(encodeURIComponent).join('/')}`, label, mediaType }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function decodeAttribute(value) {
  return value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

function routeFromHref(href, htmlPath) {
  const value = decodeAttribute(href.trim());
  if (!value || value.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return null;
  try {
    const base = `https://trillion-editor.invalid${publicAppEditorRoute(htmlPath)}`;
    const url = new URL(value, base);
    if (url.origin !== 'https://trillion-editor.invalid') return null;
    let path = url.pathname;
    if (path === '/') return null;
    if (!path.startsWith('/')) path = `/${path}`;
    if (path.split('/').some(part => part === '.' || part === '..' || !/^[a-zA-Z0-9._~-]*$/.test(part))) return null;
    const normalized = path.replace(/\/{2,}/g, '/');
    if (/\.[a-z0-9]{1,12}$/i.test(normalized)) return null;
    if (/^\/(?:api|actions|capabilities|assets|static|_next|_nuxt)(?:\/|$)/i.test(normalized)) return null;
    return normalized.endsWith('/') ? normalized : `${normalized}/`;
  } catch { return null; }
}

function clientMarkup(html) {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)?.[1] ?? html;
  return body.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<([a-z][a-z0-9-]*)\b(?=[^>]*\bid\s*=\s*["'](?:root|app|main|__next|__nuxt)["'])[^>]*>\s*<\/\1\s*>/gi, '').trim();
}

function routeTargets(html, htmlPath) {
  const routes = new Set();
  const hrefs = /<a\b(?=[^>]*\bhref\s*=\s*(["'])(.*?)\1)[^>]*>/gi;
  for (const match of html.matchAll(hrefs)) {
    const route = routeFromHref(match[2], htmlPath);
    if (route) routes.add(route);
  }
  const sourcePaths = /(?:href|to|path)\s*[:=]\s*(["'])(\/[a-zA-Z0-9._~/%-]+)\1/g;
  for (const match of html.matchAll(sourcePaths)) {
    const route = routeFromHref(match[2], htmlPath);
    if (route) routes.add(route);
  }
  return [...routes];
}

/** File pages plus same-app extensionless routes that fall back to index.html. */
export function publicAppEditorRoutePages(input) {
  const source = checkedPublicAppEditorSource(input);
  const files = Object.keys(source.files);
  const htmlPaths = publicAppEditorPages(source);
  const fileRoutes = htmlPaths.map(html_path => ({
    id: html_path,
    route: publicAppEditorRoute(html_path),
    html_path,
    kind: 'file',
    visual_supported: Boolean(clientMarkup(source.files[html_path])),
  }));
  const knownRoutes = new Set(fileRoutes.map(page => page.route));
  const knownFiles = new Set(files);
  const clientRoutes = new Set();
  const routeSources = htmlPaths.map(path => [path, source.files[path]]);
  let scriptBytes = 0;
  for (const path of files.filter(path => /\.(?:js|mjs)$/i.test(path)).sort()) {
    const content = source.files[path];
    if (typeof content !== 'string' || content.startsWith('data:')) continue;
    scriptBytes += new TextEncoder().encode(content).length;
    if (scriptBytes > 8_000_000) break;
    routeSources.push(['index.html', content]);
  }
  for (const [htmlPath, content] of routeSources) {
    for (const route of routeTargets(content, htmlPath)) {
      const possibleFile = route.replace(/^\//, '').replace(/\/$/, '');
      if (knownRoutes.has(route) || knownFiles.has(possibleFile) || knownFiles.has(`${possibleFile}/index.html`)) continue;
      clientRoutes.add(route);
    }
  }
  return [...fileRoutes, ...[...clientRoutes].sort().map(route => ({
    id: `route:${route}`,
    route,
    html_path: 'index.html',
    kind: 'client',
    visual_supported: false,
  }))];
}

export function publicAppEditorRoutePage(input, id = 'index.html') {
  const page = publicAppEditorRoutePages(input).find(row => row.id === id);
  if (!page) throw new Error('Choose a page from this app.');
  return page;
}

export function publicAppEditorRoute(path) {
  const checked = checkedEditorFilePath(path);
  if (!checked.toLowerCase().endsWith('.html')) throw new Error('Choose an HTML page.');
  return checked === 'index.html' ? '/' : checked.endsWith('/index.html')
    ? `/${checked.slice(0, -'index.html'.length)}` : `/${checked}`;
}

export function cssLinks(html, htmlPath = 'index.html') {
  const paths = [];
  const re = /<link\b(?=[^>]*\brel\s*=\s*["']?stylesheet\b)(?=[^>]*\bhref\s*=\s*["']([^"']+)["'])[^>]*>/gi;
  for (const match of html.matchAll(re)) {
    const href = match[1].split(/[?#]/, 1)[0];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
    try {
      const absolute = href.startsWith('/');
      const base = absolute ? [] : htmlPath.split('/').slice(0, -1);
      for (const part of href.replace(/^\/+/, '').split('/')) {
        if (part === '.' || part === '') continue;
        if (part === '..') { if (!base.length) throw new Error('Outside app'); base.pop(); }
        else base.push(part);
      }
      const path = editablePath(base.join('/'));
      if (path.endsWith('.css')) paths.push(path);
    } catch { /* Remote and unsafe links are not editor assets. */ }
  }
  return [...new Set(paths)];
}

/** Input for GrapesJS: existing HTML/CSS plus the unchanged app source bundle. */
export function grapesJsImportModel(input, { htmlPath = 'index.html', route = null } = {}) {
  const source = checkedPublicAppEditorSource(input);
  const selected = editablePath(htmlPath);
  if (!selected.endsWith('.html') || !own(source.files, selected)) throw new Error(`The ${selected} page is not part of this app.`);
  const linkedCss = cssLinks(source.files[selected], selected).filter(path => own(source.files, path));
  const cssPaths = linkedCss.length ? linkedCss : Object.keys(source.files).filter(path => path.toLowerCase().endsWith('.css') && !path.includes('/'));
  return {
    id: source.id,
    revision: source.revision,
    html_path: selected,
    route: route ?? publicAppEditorRoute(selected),
    html: withElementAddresses(source.files[selected]),
    css_paths: cssPaths,
    css: cssPaths.map(path => ({ path, content: source.files[path] })),
    // The canvas combines sheets, so keep every resource rooted at its original
    // sheet location. Source CSS remains untouched until a person edits styles.
    canvas_css: cssPaths.map(path => mapCssResourceUrls(source.files[path], value => {
      if (!value || value.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return value;
      try {
        const resource = new URL(value, `https://trillion-editor.invalid/${path}`);
        return `${resource.pathname}${resource.search}${resource.hash}`;
      } catch { return value; }
    })).join('\n'),
    actions: source.actions,
    files: source.files,
    ...(source.placed_capabilities === undefined ? {} : { placed_capabilities: source.placed_capabilities }),
  };
}

function htmlEscapedPath(path) { return path.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'); }

/** The page with its links to the `represented` sheets replaced by one link to `target`, placed where the first of
 *  them was, so the combined styles keep their place in the cascade. */
function withRepresentedLinksReplaced(html, htmlPath, represented, target) {
  const linkPath = target.startsWith(htmlPath.split('/').slice(0, -1).join('/') + '/') ? target.split('/').at(-1) : `/${target}`;
  let placed = false;
  return html.replace(/<link\b(?=[^>]*\brel\s*=\s*["']?stylesheet\b)[^>]*>\s*/gi, (tag) => {
    const [path] = cssLinks(tag, htmlPath);
    if (!path || !represented.includes(path)) return tag;
    if (placed) return '';
    placed = true;
    return `<link rel="stylesheet" href="${htmlEscapedPath(linkPath)}">\n`;
  });
}

/** Apply GrapesJS getHtml()/getCss() output, retaining every other app file. */
export function applyGrapesJsExport(input, { html, css, expectedRevision, htmlPath = 'index.html', cssPath = null }) {
  const source = checkedPublicAppEditorSource(input);
  requirePublicAppEditorRevision(source.revision, expectedRevision);
  const safeHtmlPath = editablePath(htmlPath);
  if (!safeHtmlPath.endsWith('.html') || typeof html !== 'string' || new TextEncoder().encode(html).length > EDITABLE_TEXT_LIMIT) throw new Error('The exported app page is invalid or too large.');
  if (typeof css !== 'string' || new TextEncoder().encode(css).length > EDITABLE_TEXT_LIMIT) throw new Error('The exported app styles are invalid or too large.');
  if (!own(source.files, safeHtmlPath)) throw new Error(`The ${safeHtmlPath} page is not part of this app.`);
  html = withElementAddresses(html);
  const existingLinks = cssLinks(html, safeHtmlPath);
  const oldLinked = cssLinks(source.files[safeHtmlPath], safeHtmlPath);
  const linkedCss = oldLinked.filter(path => typeof source.files[path] === 'string');
  const currentCssPaths = linkedCss.length ? linkedCss : Object.keys(source.files).filter(path => path.toLowerCase().endsWith('.css') && !path.includes('/') && typeof source.files[path] === 'string');
  if (css === currentCssPaths.map(path => source.files[path]).join('\n')) {
    const checked = checkedPublicAppEditorSource({ id: source.id, actions: source.actions,
      files: { ...source.files, [safeHtmlPath]: html }, placed_capabilities: source.placed_capabilities });
    return { ...checked, changed_files: [safeHtmlPath] };
  }
  if (!css.trim() && !cssPath && !existingLinks.length && !oldLinked.length) {
    const checked = checkedPublicAppEditorSource({ id: source.id, actions: source.actions,
      files: { ...source.files, [safeHtmlPath]: html }, placed_capabilities: source.placed_capabilities });
    return { ...checked, changed_files: [safeHtmlPath] };
  }
  // The exported styles are every represented sheet combined in link order. They go back into a linked sheet only
  // when it is the page's one sheet and no other page links it; otherwise into a sheet the page owns, whose single
  // link takes the place of the represented links (at the first one, keeping the cascade order), so a shared sheet
  // another page uses is never rewritten with this page's rules and a later stale sheet cannot override them.
  const pageOwned = `${safeHtmlPath.slice(0, -'.html'.length)}.editor.css`;
  const linkedByAnotherPage = path => Object.entries(source.files).some(([other, text]) => other !== safeHtmlPath
    && other.toLowerCase().endsWith('.html') && typeof text === 'string' && cssLinks(text, other).includes(path));
  const ownSheet = linkedCss.length === 1 && !linkedByAnotherPage(linkedCss[0]) ? linkedCss[0] : null;
  const targetCss = cssPath ? editablePath(cssPath) : (ownSheet ?? (linkedCss.length ? pageOwned : (existingLinks[0] ?? oldLinked[0] ?? pageOwned)));
  if (!targetCss.toLowerCase().endsWith('.css')) throw new Error('The exported styles need a CSS file.');
  const files = { ...source.files, [safeHtmlPath]: html, [targetCss]: css };
  if (linkedCss.length && !linkedCss.includes(targetCss)) files[safeHtmlPath] = withRepresentedLinksReplaced(html, safeHtmlPath, linkedCss, targetCss);
  if (!oldLinked.length && !existingLinks.length && css.trim()) {
    const linkPath = targetCss.startsWith(safeHtmlPath.split('/').slice(0, -1).join('/') + '/') ? targetCss.split('/').at(-1) : `/${targetCss}`;
    const link = `<link rel="stylesheet" href="${htmlEscapedPath(linkPath)}">`;
    files[safeHtmlPath] = /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, `${link}\n</head>`) : `${link}\n${html}`;
  }
  const checked = checkedPublicAppEditorSource({ id: source.id, actions: source.actions, files, placed_capabilities: source.placed_capabilities });
  return { ...checked, changed_files: [...new Set([safeHtmlPath, targetCss])] };
}

// Each kind of AI edit: the file's text and the command in, the new text out.
const EDIT_COMMANDS = {
  'replace-text': (text, command) => {
    if (typeof command.find !== 'string' || !command.find || typeof command.replace !== 'string') throw new Error('A text edit needs the exact text to find and its replacement.');
    if (command.find.length > 20_000 || command.replace.length > 20_000) throw new Error('This app edit is too large.');
    const first = text.indexOf(command.find);
    if (first < 0 || text.indexOf(command.find, first + command.find.length) >= 0) throw new Error('The exact text must appear once in the selected file.');
    return text.slice(0, first) + command.replace + text.slice(first + command.find.length);
  },
  // One element by its address (data-trillion-element, written into every page): its attributes, or its words.
  'set-element': (text, command, path) => {
    if (!path.toLowerCase().endsWith('.html')) throw new Error('Elements are changed on an HTML page.');
    if (typeof command.element !== 'string' || (command.attributes === undefined && command.text === undefined)) throw new Error('An element edit names the element and its new attributes or words.');
    if (typeof command.text === 'string' && command.text.length > 20_000) throw new Error('This app edit is too large.');
    return setElement(text, { element: command.element, attributes: command.attributes, text: command.text });
  },
};

/** Apply AI edits (exact text, or one addressed element) to the same HTML/CSS files GrapesJS edits. */
export function applyPublicAppEditorCommands(input, { commands, expectedRevision }) {
  const source = checkedPublicAppEditorSource(input);
  requirePublicAppEditorRevision(source.revision, expectedRevision);
  if (!Array.isArray(commands) || !commands.length || commands.length > COMMAND_LIMIT) throw new Error('Give up to 50 app edits at once.');
  const files = { ...source.files };
  const changed = new Set();
  for (const command of commands) {
    const apply = object(command) ? EDIT_COMMANDS[command.type] : undefined;
    if (!apply) throw new Error('Each AI edit must replace exact text in an app HTML or CSS file, or change one addressed element.');
    const path = editablePath(command.path);
    if (!own(files, path)) throw new Error(`The ${path} file is not part of this app.`);
    const text = files[path];
    if (new TextEncoder().encode(text).length > EDITABLE_TEXT_LIMIT) throw new Error('This app edit is too large.');
    files[path] = apply(text, command, path);
    changed.add(path);
  }
  for (const path of changed) if (path.toLowerCase().endsWith('.html')) files[path] = withElementAddresses(files[path]);
  const checked = checkedPublicAppEditorSource({ id: source.id, actions: source.actions, files, placed_capabilities: source.placed_capabilities });
  return { ...checked, changed_files: [...changed] };
}

/** Preview data uses the same live files and action declarations as publish. */
export function publicAppEditorPreview(input, { publicUrl = null } = {}) {
  const source = checkedPublicAppEditorSource(input);
  return { app_id: source.id, revision: source.revision, public_url: publicUrl, entry: 'index.html', files: source.files, actions: source.actions,
    ...(source.placed_capabilities === undefined ? {} : { placed_capabilities: source.placed_capabilities }) };
}

/** Snapshot a full publication so rollback restores files and visitor actions. */
export function createPublicAppEditorSnapshot(input, { createdAt = new Date().toISOString() } = {}) {
  const source = checkedPublicAppEditorSource(input);
  return { app_id: source.id, revision: source.revision, actions: source.actions, files: source.files,
    ...(source.placed_capabilities === undefined ? {} : { placed_capabilities: source.placed_capabilities }), created_at: String(createdAt) };
}

export function rollbackPublicAppEditorSnapshot(snapshot, current, { expectedRevision, createdAt = new Date().toISOString() } = {}) {
  const now = checkedPublicAppEditorSource(current);
  requirePublicAppEditorRevision(now.revision, expectedRevision);
  if (!object(snapshot) || snapshot.app_id !== now.id || !Array.isArray(snapshot.actions) || !object(snapshot.files)) throw new Error('That earlier app version is unavailable.');
  const restored = checkedPublicAppEditorSource({ id: now.id, actions: snapshot.actions, files: snapshot.files, placed_capabilities: snapshot.placed_capabilities });
  return { ...restored, restored_from: snapshot.revision ?? null, created_at: String(createdAt) };
}
