// What a selected rendered element can prove about itself. A source file is
// deliberately absent until a connected project verifies one.
export type VisualSelectionRef = {
  page_path: string;
  route?: string;
  revision: string;
  selector: string;
  /** The element's own address on its page (data-trillion-element, src/public-app-element-addresses.mjs), when it has one. */
  element?: string;
  tag: string;
  text: string;
  ancestry: string[];
  ancestors: { tag: string; attributes: Record<string, string> }[];
  attributes: Record<string, string>;
  bounds: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
  /** A rendered marker supplied by a connected project; never proof of source on its own. */
  source_hint?: { marker: string };
  source_revision?: string;
};

const safeId = (value: string) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);

export function captureVisualSelection(element: Element, { pagePath, route, revision }: { pagePath: string; route?: string; revision: string }): VisualSelectionRef {
  const doc = element.ownerDocument;
  const parts: string[] = [];
  const ancestry: string[] = [];
  const ancestors: { tag: string; attributes: Record<string, string> }[] = [];
  for (let node: Element | null = element; node && node !== doc.documentElement; node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    ancestry.push(tag);
    if (node !== element) ancestors.unshift({ tag, attributes: Object.fromEntries(['id', 'data-testid'].filter(name => node!.hasAttribute(name)).map(name => [name, node!.getAttribute(name)!])) });
    if (node.id && safeId(node.id) && doc.querySelectorAll(`#${node.id}`).length === 1) {
      parts.unshift(`#${node.id}`);
      break;
    }
    const siblings = node.parentElement ? [...node.parentElement.children].filter(child => child.tagName === node?.tagName) : [];
    const index = siblings.indexOf(node) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
    if (tag === 'body') break;
  }
  const rect = element.getBoundingClientRect();
  const computed = doc.defaultView?.getComputedStyle(element);
  const styles = computed ? Object.fromEntries(['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'padding', 'margin', 'display', 'width'].map(name => [name, computed.getPropertyValue(name).trim()]).filter(([, value]) => value)) : {};
  const attributes = Object.fromEntries([...element.attributes].filter(attribute => !attribute.name.startsWith('data-gjs-')).slice(0, 20).map(attribute => [attribute.name, attribute.value.slice(0, 200)]));
  const sourceMarker = element.getAttribute('data-trillion-source')?.trim();
  const sourceRevision = element.closest('[data-trillion-source-commit]')?.getAttribute('data-trillion-source-commit')?.trim();
  const sourceHint = sourceMarker && sourceMarker.length <= 300 ? { marker: sourceMarker } : null;
  return {
    page_path: pagePath, ...(route ? { route } : {}), revision, selector: parts.join(' > '),
    ...(/^e[0-9a-z]+$/.test(element.getAttribute('data-trillion-element') ?? '') ? { element: element.getAttribute('data-trillion-element')! } : {}),
    tag: element.tagName.toLowerCase(),
    text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    ancestry: ancestry.slice(0, 12), ancestors: ancestors.slice(-12), attributes,
    bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    styles,
    ...(sourceHint ? { source_hint: sourceHint } : {}),
    ...(/^[0-9a-f]{40}$/.test(sourceRevision ?? '') ? { source_revision: sourceRevision } : {}),
  };
}

/** Converts only an explicitly stamped preview selection into source-project input. */
export function sourceProjectSelection(selection: VisualSelectionRef, projectId: string, currentCommit?: string) {
  if (!/^[a-f0-9]{32}$/.test(projectId)) return null;
  const revision = selection.source_revision ?? currentCommit;
  if (!revision || !/^[0-9a-f]{40}$/.test(revision)) return null;
  const route = selection.route ?? (selection.page_path === 'index.html' ? '/' : selection.page_path.endsWith('/index.html')
    ? `/${selection.page_path.slice(0, -'index.html'.length)}` : `/${selection.page_path}`);
  // Without a preview commit, a marker alone is too weak: require literal
  // rendered text and a stable attribute to match the current source instead.
  const attributes = selection.source_revision ? selection.attributes
    : Object.fromEntries(Object.entries(selection.attributes).filter(([name]) => name !== 'data-trillion-source'));
  if (!selection.source_revision && (!selection.text.trim() || !['id', 'data-testid', 'aria-label', 'name', 'href', 'src', 'title', 'class'].some(name => attributes[name]))) return null;
  const element = { tag: selection.tag, text: selection.text, selector: selection.selector, attributes };
  const parent = selection.ancestors.at(-1);
  const ancestors = parent?.attributes.id || parent?.attributes['data-testid'] ? [parent] : [];
  const result = { project_id: projectId, revision, route, frame: selection.page_path,
    element, ancestors, source_hint: selection.source_hint };
  const identity = { project_id: result.project_id, revision: result.revision, route: result.route, frame: result.frame,
    tag: element.tag, text: element.text, selector: element.selector, attributes: element.attributes, ancestors: result.ancestors };
  const fingerprint = `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(identity))))}`;
  return { ...result, fingerprint };
}
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
