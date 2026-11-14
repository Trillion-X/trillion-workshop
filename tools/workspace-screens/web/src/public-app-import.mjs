// Read a browser-selected site folder into the same source map used by the
// editor and AI tools. Import reports what the current public host cannot run.
import { MAX_PUBLIC_APP_BYTES, MAX_PUBLIC_APP_FILE_BYTES, MAX_PUBLIC_APP_FILES, publicAppFilePath, publicAppMediaType } from 'trillion-workshop/tools/shared-code/src/public-app-files.mjs';
import { MAX_INDEX_BYTES, MAX_INDEX_FILES } from './public-app-file-index.mjs';
import { NotPublicAddress, publicAddress } from 'trillion-workshop/tools/refuse-requests-to-private-addresses/public-address.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { pageFile, rewrite } from 'trillion-workshop/tools/copy-a-site/do-work/copy-addresses.mjs';

const EDITABLE = new Set(['html', 'css']);
const IMPORT_ORIGIN = 'https://imported-site.invalid';

function pageRoute(path) {
  const route = path === 'index.html' ? '/' : path.endsWith('/index.html') ? `/${path.slice(0, -'index.html'.length)}` : `/${path}`;
  return route === '/' ? route : route.replace(/\/+$/, '');
}

function importedPageRoute(path) {
  return path === 'index.html' ? '/' : path.endsWith('/index.html')
    ? `/${path.slice(0, -'index.html'.length)}` : `/${path}`;
}

function missingPageLinks(files) {
  const missing = new Set();
  const paths = Object.keys(files);
  const pathSet = new Set(paths);
  const pages = new Set(paths.filter(path => path.endsWith('.html')).map(importedPageRoute));
  for (const route of pages) if (route !== '/') pages.add(route.replace(/\/+$/, ''));
  for (const [path, html] of Object.entries(files)) {
    if (!path.endsWith('.html') || typeof html !== 'string' || html.startsWith('data:')) continue;
    for (const warning of missingPageLinksForHtml(path, html, pages, pathSet)) missing.add(warning);
  }
  const warnings = [...missing];
  return warnings.length <= 30 ? warnings : [...warnings.slice(0, 29),
    `${warnings.length - 29} more links point to pages outside this copy.`];
}

function* missingPageLinksForHtml(path, html, pages, paths) {
  for (const match of html.matchAll(/<a\b[^>]*?\s+href\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))/gi)) {
    const href = (match[2] ?? match[3]).trim();
    if (!href || href.startsWith('#') || /[{}]/.test(href)) continue;
    let target;
    try { target = new URL(href, `${IMPORT_ORIGIN}${importedPageRoute(path)}`); } catch { continue; }
    if (target.origin !== IMPORT_ORIGIN || pages.has(target.pathname) || paths.has(target.pathname.slice(1))) continue;
    yield `${path}: ${target.pathname} has no copied page. Add that page or link to its original address.`;
  }
}

function reportedWarnings(warnings) {
  const rows = [...new Set(warnings)].map(warning => warning.length <= 500 ? warning : `${warning.slice(0, 497)}...`);
  return rows.length <= 100 ? rows : [...rows.slice(0, 99), `${rows.length - 99} more import findings were omitted.`];
}

function missingSourcePageLinks(files, sourceOrigin, knownPages = null) {
  const pages = knownPages ?? new Set(Object.keys(files).filter(path => path.endsWith('.html')).map(pageRoute));
  const missing = new Map();
  for (const [path, html] of Object.entries(files)) {
    if (!path.endsWith('.html') || typeof html !== 'string' || html.startsWith('data:')) continue;
    for (const match of html.matchAll(/<a\b[^>]*?\s+href\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))/gi)) {
      const href = (match[2] ?? match[3]).trim();
      if (!href || href.startsWith('#') || /[{}]/.test(href)) continue;
      let target;
      try { target = new URL(href, `${IMPORT_ORIGIN}${pageRoute(path)}`); } catch { continue; }
      const pointsToSource = target.origin === sourceOrigin;
      if (!pointsToSource && target.origin !== IMPORT_ORIGIN) continue;
      const route = pageRoute(target.pathname === '/' ? 'index.html' : target.pathname.slice(1));
      if (pages.has(route) || Object.hasOwn(files, target.pathname.slice(1))) continue;
      if (!pointsToSource) target = new URL(target.pathname + target.search, sourceOrigin);
      target.hash = '';
      missing.set(target.href, { address: target.href,
        reason: pointsToSource ? 'the linked page was not copied; its link still opens the original site' : 'the linked page was not copied; it has no page in this copy' });
    }
  }
  return [...missing.values()];
}

/** Stream saved copy batches into the indexed importer without joining their files in memory. */
export async function* streamCopiedPublicSite({ batches, sourceUrl, readFile, skipped = [] }) {
  const checkedUrl = checkedPublicSiteUrl(sourceUrl);
  const origin = new URL(checkedUrl).origin;
  const pageRoutes = new Set();
  const addressToFile = new Map();
  for (const batch of batches ?? []) {
    const result = batch?.result;
    if (result?.origin !== origin || !Array.isArray(result.pages) ||
        result.asset_paths !== undefined && !Array.isArray(result.asset_paths)) {
      throw new Error('This saved copy cannot continue. Start a fresh copy with the current site tool.');
    }
    for (const pageAddress of result.pages) {
      const url = new URL(pageAddress, origin);
      if (url.origin !== origin || url.search || url.hash) throw new Error('A copied page has an invalid address.');
      const path = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '');
      const route = pageRoute(pageFile(path));
      pageRoutes.add(route);
      pageRoutes.add(route.replace(/\/$/, '') || '/');
      addressToFile.set(path, path);
    }
    for (const asset of result.asset_paths ?? []) {
      const url = new URL(asset.address);
      if (url.origin !== origin || typeof asset.file !== 'string') throw new Error('A copied file has an invalid source address.');
      addressToFile.set(url.pathname + url.search, `/${asset.file}`);
    }
  }
  const fileOf = rest => {
    const url = new URL(rest, origin);
    const route = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '');
    return addressToFile.get(url.pathname + url.search) ?? (!url.search ? addressToFile.get(route) : null) ?? null;
  };
  const paths = new Set();
  const fingerprints = new Map();
  const preview = {};
  const warnings = [];
  const problems = [];
  const findings = [...skipped].filter(row => !/not copied because the \d+-page limit was reached/.test(row?.reason ?? ''));
  let fileCount = 0;
  let pageCount = 0;
  let bytes = 0;
  let previewBytes = 0;
  let previewPages = 0;
  let home = false;
  const ordered = [];
  for (const batch of batches) {
    const site = await readFile(batch.identity);
    if (!site?.files || typeof site.files !== 'object' || Array.isArray(site.files)) throw new Error('The copied site did not include its files.');
    if (Object.hasOwn(site.files, 'index.html')) ordered.push({ path: 'index.html', content: site.files['index.html'] });
    for (const [path, content] of Object.entries(site.files)) if (path !== 'index.html') ordered.push({ path, content });
    // Keep just this batch's contents alive while yielding its files.
    const current = ordered.splice(0);
    for (const { path, content: rawContent } of current) {
      let media;
      try {
        if (publicAppFilePath(path) !== path) throw new Error();
        media = publicAppMediaType(path);
      } catch { problems.push(`${path}: this copied file cannot be hosted.`); continue; }
      let content = rawContent;
      let raw;
      if (typeof content === 'string' && content.startsWith('data:')) {
        const match = content.match(/^data:([^,]*);base64,([\s\S]*)$/);
        if (!match || match[1] !== media || !match[2] || match[2].length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(match[2])) {
          problems.push(`${path}: the copied file has unreadable bytes.`); continue;
        }
        try { const binary = atob(match[2]); raw = Uint8Array.from(binary, character => character.charCodeAt(0)); }
        catch { problems.push(`${path}: the copied file has unreadable bytes.`); continue; }
      } else if (typeof content === 'string') raw = new TextEncoder().encode(content);
      else { problems.push(`${path}: the copied file has an unreadable format.`); continue; }
      if (raw.byteLength > MAX_PUBLIC_APP_FILE_BYTES) { problems.push(`${path} is larger than the ${MAX_PUBLIC_APP_FILE_BYTES / 1_000_000} MB file limit.`); continue; }
      if (paths.has(path)) {
        const fingerprint = bytesToHex(blake3(raw));
        if (fingerprints.get(path) !== fingerprint) throw new Error(`${path} changed while the site was being copied. Start a fresh copy to keep one consistent version.`);
        continue;
      }
      if (fileCount + 1 > MAX_INDEX_FILES || bytes + raw.byteLength > MAX_INDEX_BYTES) {
        problems.push('This folder is larger than the indexed site budget.');
        break;
      }
      paths.add(path);
      fingerprints.set(path, bytesToHex(blake3(raw)));
      if (path.endsWith('.html')) {
        home ||= path === 'index.html';
        pageCount++;
        if (typeof content === 'string' && !content.startsWith('data:')) {
          if (/<(?:script|img|video|audio|source)\b[^>]*\bsrc\s*=\s*["']https?:\/\/|<link\b[^>]*\bhref\s*=\s*["']https?:\/\//i.test(content)) warnings.push(`${path}: external scripts, styles or images will be blocked unless moved into this folder.`);
          if (/<script\b[^>]*>(?!\s*<\/script>)[\s\S]*?<\/script>/i.test(content)) warnings.push(`${path}: inline scripts are blocked by the public page content policy.`);
          if (/<form\b[^>]*\baction\s*=|fetch\s*\(|XMLHttpRequest|\/api\//i.test(content)) warnings.push(`${path}: server actions and API calls need a Trillion visitor action or a separate backend connection.`);
          findings.push(...missingSourcePageLinks({ [path]: content }, origin, pageRoutes));
        }
      }
      if ((path.endsWith('.html') || path.endsWith('.css')) && typeof content === 'string' && !content.startsWith('data:')) {
        content = rewrite(content, origin, fileOf);
        raw = new TextEncoder().encode(content);
      }
      if (raw.byteLength > MAX_PUBLIC_APP_FILE_BYTES) { problems.push(`${path} is larger than the ${MAX_PUBLIC_APP_FILE_BYTES / 1_000_000} MB file limit after its local links were updated.`); continue; }
      if (bytes + raw.byteLength > MAX_INDEX_BYTES) { problems.push('This folder is larger than the indexed site budget after its local links were updated.'); break; }
      fileCount++;
      bytes += raw.byteLength;
      if ((path === 'index.html' || previewBytes + raw.byteLength <= 32_000_000) &&
          (path === 'index.html' || Object.keys(preview).length < MAX_PUBLIC_APP_FILES) &&
          (!path.endsWith('.html') || previewPages < 200)) {
        preview[path] = content;
        previewBytes += raw.byteLength;
        if (path.endsWith('.html')) previewPages++;
      }
      yield { kind: 'file', path, content };
    }
    if (problems.some(problem => problem === 'This folder is larger than the indexed site budget.')) break;
  }
  if (!home) problems.push('The selected folder needs index.html at its top level. Select the built site folder, not its source folder.');
  const sourceFilePath = (() => { let name = 'trillion-import.json'; for (let suffix = 2; paths.has(name); suffix++) name = `trillion-import-${suffix}.json`; return name; })();
  const sourceFindings = reportedSkipped(findings, origin);
  const provenance = JSON.stringify({ source_url: checkedUrl, skipped: sourceFindings });
  const provenanceBytes = new TextEncoder().encode(provenance);
  if (fileCount + 1 > MAX_INDEX_FILES || bytes + provenanceBytes.byteLength > MAX_INDEX_BYTES) problems.push('This folder is larger than the indexed site budget.');
  else {
    paths.add(sourceFilePath); fileCount++; bytes += provenanceBytes.byteLength;
    if (Object.keys(preview).length < MAX_PUBLIC_APP_FILES && previewBytes + provenanceBytes.byteLength <= 32_000_000) preview[sourceFilePath] = `data:${publicAppMediaType(sourceFilePath)};base64,${base64(provenanceBytes)}`;
    yield { kind: 'file', path: sourceFilePath, content: provenance };
  }
  const uniqueWarnings = reportedWarnings([...warnings, ...sourceFindings.map(row => `${row.address}: ${row.reason}`)]);
  yield { kind: 'summary', files: preview, pages: Object.keys(preview).filter(path => path.endsWith('.html')),
    file_count: fileCount, page_count: pageCount, bytes, problems: [...new Set(problems)], warnings: uniqueWarnings,
    can_publish: home && problems.length === 0, source_url: checkedUrl, skipped: sourceFindings, source_file_path: sourceFilePath };
}

function reportedSkipped(rows, sourceOrigin) {
  const unique = [...new Map(rows.map(row => [`${row.address}\n${row.reason}`, row])).values()];
  return unique.length <= 100 ? unique : [...unique.slice(0, 99), {
    address: sourceOrigin,
    reason: `${unique.length - 99} more linked pages were not copied.`,
  }];
}

function base64(bytes) {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

export async function readPublicAppFolder(selected) {
  const picked = Array.from(selected ?? []);
  const files = {};
  const problems = [];
  const warnings = [];
  const roots = picked.map(file => file.webkitRelativePath || file.name).filter(Boolean);
  const commonRoot = roots.length && roots.every(path => path.includes('/') && path.split('/')[0] === roots[0].split('/')[0])
    ? `${roots[0].split('/')[0]}/` : '';
  let bytes = 0;
  for (const file of picked) {
    const path = (file.webkitRelativePath || file.name).slice(commonRoot.length);
    if (path.split('/').some(part => part === '.DS_Store' || part === 'Thumbs.db' || part === '.assetsignore' || part === '.vite') || path === '_headers' || path === '_redirects') continue;
    try { if (publicAppFilePath(path) !== path) throw new Error(); }
    catch { problems.push(`${path || file.name}: the path cannot be hosted.`); continue; }
    const extension = path.split('.').at(-1)?.toLowerCase();
    let media;
    try { media = publicAppMediaType(path); }
    catch { problems.push(`${path}: this file type cannot be hosted.`); continue; }
    bytes += file.size;
    if (file.size > MAX_PUBLIC_APP_FILE_BYTES) { problems.push(`${path} is larger than the ${MAX_PUBLIC_APP_FILE_BYTES / 1_000_000} MB file limit.`); continue; }
    if (bytes > MAX_PUBLIC_APP_BYTES) { problems.push(`This folder is larger than the ${MAX_PUBLIC_APP_BYTES / 1_000_000} MB app limit (${path} crosses it).`); break; }
    if (Object.keys(files).length === MAX_PUBLIC_APP_FILES) { problems.push(`This folder has more than ${MAX_PUBLIC_APP_FILES} supported files (${path} crosses the limit).`); break; }
    if (Object.hasOwn(files, path)) { problems.push(`${path}: the path is repeated.`); continue; }
    const raw = new Uint8Array(await file.arrayBuffer());
    if (EDITABLE.has(extension)) {
      try { files[path] = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
      catch { problems.push(`${path}: pages and styles need UTF-8 text to edit.`); }
    } else files[path] = `data:${media};base64,${base64(raw)}`;
  }
  if (!Object.hasOwn(files, 'index.html')) problems.push('The selected folder needs index.html at its top level. Select the built site folder, not its source folder.');
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith('.html') || content.startsWith('data:')) continue;
    if (/<(?:script|img|video|audio|source)\b[^>]*\bsrc\s*=\s*["']https?:\/\/|<link\b[^>]*\bhref\s*=\s*["']https?:\/\//i.test(content)) warnings.push(`${path}: external scripts, styles or images will be blocked unless moved into this folder.`);
    if (/<script\b[^>]*>(?!\s*<\/script>)[\s\S]*?<\/script>/i.test(content)) warnings.push(`${path}: inline scripts are blocked by the public page's content policy.`);
    if (/<form\b[^>]*\baction\s*=|fetch\s*\(|XMLHttpRequest|\/api\//i.test(content)) warnings.push(`${path}: server actions and API calls need a Trillion visitor action or a separate backend connection.`);
  }
  warnings.push(...missingPageLinks(files));
  return { files, problems: [...new Set(problems)], warnings: reportedWarnings(warnings), pages: Object.keys(files).filter(path => path.endsWith('.html')), bytes,
    can_publish: Object.hasOwn(files, 'index.html') && !problems.length };
}

/** Read one browser file at a time for an indexed import. The final event has only a bounded editor preview. */
export async function* streamPublicAppFolder(selected) {
  const picked = Array.from(selected ?? []);
  const roots = picked.map(file => file.webkitRelativePath || file.name).filter(Boolean);
  const commonRoot = roots.length && roots.every(path => path.includes('/') && path.split('/')[0] === roots[0].split('/')[0])
    ? roots[0].split('/')[0] + '/' : '';
  const named = picked.map(file => ({ file, path: (file.webkitRelativePath || file.name).slice(commonRoot.length) }));
  const home = named.find(row => row.path === 'index.html');
  const ordered = home ? [home, ...named.filter(row => row !== home)] : named;
  const seen = new Set();
  const importedFiles = new Map();
  const importedPages = new Set();
  const preview = {};
  const problems = [];
  const warnings = [];
  let bytes = 0;
  let fileCount = 0;
  let pageCount = 0;
  let previewPages = 0;
  let previewBytes = 0;
  for (const { file, path } of ordered) {
    if (path.split('/').some(part => part === '.DS_Store' || part === 'Thumbs.db' || part === '.assetsignore' || part === '.vite') || path === '_headers' || path === '_redirects') continue;
    try { if (publicAppFilePath(path) !== path) throw new Error(); }
    catch { problems.push((path || file.name) + ': the path cannot be hosted.'); continue; }
    let media;
    try { media = publicAppMediaType(path); }
    catch { problems.push(path + ': this file type cannot be hosted.'); continue; }
    if (seen.has(path)) { problems.push(path + ': the path is repeated.'); continue; }
    seen.add(path);
    if (file.size > MAX_PUBLIC_APP_FILE_BYTES) { problems.push(path + ' is larger than the ' + MAX_PUBLIC_APP_FILE_BYTES / 1_000_000 + ' MB file limit.'); continue; }
    if (fileCount + 1 > MAX_INDEX_FILES || bytes + file.size > MAX_INDEX_BYTES) {
      problems.push('This folder is larger than the indexed site budget.');
      break;
    }
    const raw = new Uint8Array(await file.arrayBuffer());
    let content;
    if (EDITABLE.has(path.split('.').at(-1)?.toLowerCase())) {
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
      catch { problems.push(path + ': pages and styles need UTF-8 text to edit.'); continue; }
    } else content = 'data:' + media + ';base64,' + base64(raw);
    fileCount++;
    bytes += raw.byteLength;
    importedFiles.set(path, file);
    if (path.endsWith('.html')) { pageCount++; importedPages.add(importedPageRoute(path)); }
    if ((path === 'index.html' || previewBytes + raw.byteLength <= 32_000_000) &&
        (path === 'index.html' || Object.keys(preview).length < MAX_PUBLIC_APP_FILES) &&
        (!path.endsWith('.html') || previewPages < 200)) {
      preview[path] = content;
      previewBytes += raw.byteLength;
      if (path.endsWith('.html')) previewPages++;
    }
    if (path.endsWith('.html')) {
      if (/<(?:script|img|video|audio|source)\b[^>]*\bsrc\s*=\s*["']https?:\/\/|<link\b[^>]*\bhref\s*=\s*["']https?:\/\//i.test(content)) warnings.push(path + ': external scripts, styles or images will be blocked unless moved into this folder.');
      if (/<script\b[^>]*>(?!\s*<\/script>)[\s\S]*?<\/script>/i.test(content)) warnings.push(path + ': inline scripts are blocked by the public page content policy.');
      if (/<form\b[^>]*\baction\s*=|fetch\s*\(|XMLHttpRequest|\/api\//i.test(content)) warnings.push(path + ': server actions and API calls need a Trillion visitor action or a separate backend connection.');
    }
    yield { kind: 'file', path, content };
  }
  if (!seen.has('index.html')) problems.push('The selected folder needs index.html at its top level. Select the built site folder, not its source folder.');
  for (const route of importedPages) if (route !== '/') importedPages.add(route.replace(/\/+$/, ''));
  const linkWarnings = new Set();
  for (const [path, file] of importedFiles) {
    if (!path.endsWith('.html')) continue;
    const html = typeof preview[path] === 'string' ? preview[path] : new TextDecoder().decode(await file.arrayBuffer());
    for (const warning of missingPageLinksForHtml(path, html, importedPages, importedFiles)) {
      linkWarnings.add(warning);
      if (linkWarnings.size > 30) break;
    }
    if (linkWarnings.size > 30) break;
  }
  const linkFindings = [...linkWarnings];
  warnings.push(...(linkFindings.length <= 30 ? linkFindings : [...linkFindings.slice(0, 29), 'More links point to pages outside this copy.']));
  yield { kind: 'summary', files: preview, pages: Object.keys(preview).filter(path => path.endsWith('.html')),
    file_count: fileCount, page_count: pageCount, bytes, problems: [...new Set(problems)],
    warnings: reportedWarnings(warnings), can_publish: seen.has('index.html') && !problems.length };
}

/** Keep URL imports on the same file, byte and public-host checks as a folder import. */
export function checkedPublicSiteUrl(value) {
  let address;
  try { address = new URL(publicAddress(String(value).trim())); }
  catch (error) { throw new Error(error instanceof NotPublicAddress ? error.message : 'Enter a public HTTPS address.'); }
  address.hash = '';
  return address.href;
}

/** A completed Workshop run presents the tool's result as one labelled JSON line. */
export function copiedSiteSkipped(run, previous = []) {
  const result = run?.output?.result ?? (() => {
    const line = run?.lines?.find(item => item.label === 'Result')?.text;
    if (!line) return null;
    try { return JSON.parse(line); } catch { return null; }
  })();
  const found = result?.skipped ?? previous;
  return Array.isArray(found) ? found.filter(item => item && typeof item.address === 'string' && typeof item.reason === 'string') : [];
}

/** Adapt the generic copy-a-site result to the existing import validation and retain its source/finding details. */
export async function readCopiedPublicSite(site, sourceUrl, skipped = []) {
  const checkedUrl = checkedPublicSiteUrl(sourceUrl);
  if (!site || typeof site !== 'object' || !site.files || typeof site.files !== 'object' || Array.isArray(site.files)) {
    throw new Error('The copied site did not include its files.');
  }
  const sourceOrigin = new URL(checkedUrl).origin;
  const findings = reportedSkipped([
    ...copiedSiteSkipped({ output: { result: { skipped } } }),
    ...missingSourcePageLinks(site.files, sourceOrigin),
  ], sourceOrigin);
  const provenance = JSON.stringify({ source_url: checkedUrl, skipped: findings });
  let sourceFilePath = 'trillion-import.json';
  for (let suffix = 2; Object.hasOwn(site.files, sourceFilePath); suffix++) sourceFilePath = `trillion-import-${suffix}.json`;
  const picked = Object.entries({ ...site.files, [sourceFilePath]: provenance }).map(([path, content]) => {
    let bytes;
    if (typeof content === 'string' && content.startsWith('data:')) {
      const match = content.match(/^data:[^,]*;base64,([\s\S]*)$/);
      if (!match) throw new Error(`${path}: the copied file has an unreadable format.`);
      try {
        const binary = atob(match[1]);
        bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      } catch { throw new Error(`${path}: the copied file has unreadable bytes.`); }
    } else if (typeof content === 'string') bytes = new TextEncoder().encode(content);
    else throw new Error(`${path}: the copied site contains an unreadable file.`);
    const file = {
      name: path.split('/').at(-1), webkitRelativePath: `copied/${path}`, size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
    return file;
  });
  const imported = await readPublicAppFolder(picked);
  return { ...imported, source_url: checkedUrl, skipped: findings, source_file_path: sourceFilePath };
}

/** Publish a copied site from its kept site.json, sending only import details through the browser. */
export function copiedPublicSitePublication(imported, id, identity) {
  if (!imported?.can_publish || !/^1f:[a-f0-9]{64}$/.test(identity ?? '')) throw new Error('The copied site is not ready to publish.');
  const path = imported.source_file_path;
  if (!path || !Object.hasOwn(imported.files, path)) throw new Error('The copied site has no source details.');
  return { id, actions: [], files_from: identity, files: { [path]: imported.files[path] } };
}
