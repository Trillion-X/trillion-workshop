// Pure edits over source bytes supplied by an authorized, pinned repository read.
// A production URL or CSS selector is never treated as a source file locator.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const MARK = 'data-trillion-source';
const TYPES = new Set(['html', 'htm', 'jsx', 'tsx', 'vue', 'svelte']);
const stableAttributes = ['id', 'data-testid', 'aria-label', 'name', 'href', 'src', 'title', 'class', 'className'];
const fail = (status, reason) => ({ status, reason });
const hash = value => `1f:${bytesToHex(blake3(new TextEncoder().encode(value)))}`;
const norm = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const MAX_CANDIDATE_FILES = 8;
const words = value => (String(value ?? '').toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []);

// Similar words identify places worth inspecting; they never prove that a
// rendered element came from a data value or authorize an edit.
export function sourceCandidateFiles(element, sources) {
  const wanted = words(element?.text);
  if (wanted.length < 3 || norm(element.text).length < 12) return { candidate_files: [], candidate_count: 0 };
  const phrases = new Set();
  for (let at = 0; at <= wanted.length - 3; at++) phrases.add(wanted.slice(at, at + 3).join(' '));
  const matches = [];
  for (const [path, source] of Object.entries(sources)) {
    if (typeof source !== 'string') continue;
    const tokens = words(source);
    const present = new Set();
    for (let at = 0; at <= tokens.length - 3; at++) present.add(tokens.slice(at, at + 3).join(' '));
    const matched = [...phrases].filter(phrase => present.has(phrase)).length;
    if (matched < 2) continue;
    const exact = norm(source).includes(norm(element.text));
    matches.push({ path, match: exact ? 'full_text' : 'text_fragments', matched_phrases: matched,
      total_phrases: phrases.size });
  }
  matches.sort((left, right) => Number(right.match === 'full_text') - Number(left.match === 'full_text') ||
    right.matched_phrases / right.total_phrases - left.matched_phrases / left.total_phrases ||
    left.path.localeCompare(right.path));
  return { candidate_files: matches.slice(0, MAX_CANDIDATE_FILES), candidate_count: matches.length };
}

function identity(selection) {
  const element = selection?.element ?? selection ?? {};
  return { project_id: selection?.project_id ?? null, revision: selection?.revision ?? selection?.commit ?? null,
    route: selection?.route ?? null, frame: selection?.frame ?? null, tag: element.tag ?? null,
    text: element.text ?? null, selector: element.selector ?? null, attributes: element.attributes ?? null,
    ancestors: selection?.ancestors ?? null };
}

export function sourceSelectionFingerprint(selection) { return hash(JSON.stringify(identity(selection))); }

function skipQuote(source, start) {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === quote) return i + 1;
  }
  return source.length;
}

function skipBraces(source, start) {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if ('\'"`'.includes(source[i])) { i = skipQuote(source, i) - 1; continue; }
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return i + 1;
  }
  return source.length;
}

function tagAt(source, start) {
  if (source.startsWith('<!--', start)) {
    const end = source.indexOf('-->', start + 4);
    return { kind: 'comment', start, end: end < 0 ? source.length : end + 3 };
  }
  const found = /^<(\/)?([A-Za-z][\w:.-]*)\b/.exec(source.slice(start));
  if (!found) return null;
  const name = found[2];
  let at = start + found[0].length;
  if (found[1]) {
    while (/\s/.test(source[at] ?? '')) at++;
    return source[at] === '>' ? { kind: 'close', name, start, end: at + 1 } : null;
  }
  const attributes = new Map();
  let selfClosing = false;
  while (at < source.length) {
    while (/\s/.test(source[at] ?? '')) at++;
    if (source.startsWith('/>', at)) { at += 2; selfClosing = true; break; }
    if (source[at] === '>') { at++; break; }
    const field = /^[^\s=/>]+/.exec(source.slice(at));
    if (!field) return null;
    const key = field[0];
    at += key.length;
    while (/\s/.test(source[at] ?? '')) at++;
    let entry = { kind: 'boolean', value: '' };
    if (source[at] === '=') {
      at++;
      while (/\s/.test(source[at] ?? '')) at++;
      const begin = at;
      if (source[at] === '"' || source[at] === "'") {
        at = skipQuote(source, at);
        if (source[at - 1] !== source[begin]) return null;
        entry = { kind: 'quoted', quote: source[begin], value: source.slice(begin + 1, at - 1), from: begin + 1, to: at - 1 };
      } else if (source[at] === '{') {
        at = skipBraces(source, at);
        if (source[at - 1] !== '}') return null;
        entry = { kind: 'expression', value: source.slice(begin, at), from: begin, to: at };
      } else {
        while (at < source.length && !/[\s>]/.test(source[at])) at++;
        entry = { kind: 'unquoted', value: source.slice(begin, at), from: begin, to: at };
      }
    }
    if (attributes.has(key)) return null;
    attributes.set(key, entry);
  }
  return source[at - 1] === '>' ? { kind: 'open', name, start, end: at, selfClosing, attributes } : null;
}

function sourceTags(source, path) {
  const jsx = /\.([jt]sx)$/.test(path);
  const tags = [];
  const stack = [];
  let mode = jsx ? 'code' : 'markup';
  let expressionDepth = 0;
  for (let at = 0; at < source.length;) {
    if (mode === 'code' || mode === 'expression') {
      if (source.startsWith('//', at)) { const end = source.indexOf('\n', at + 2); at = end < 0 ? source.length : end; continue; }
      if (source.startsWith('/*', at)) { const end = source.indexOf('*/', at + 2); at = end < 0 ? source.length : end + 2; continue; }
      if ('\'"`'.includes(source[at])) { at = skipQuote(source, at); continue; }
      if (mode === 'expression') {
        if (source[at] === '{') expressionDepth++;
        else if (source[at] === '}' && --expressionDepth === 0) { mode = 'jsx-text'; at++; continue; }
      }
    }
    if (mode === 'jsx-text' && source[at] === '{') { mode = 'expression'; expressionDepth = 1; at++; continue; }
    if (source[at] !== '<') { at++; continue; }
    const tag = tagAt(source, at);
    if (!tag) { at++; continue; }
    at = tag.end;
    if (tag.kind === 'open') {
      tag.ancestors = stack.map(parent => ({ name: parent.name, attributes: parent.attributes }));
      tags.push(tag);
      if (!jsx && /^(script|style)$/i.test(tag.name) && !tag.selfClosing) {
        const close = new RegExp(`</${tag.name}\\s*>`, 'ig');
        close.lastIndex = at;
        const end = close.exec(source);
        at = end ? close.lastIndex : source.length;
        stack.pop();
        continue;
      }
      if (!tag.selfClosing) { stack.push(tag); if (jsx) mode = 'jsx-text'; }
    } else if (tag.kind === 'close') {
      if (stack.at(-1)?.name === tag.name) stack.pop();
      if (jsx) mode = stack.length ? 'jsx-text' : 'code';
    }
  }
  return tags;
}

// JSON-backed copy is editable only when one non-key string value exactly
// matches the selected rendered text. This deliberately does not infer which
// object property a component intended to use.
function jsonStringValues(source) {
  let parsed;
  try { parsed = JSON.parse(source); } catch { return []; }
  if (typeof parsed === 'string') return [];
  const values = [];
  for (let start = 0; start < source.length;) {
    if (source[start] !== '"') { start++; continue; }
    const end = skipQuote(source, start);
    if (end > source.length || source[end - 1] !== '"') return [];
    let next = end;
    while (/\s/.test(source[next] ?? '')) next++;
    // A JSON string followed by a colon is an object key, never copy data.
    if (source[next] !== ':') {
      try { values.push({ start, end, value: JSON.parse(source.slice(start, end)) }); }
      catch { return []; }
    }
    start = end;
  }
  return values;
}

function bodyOf(source, tag) {
  if (tag.selfClosing) return null;
  const close = new RegExp(`</${tag.name}\\s*>`, 'g');
  close.lastIndex = tag.end;
  const found = close.exec(source);
  if (!found) return null;
  const text = source.slice(tag.end, found.index);
  return /[<>{}]/.test(text) ? null : { text, from: tag.end, to: found.index };
}

// Trillion's shared Text component renders the literal `as` element. Only a
// static `as` value can connect the JSX tag to the observed DOM tag.
function renderedTag(tag) {
  if (tag.name !== 'Text') return tag.name.toLowerCase();
  const as = tag.attributes.get('as');
  return as?.kind === 'quoted' ? as.value.toLowerCase() : null;
}

function renderText(sourceText) {
  return sourceText.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? whole;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function attributeMatches(tag, attrs) {
  return stableAttributes.filter(key => typeof attrs[key] === 'string' && attrs[key] &&
    renderText(tag.attributes.get(key === 'class' && tag.attributes.has('className') ? 'className' : key)?.value ?? '') === attrs[key]);
}

function ancestorMatches(tag, ancestors) {
  if (!Array.isArray(ancestors) || !ancestors.length) return true;
  const last = ancestors.at(-1);
  if (!last?.tag || tag.ancestors.at(-1)?.name !== last.tag) return false;
  const given = last.attributes ?? {};
  const identifier = given.id || given['data-testid'];
  if (!identifier) return false;
  return tag.ancestors.at(-1)?.attributes.get(given.id ? 'id' : 'data-testid')?.value === identifier;
}

/** A locator is accepted only after a unique source span matches captured DOM evidence. */
export function resolveSourceSelection({ selection, path, source, file_sha, commit, project, files, file_shas, complete_source_set = false } = {}) {
  const projectId = project?.id ?? selection?.project_id ?? null;
  const revision = project?.revision ?? commit ?? null;
  const element = selection?.element ?? selection ?? {};
  if (!selection || !element.tag || !revision || typeof selection.route !== 'string' ||
      (typeof selection.frame !== 'string' && typeof selection.frame !== 'object')) {
    return fail('unsupported', 'Capture a rendered element, route, frame, and pinned source revision.');
  }
  if (selection.project_id && projectId && selection.project_id !== projectId) return fail('conflict', 'The selection belongs to another source project.');
  const captured = selection.revision ?? selection.commit ?? selection.preview_commit ?? selection.source_hint?.commit;
  if (!captured) return fail('unsupported', 'The captured preview has no source revision.');
  if (captured !== revision) return fail('conflict', 'The preview and connected source revisions differ.');
  if (!selection.fingerprint || selection.fingerprint !== sourceSelectionFingerprint(selection)) return fail('conflict', 'The rendered selection changed after capture.');
  const sources = files ?? (typeof path === 'string' && typeof source === 'string' ? { [path]: source } : {});
  if (Object.keys(sources).length > 256) return fail('unsupported', 'Resolve against at most 256 candidate source files at once. Narrow the connected source set.');
  const candidates = [];
  const marker = element.attributes?.[MARK] ?? null;
  let unsupportedCandidate = false;
  if (!marker && (!files || !complete_source_set)) {
    return fail('unsupported', 'Unmarked elements need a complete bounded source search, not one suggested file.');
  }
  for (const [candidatePath, contents] of Object.entries(sources)) {
    if (typeof contents !== 'string' || contents.length > 1_000_000) continue;
    if (!TYPES.has(candidatePath.split('.').at(-1)?.toLowerCase())) {
      if (!marker && candidatePath.toLowerCase().endsWith('.json') && norm(element.text)) {
        for (const span of jsonStringValues(contents)) {
          if (norm(span.value) === norm(element.text)) candidates.push({ path: candidatePath, source: contents,
            data: span, evidence: { text: norm(element.text), kind: 'json-string-value' } });
        }
      }
      const values = Object.entries(element.attributes ?? {}).filter(([key, value]) => stableAttributes.includes(key) && typeof value === 'string' && value);
      if (candidatePath.toLowerCase().endsWith('.json')) continue;
      if (marker ? contents.includes(marker) : norm(element.text) && contents.includes(element.text) &&
          values.some(([, value]) => contents.includes(value))) unsupportedCandidate = true;
      continue;
    }
    for (const tag of sourceTags(contents, candidatePath)) {
      if (renderedTag(tag) !== String(element.tag).toLowerCase()) continue;
      const marked = tag.attributes.get(MARK);
      if (marker) {
        if (marked?.kind !== 'quoted' || marked.value !== marker) continue;
      } else {
        const text = bodyOf(contents, tag);
        if (!text || !norm(element.text) || norm(renderText(text.text)) !== norm(element.text)) continue;
        const matched = attributeMatches(tag, element.attributes ?? {});
        const ancestor = Array.isArray(selection.ancestors) && selection.ancestors.length > 0;
        if ((!matched.length && !ancestor) || (ancestor && !ancestorMatches(tag, selection.ancestors))) continue;
      }
      candidates.push({ path: candidatePath, source: contents, tag,
        evidence: marker ? { marker } : { text: norm(element.text), attributes: attributeMatches(tag, element.attributes ?? {}),
          ancestors: Array.isArray(selection.ancestors) ? selection.ancestors.length : 0 } });
    }
  }
  if (unsupportedCandidate) return { ...fail('unsupported', 'An unsupported source language also contains this element evidence; source ownership is uncertain.'),
    ...sourceCandidateFiles(element, sources) };
  if (candidates.length > 1) return { ...fail('ambiguous', 'Several source values match the selected rendered element.'),
    ...sourceCandidateFiles(element, sources) };
  if (!candidates.length) return { ...fail('unsupported', marker ? 'No source element carries the captured marker.' :
    'No unique source element matches the visible text and stable attributes.'), ...sourceCandidateFiles(element, sources) };
  const chosen = candidates[0];
  if (chosen.data) return { status: 'resolved', locator: { path: chosen.path, language: 'json',
    start: chosen.data.start, end: chosen.data.end, value: chosen.data.value, marker: null,
    evidence: chosen.evidence, source_hash: hash(chosen.source), file_sha: file_shas?.[chosen.path] ?? null,
    commit: revision, project_id: projectId } };
  return { status: 'resolved', locator: { path: chosen.path, language: chosen.path.split('.').at(-1).toLowerCase(),
    start: chosen.tag.start, end: chosen.tag.end, tag: chosen.tag.name, marker: marker ?? null,
    evidence: chosen.evidence, source_hash: hash(chosen.source), file_sha: file_shas?.[chosen.path] ?? file_sha ?? null,
    commit: revision, project_id: projectId } };
}

function textSpan(source, tag, value) {
  const body = bodyOf(source, tag);
  if (!body || !norm(body.text)) return fail('unsupported', 'The source element has no single literal text child.');
  const leading = /^\s*/.exec(body.text)[0].length;
  const trailing = /\s*$/.exec(body.text)[0].length;
  return { from: body.from + leading, to: body.to - trailing,
    next: value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('{', '&#123;').replaceAll('}', '&#125;') };
}

function cssStyleSpan(attribute, property, value) {
  if (attribute?.kind !== 'quoted' || /[(){}"']/.test(attribute.value)) return fail('unsupported', 'This style is not one static inline declaration.');
  const matches = [];
  let offset = 0;
  for (const chunk of attribute.value.split(';')) {
    const item = /^(\s*)([-a-zA-Z][\w-]*)(\s*:\s*)([^;]*?)(\s*)$/.exec(chunk);
    if (item?.[2] === property) {
      const from = attribute.from + offset + item[1].length + item[2].length + item[3].length;
      matches.push({ from, to: from + item[4].length });
    }
    offset += chunk.length + 1;
  }
  if (matches.length !== 1) return fail(matches.length ? 'ambiguous' : 'unsupported', 'The CSS property is absent or repeated.');
  return { ...matches[0], next: value.replaceAll('&', '&amp;').replaceAll(attribute.quote, attribute.quote === '"' ? '&quot;' : '&#39;') };
}

function jsxStyleSpan(attribute, property, value) {
  if (attribute?.kind !== 'expression' || !/^\{\{[\s\S]*\}\}$/.test(attribute.value)) return fail('unsupported', 'This JSX style is not a literal object.');
  const wanted = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  const inside = attribute.value.slice(2, -2);
  if (/[{}()[\]`]/.test(inside) || inside.includes('...')) return fail('unsupported', 'This JSX style object needs a language parser.');
  const matches = [];
  const pattern = /(?:^|,)(\s*)([A-Za-z_$][\w$]*)(\s*:\s*)(["'])([^"'\\]*)(\4)(?=\s*(?:,|$))/g;
  for (const item of inside.matchAll(pattern)) {
    if (item[2] !== wanted) continue;
    const from = attribute.from + 2 + item.index + item[0].length - item[5].length - 1;
    matches.push({ from, to: from + item[5].length, quote: item[4] });
  }
  if (matches.length !== 1) return fail(matches.length ? 'ambiguous' : 'unsupported', 'The JSX style property is absent or not one string literal.');
  const match = matches[0];
  return { from: match.from, to: match.to, next: value.replaceAll('\\', '\\\\').replaceAll(match.quote, `\\${match.quote}`).replaceAll('\n', '\\n') };
}

function decodedAttributeEntities(value) {
  return value.replace(/&(?:colon|tab|newline);|&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (whole, hex, decimal) => {
    if (/^&colon/i.test(whole)) return ':';
    if (/^&tab/i.test(whole)) return '\t';
    if (/^&newline/i.test(whole)) return '\n';
    const code = hex ? parseInt(hex, 16) : Number(decimal);
    return Number.isInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  }).replace(/&amp;/gi, '&');
}

function safeHref(value) {
  const decoded = decodedAttributeEntities(value).trim();
  if (!decoded || decoded.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(decoded) || decoded.startsWith('//')) return false;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(decoded)?.[1]?.toLowerCase();
  if (scheme) {
    if (!['http', 'https', 'mailto', 'tel'].includes(scheme)) return false;
    try {
      const url = new URL(decoded);
      return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }
  try { return new URL(decoded, 'https://trillion.invalid/').origin === 'https://trillion.invalid'; }
  catch { return false; }
}

function safeImagePath(value) {
  const decoded = decodedAttributeEntities(value).trim();
  if (!decoded || decoded.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(decoded) || decoded.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(decoded)) return false;
  try { return new URL(decoded, 'https://trillion.invalid/').origin === 'https://trillion.invalid'; }
  catch { return false; }
}

function attributeSpan(tag, path, intent) {
  const requested = intent.name;
  if (!['href', 'src', 'class'].includes(requested)) return fail('unsupported', 'Change an existing link, image path, or class value.');
  const jsx = /\.[jt]sx$/.test(path);
  const name = requested === 'class' && jsx ? 'className' : requested;
  const attribute = tag.attributes.get(name);
  if (!attribute || attribute.kind !== 'quoted') return fail('unsupported', 'The selected value must already exist as plain quoted text.');
  if (requested === 'href' && tag.name.toLowerCase() !== 'a') return fail('unsupported', 'Link addresses can be changed only on links.');
  if (requested === 'src' && tag.name.toLowerCase() !== 'img') return fail('unsupported', 'Image paths can be changed only on images.');
  if (requested === 'href' && !safeHref(intent.value)) return fail('unsupported', 'Use a safe web, email, phone, or page link.');
  if (requested === 'src' && !safeImagePath(intent.value)) return fail('unsupported', 'Use an image file within this site.');
  if (requested === 'class') {
    const tokens = intent.value.trim() ? intent.value.trim().split(/\s+/) : [];
    if (intent.value.length > 512 || /[\u0000-\u001f\u007f]/.test(intent.value) || tokens.length > 32 || tokens.some(token => !/^-?[A-Za-z_][A-Za-z0-9_:-]*$/.test(token))) {
      return fail('unsupported', 'Use up to 32 simple class names.');
    }
  }
  const value = intent.value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll(attribute.quote, attribute.quote === '"' ? '&quot;' : '&#39;');
  return { from: attribute.from, to: attribute.to, next: value };
}

/** Recheck the locator against current bytes, then replace only the intended span. */
export function applySourceEdit({ source, file_sha, commit, locator, intent } = {}) {
  if (typeof source !== 'string' || !locator || !intent || typeof intent.value !== 'string') return fail('unsupported', 'Give a source file, verified locator, and edit value.');
  if (locator.commit !== commit || locator.file_sha !== file_sha || locator.source_hash !== hash(source)) return fail('conflict', 'The source file changed after selection. Resolve the element again.');
  if (locator.language === 'json') {
    if (!locator.path?.toLowerCase().endsWith('.json') || intent.kind !== 'text' ||
        !Number.isInteger(locator.start) || !Number.isInteger(locator.end) || locator.start < 0 || locator.end > source.length || locator.end <= locator.start) {
      return fail('unsupported', 'Change a selected text value in a JSON source file.');
    }
    let current;
    try { current = JSON.parse(source.slice(locator.start, locator.end)); } catch { return fail('conflict', 'The selected data value changed. Resolve the element again.'); }
    if (typeof current !== 'string' || current !== locator.value) return fail('conflict', 'The selected data value changed. Resolve the element again.');
    if (current === intent.value) return fail('unsupported', 'The source already has this value.');
    const next = JSON.stringify(intent.value);
    const content = source.slice(0, locator.start) + next + source.slice(locator.end);
    return { status: 'ready', content, diff: { path: locator.path, from: current, to: intent.value,
      start: locator.start, end: locator.end },
    change_id: hash(JSON.stringify({ commit, file_sha, path: locator.path, from: locator.start, to: locator.end, next })) };
  }
  const tag = tagAt(source, locator.start);
  if (tag?.kind !== 'open' || tag.end !== locator.end || tag.name !== locator.tag) return fail('conflict', 'The source element no longer matches its locator.');
  if (locator.marker && tag.attributes.get(MARK)?.value !== locator.marker) return fail('conflict', 'The source marker changed.');
  let span;
  if (intent.kind === 'text') span = textSpan(source, tag, intent.value);
  else if (intent.kind === 'style') {
    if (!/^(?:--|-)?[A-Za-z][\w-]*$/.test(intent.property ?? '') || /[;{}<>\r\n]/.test(intent.value)) return fail('unsupported', 'Give one CSS property and a single value.');
    span = /\.[jt]sx$/.test(locator.path) ? jsxStyleSpan(tag.attributes.get('style'), intent.property, intent.value)
      : cssStyleSpan(tag.attributes.get('style'), intent.property, intent.value);
  } else if (intent.kind === 'attribute') span = attributeSpan(tag, locator.path, intent);
  else return fail('unsupported', 'This adapter supports literal text, existing inline styles, and safe existing attributes.');
  if (span.status) return span;
  const before = source.slice(span.from, span.to);
  if (before === span.next) return fail('unsupported', 'The source already has this value.');
  const content = source.slice(0, span.from) + span.next + source.slice(span.to);
  return { status: 'ready', content, diff: { path: locator.path, from: before, to: span.next, start: span.from, end: span.to },
    change_id: hash(JSON.stringify({ commit, file_sha, path: locator.path, from: span.from, to: span.to, next: span.next })) };
}
