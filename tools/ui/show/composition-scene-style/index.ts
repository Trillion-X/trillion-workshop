import type { CSSProperties } from 'react';

export type CompositionSceneStyle = Record<string, unknown>;

export type SceneStyleRealization = {
  readonly css: CSSProperties;
  /** Keys whose values cannot be represented as inline CSS. */
  readonly unsupportedKeys: readonly string[];
};

const EXPLICIT_KEYS = new Set([
  'background',
  'border_color',
  'border_radius',
  'border_width',
  'color',
  'font_family',
  'font_size',
  'font_style',
  'font_weight',
  'highlight',
  'line_height',
  'padding',
  'text_align',
  'text_decoration',
  'text_decoration_line',
  'text_strike',
  'text_underline',
]);

const UNITLESS_CSS = new Set([
  'animationIterationCount', 'columnCount', 'flex', 'flexGrow', 'flexShrink',
  'fontWeight', 'gridArea', 'gridColumn', 'gridColumnEnd', 'gridColumnStart',
  'gridRow', 'gridRowEnd', 'gridRowStart', 'lineHeight', 'opacity', 'order',
  'orphans', 'scale', 'tabSize', 'widows', 'zIndex', 'zoom',
]);

/**
 * Realize authored scene style DATA as browser-local inline CSS.
 *
 * The named aliases preserve the Documents authoring contract. Scalar CSS
 * properties outside that set remain open: DOM captures can carry computed
 * kebab-case or camelCase properties without growing a closed registry here.
 * Structured non-CSS values (for example layout metadata) are reported rather
 * than silently stringified into invalid CSS.
 */
export function realizeSceneStyle(style?: CompositionSceneStyle): SceneStyleRealization {
  if (!style) return { css: {}, unsupportedKeys: [] };

  const css: Record<string, unknown> = {};
  const unsupportedKeys: string[] = [];

  for (const key of Object.keys(style).sort()) {
    if (EXPLICIT_KEYS.has(key)) continue;
    const value = style[key];
    if (!isCssScalar(value)) {
      if (value != null) unsupportedKeys.push(key);
      continue;
    }
    css[cssPropertyName(key)] = value;
  }

  assign(css, 'color', cssValue(style.color));
  // A highlight takes precedence over a code tint so both authoring actions
  // compose without a half-state.
  assign(css, 'background', cssValue(style.highlight) ?? cssValue(style.background));
  assign(css, 'borderColor', cssValue(style.border_color));
  assign(css, 'borderWidth', cssLength(style.border_width));
  assign(css, 'borderRadius', cssLength(style.border_radius));
  assign(css, 'fontFamily', cssValue(style.font_family));
  assign(css, 'fontSize', cssLength(style.font_size));
  // Keep the authored size available to the shared touch minimum. An em in a
  // font-size declaration reads the parent's size, not this element's size.
  if (css.fontSize != null) css['--specified-font-size'] = typeof css.fontSize === 'number' ? `${css.fontSize}px` : css.fontSize;
  assign(css, 'fontWeight', cssNumberOrText(style.font_weight));
  assign(css, 'fontStyle', cssValue(style.font_style));
  assign(css, 'lineHeight', cssNumberOrText(style.line_height));
  assign(css, 'textAlign', cssValue(style.text_align));
  assign(css, 'textDecorationLine', textDecorationLine(style));
  assign(css, 'paddingTop', cssLength(readPadding(style.padding, 'top')));
  assign(css, 'paddingRight', cssLength(readPadding(style.padding, 'right')));
  assign(css, 'paddingBottom', cssLength(readPadding(style.padding, 'bottom')));
  assign(css, 'paddingLeft', cssLength(readPadding(style.padding, 'left')));

  return { css: css as CSSProperties, unsupportedKeys };
}

export function sceneStyleToCss(style?: CompositionSceneStyle): CSSProperties {
  return realizeSceneStyle(style).css;
}

/** Apply the same React-style numeric unit semantics to a plain DOM renderer. */
export function applySceneStyleToElement(element: HTMLElement, style?: CompositionSceneStyle): void {
  for (const [property, value] of Object.entries(sceneStyleToCss(style))) {
    if (value == null) continue;
    const serialized = typeof value === 'number' && value !== 0 && !UNITLESS_CSS.has(property)
      ? `${value}px`
      : String(value);
    if (property.startsWith('--')) element.style.setProperty(property, serialized);
    else (element.style as unknown as Record<string, string>)[property] = serialized;
  }
}

export type CapturedSceneCapability = {
  readonly editability: 'editable' | 'partial' | 'opaque';
  readonly raster_fallback_src?: string;
  readonly raster_fallback_ref?: string;
};

export type CapturedSceneElementData = {
  readonly tag_name?: string;
  readonly namespace_uri?: string;
  readonly attributes?: Record<string, unknown>;
  readonly computed_css?: Record<string, unknown>;
  readonly capability?: CapturedSceneCapability;
};

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const PASSIVE_NAMESPACES = new Set([HTML_NAMESPACE, SVG_NAMESPACE, MATHML_NAMESPACE]);
const ACTIVE_CAPTURED_TAGS = new Set(['base', 'embed', 'form', 'iframe', 'link', 'meta', 'object', 'script', 'style']);
const CAPTURED_URL_ATTRIBUTES = new Set(['action', 'formaction', 'href', 'poster', 'src', 'xlink:href']);

/** One shared passive DOM realization primitive for every scene renderer. */
export function createCapturedSceneElement(data: CapturedSceneElementData | null, fallbackTag = 'div'): HTMLElement {
  const requestedTag = typeof data?.tag_name === 'string' ? data.tag_name.trim().toLowerCase() : '';
  const validTag = /^[a-z][a-z0-9-]*$/.test(requestedTag) && !ACTIVE_CAPTURED_TAGS.has(requestedTag);
  const namespace = typeof data?.namespace_uri === 'string' && PASSIVE_NAMESPACES.has(data.namespace_uri)
    ? data.namespace_uri
    : HTML_NAMESPACE;
  const element = document.createElementNS(validTag ? namespace : HTML_NAMESPACE, validTag ? requestedTag : fallbackTag) as HTMLElement;
  if (requestedTag && !validTag) element.dataset.sceneSourceTag = requestedTag;
  if (data?.namespace_uri && namespace !== data.namespace_uri) element.dataset.sceneSourceNamespace = data.namespace_uri;
  applySafeCapturedAttributes(element, data?.attributes);
  return element;
}

/** Preserve inert scalar attributes without reviving handlers or executable URLs. */
export function applySafeCapturedAttributes(element: HTMLElement, attributes: unknown): void {
  if (!isRecord(attributes)) return;
  for (const name of Object.keys(attributes).sort()) {
    const value = attributes[name]; const lower = name.toLowerCase();
    if (lower === 'style' || lower === 'id' || lower === 'srcdoc' || lower === 'nonce' || lower === 'data-node-id' || lower.startsWith('on') || !/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(name) || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) continue;
    if (value === false) continue;
    const serialized = value === true ? '' : String(value);
    if (CAPTURED_URL_ATTRIBUTES.has(lower) && !safeCapturedUrl(serialized, lower)) continue;
    if (lower === 'xlink:href') element.setAttributeNS(XLINK_NAMESPACE, 'href', serialized);
    else element.setAttribute(name, serialized);
  }
}

export function appendCapturedRasterFallback(element: HTMLElement, capability: CapturedSceneCapability | null, resolvedSrc?: string | null): HTMLImageElement | null {
  if (!capability || capability.editability === 'editable') return null;
  const src = capability.raster_fallback_src ?? resolvedSrc;
  if (!src || !safeCapturedUrl(src, 'src')) return null;
  const image = document.createElement('img'); image.src = src; image.alt = ''; image.setAttribute('aria-hidden', 'true'); image.dataset.sceneRasterFallback = capability.editability; image.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill;pointer-events:none'; element.appendChild(image); return image;
}

function safeCapturedUrl(value: string, attribute: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.startsWith('#') || normalized.startsWith('/') || normalized.startsWith('./') || normalized.startsWith('../') || /^(https?:|mailto:|tel:)/.test(normalized)) return true;
  return attribute === 'src' && /^data:image\/(?:png|gif|jpeg|webp|avif);base64,/.test(normalized);
}

function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function readPadding(value: unknown, side: 'top' | 'right' | 'bottom' | 'left'): unknown {
  return isRecord(value) ? value[side] : undefined;
}

function cssLength(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return cssValue(value);
}

function cssNumberOrText(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return cssValue(value);
}

function cssValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isCssScalar(value: unknown): value is string | number {
  return (typeof value === 'string' && value.trim().length > 0)
    || (typeof value === 'number' && Number.isFinite(value));
}

function cssPropertyName(key: string): string {
  if (key.startsWith('--') || !key.includes('-')) return key;
  return key.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function textDecorationLine(style: CompositionSceneStyle): string | undefined {
  const direct = cssValue(style.text_decoration_line);
  if (direct) return direct;
  const decoration = style.text_decoration;
  const lines = new Set<string>();
  if (typeof decoration === 'string') {
    for (const line of decoration.trim().split(/\s+/)) if (line) lines.add(line);
  } else if (isRecord(decoration)) {
    for (const key of Object.keys(decoration).sort()) if (decoration[key] === true) lines.add(key);
  }
  if (style.text_underline === true) lines.add('underline');
  if (style.text_strike === true) lines.add('line-through');
  return lines.size > 0 ? [...lines].join(' ') : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Measure the actual unwrapped glyph run, preserving inline markup and root typography. */
export function measureNaturalTextWidth(element: HTMLElement): number | undefined {
  if (!(element.textContent ?? '').trim()) return undefined;
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  if (!view || !doc.body) return undefined;
  const clone = element.cloneNode(true) as HTMLElement;
  const computed = view.getComputedStyle(element);
  Object.assign(clone.style, {
    position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden', pointerEvents: 'none',
    display: 'inline-block', width: 'max-content', minWidth: '0', maxWidth: 'none',
    height: 'auto', minHeight: '0', maxHeight: 'none', whiteSpace: 'pre',
    overflowWrap: 'normal', wordBreak: 'normal', boxSizing: 'content-box',
    fontFamily: computed.fontFamily, fontSize: computed.fontSize, fontWeight: computed.fontWeight,
    fontStyle: computed.fontStyle, lineHeight: computed.lineHeight, letterSpacing: computed.letterSpacing,
    wordSpacing: computed.wordSpacing, textTransform: computed.textTransform,
    textIndent: computed.textIndent, tabSize: computed.tabSize,
    paddingLeft: computed.paddingLeft, paddingRight: computed.paddingRight,
  });
  clone.removeAttribute('id');
  clone.setAttribute('aria-hidden', 'true');
  clone.setAttribute('contenteditable', 'false');
  clone.inert = true;
  doc.body.appendChild(clone);
  try { return clone.getBoundingClientRect().width; }
  finally { clone.remove(); }
}

