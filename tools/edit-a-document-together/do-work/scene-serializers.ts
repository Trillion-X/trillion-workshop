import type {
  CompositionSnapshot,
  SceneNode,
  SceneNodeCapability,
  SceneNodeProps,
  SceneWebElement,
} from '../read-data/documents';
import { parseEmphasisRuns, safeInlineLinkUrl, sanitizeInlineStyle, type InlineMark } from '../read-data/inline-tokens.ts';

export type SceneSerializationFormat = 'html' | 'jsx';
export type SceneSerializationCapability = 'editable' | 'partial' | 'opaque';

export type SceneSerializationLoss = {
  readonly node_id: string | null;
  readonly path: string;
  readonly code: string;
  readonly detail: string;
};

export type SceneSerializationNodeCapability = {
  readonly node_id: string;
  readonly capability: SceneSerializationCapability;
  readonly reasons: readonly string[];
};

export type SceneSerializationFeatureCapability = {
  readonly feature: 'styles' | 'tags' | 'namespaces' | 'attributes' | 'pseudo-elements' | 'geometry';
  readonly support: 'supported' | 'partial' | 'unsupported' | 'unavailable';
  readonly detail: string;
};

export type SceneSerializationReport = {
  readonly complete: boolean;
  readonly stopped_by: 'depth-limit' | 'node-limit' | 'output-byte-limit' | null;
  readonly node_count: number;
  readonly capability_counts: Readonly<Record<SceneSerializationCapability, number>>;
  readonly loss_count: number;
  readonly features: readonly SceneSerializationFeatureCapability[];
  readonly nodes: readonly SceneSerializationNodeCapability[];
  readonly losses: readonly SceneSerializationLoss[];
};

export type SceneSerializationLimits = {
  readonly max_depth: number;
  readonly max_nodes: number;
  readonly max_output_bytes: number;
};

export type SceneSerializationOptions = {
  readonly limits?: Partial<SceneSerializationLimits>;
  /** The same DATA-authored mark rows used by the editor, needed to render inline marker tokens. */
  readonly inlineMarks?: readonly InlineMark[];
};

export type SceneSerializationResult = {
  readonly format: SceneSerializationFormat;
  readonly source: string;
  readonly report: SceneSerializationReport;
};

export type SceneSerializationInput =
  | SceneNode
  | readonly SceneNode[]
  | Pick<CompositionSnapshot, 'tree' | 'frames'>
  | CompositionSnapshot;

type MutableReport = {
  losses: SceneSerializationLoss[];
  nodes: SceneSerializationNodeCapability[];
  sawUnsupportedStyle: boolean;
  sawUnsupportedTag: boolean;
  sawNamespace: boolean;
  sawUnsupportedAttribute: boolean;
  sawPseudo: boolean;
  suppliedFrames: boolean;
  frameCount: number;
  missingFrameCount: number;
  sawUnsupportedGeometry: boolean;
  stoppedBy: SceneSerializationReport['stopped_by'];
  visitedNodeCount: number;
};

type SerializationContext = {
  readonly format: SceneSerializationFormat;
  readonly inlineMarks: readonly InlineMark[];
  readonly frames: CompositionSnapshot['frames'] | null;
  readonly report: MutableReport;
  readonly limits: SceneSerializationLimits;
  readonly activeNodes: WeakSet<object>;
};

const DEFAULT_LIMITS: SceneSerializationLimits = {
  max_depth: 128,
  max_nodes: 10_000,
  max_output_bytes: 5 * 1024 * 1024,
};

const RUST_NODE_PROPS = new Set([
  'a11y', 'artifact_dependencies', 'bundle', 'component_id', 'custom',
  'handlers', 'instance_props', 'integrity_hash', 'src', 'style', 'text',
  'things_to_put_on_screen',
]);
const WEB_ELEMENT_FIELDS = new Set([
  'attributes', 'capability', 'computed_css', 'geometry', 'namespace_uri',
  'pseudo_elements', 'resources', 'tag_name',
]);

const ACTIVE_TAGS = new Set(['embed', 'iframe', 'link', 'meta', 'object', 'script', 'style']);
const UNITLESS_CSS = new Set([
  'animationIterationCount', 'columnCount', 'flex', 'flexGrow', 'flexShrink',
  'fontWeight', 'gridArea', 'gridColumn', 'gridColumnEnd', 'gridColumnStart',
  'gridRow', 'gridRowEnd', 'gridRowStart', 'lineHeight', 'opacity', 'order',
  'orphans', 'scale', 'tabSize', 'widows', 'zIndex', 'zoom',
]);
const EXPLICIT_STYLE_KEYS = new Set(['background', 'border_color', 'border_radius', 'border_width', 'color', 'font_family', 'font_size', 'font_style', 'font_weight', 'highlight', 'line_height', 'padding', 'text_align', 'text_decoration', 'text_decoration_line']);

/** Deterministic HTML source readback over the canonical Documents scene.
 * This is an exporter, not an HTML sanitizer. URLs, CSS and custom-element names
 * retain authored semantics. Consumers must not mount untrusted exported source
 * in an application document without their own isolation/admission boundary.
 */
export function serializeSceneToHtml(
  input: SceneSerializationInput,
  options: SceneSerializationOptions = {},
): SceneSerializationResult {
  return serializeScene(input, 'html', options);
}

/** Deterministic JSX readback over the canonical Documents scene. */
export function serializeSceneToJsx(
  input: SceneSerializationInput,
  options: SceneSerializationOptions = {},
): SceneSerializationResult {
  return serializeScene(input, 'jsx', options);
}

export function serializeScene(
  input: SceneSerializationInput,
  format: SceneSerializationFormat,
  options: SceneSerializationOptions = {},
): SceneSerializationResult {
  const normalized = normalizeInput(input);
  const report: MutableReport = {
    losses: [],
    nodes: [],
    sawUnsupportedStyle: false,
    sawUnsupportedTag: false,
    sawNamespace: false,
    sawUnsupportedAttribute: false,
    sawPseudo: false,
    sawUnsupportedGeometry: false,
    suppliedFrames: normalized.frames !== null,
    frameCount: 0,
    missingFrameCount: 0,
    stoppedBy: null,
    visitedNodeCount: 0,
  };
  const limits = normalizeLimits(options.limits);
  const context: SerializationContext = {
    format,
    inlineMarks: options.inlineMarks ?? [],
    frames: normalized.frames,
    report,
    limits,
    activeNodes: new WeakSet<object>(),
  };

  if (normalized.camera && (
    normalized.camera.pan_x !== 0
    || normalized.camera.pan_y !== 0
    || normalized.camera.zoom !== 1
  )) {
    addLoss(report, null, 'camera', 'camera-transform', 'Camera pan/zoom is not embedded in node HTML/JSX.');
    report.sawUnsupportedGeometry = true;
  }

  let source = normalized.roots.map((node) => serializeNode(node, 0, context)).join('\n');
  if (utf8ByteLength(source) > limits.max_output_bytes) {
    stopAtLimit(report, null, 'output-byte-limit', `Serialized output exceeded ${limits.max_output_bytes} UTF-8 bytes.`);
    source = limitPlaceholder(format, 'output-byte-limit');
  }
  const counts: Record<SceneSerializationCapability, number> = { editable: 0, partial: 0, opaque: 0 };
  for (const node of report.nodes) counts[node.capability] += 1;

  return {
    format,
    source,
    report: {
      complete: report.stoppedBy === null,
      stopped_by: report.stoppedBy,
      node_count: report.nodes.length,
      capability_counts: counts,
      loss_count: report.losses.length,
      features: featureCapabilities(report),
      nodes: report.nodes,
      losses: report.losses,
    },
  };
}

function normalizeInput(input: SceneSerializationInput): {
  roots: readonly SceneNode[];
  frames: CompositionSnapshot['frames'] | null;
  camera: CompositionSnapshot['camera'] | null;
} {
  if (Array.isArray(input)) return { roots: input, frames: null, camera: null };
  if (isSceneNode(input)) return { roots: [input], frames: null, camera: null };
  const snapshot = input as Pick<CompositionSnapshot, 'tree' | 'frames'> & Partial<Pick<CompositionSnapshot, 'camera'>>;
  return {
    roots: snapshot.tree ? [snapshot.tree] : [],
    frames: snapshot.frames,
    camera: snapshot.camera ?? null,
  };
}

function serializeNode(node: SceneNode, depth: number, context: SerializationContext): string {
  if (depth > context.limits.max_depth) {
    stopAtLimit(context.report, node.id, 'depth-limit', `Scene depth exceeded ${context.limits.max_depth}.`);
    return limitPlaceholder(context.format, 'depth-limit');
  }
  if (context.report.visitedNodeCount >= context.limits.max_nodes) {
    stopAtLimit(context.report, node.id, 'node-limit', `Scene node count exceeded ${context.limits.max_nodes}.`);
    return limitPlaceholder(context.format, 'node-limit');
  }
  if (context.activeNodes.has(node)) {
    addLoss(context.report, node.id, 'children', 'scene-cycle', 'A recursive SceneNode cycle was omitted.');
    return limitPlaceholder(context.format, 'scene-cycle');
  }
  context.report.visitedNodeCount += 1;
  context.activeNodes.add(node);
  const ownLossStart = context.report.losses.length;
  const props = isRecord(node.props) ? node.props as SceneNodeProps : {};
  const webElement = readWebElement(props);
  const capability = readCapability(webElement?.capability);
  const tag = resolveTag(node, webElement, context.report);
  const style = resolvedNodeStyle(node, props, webElement, context);
  const attributes = serializedAttributes(node, props, webElement, style, capability, context);
  const text = typeof props.text === 'string' ? props.text : '';
  const opaqueFallback = rasterFallback(capability, depth + 1, context.format);

  if (node.kind === 'Component' && capability?.editability !== 'opaque') {
    addLoss(context.report, node.id, 'kind', 'mounted-component', 'Mounted component behavior cannot be represented as static HTML/JSX.');
  }
  if (hasPseudoElements(webElement?.pseudo_elements)) {
    addLoss(context.report, node.id, 'props.custom.web_element.pseudo_elements', 'pseudo-elements', 'Pseudo-elements require stylesheet rules and are not emitted inline.');
    context.report.sawPseudo = true;
  }
  if (webElement?.geometry != null) {
    addLoss(context.report, node.id, 'props.custom.web_element.geometry', 'unrealized-geometry', 'Producer geometry outside canonical snapshot frames is preserved only as scene DATA.');
    context.report.sawUnsupportedGeometry = true;
  }
  if (webElement?.resources != null) {
    addLoss(context.report, node.id, 'props.custom.web_element.resources', 'resources-not-realized', 'Resource observations are preserved as DATA but are not fetched or embedded by static serialization.');
  }
  if (props.handlers != null) {
    addLoss(context.report, node.id, 'props.handlers', 'behavior-not-serialized', 'Rust-owned event handlers remain DATA and are not executable in static serialization.');
  }
  for (const field of ['bindings', 'bind', 'fsm', 'triggers', 'value'] as const) {
    if (node[field] == null || (Array.isArray(node[field]) && node[field]?.length === 0)) continue;
    addLoss(context.report, node.id, field, 'behavior-not-serialized', `Scene behavior field "${field}" remains DATA and is not executable in static ${context.format.toUpperCase()}.`);
  }

  const unknownProps = unknownSceneProps(props, webElement);
  if (Object.keys(unknownProps).length > 0) {
    addLoss(context.report, node.id, 'props.custom', 'unrealized-props', 'Unknown custom DATA is preserved in data-scene-props but its behavior is not inferred.');
  }

  if (capability?.editability === 'opaque') {
    addLoss(context.report, node.id, 'props.custom.web_element.capability', 'opaque-subtree', 'The source declared this subtree opaque; raster fallback does not make its internals editable.');
  }

  const ownLosses = context.report.losses.slice(ownLossStart).filter((loss) => loss.node_id === node.id);
  const reasons = unique([
    ...(capability?.limitations ?? []).filter((value): value is string => typeof value === 'string' && value.length > 0),
    ...ownLosses.map((loss) => loss.code),
  ]);
  const status: SceneSerializationCapability = capability?.editability === 'opaque' || node.kind === 'Component'
    ? 'opaque'
    : capability?.editability === 'partial' || ownLosses.length > 0 ? 'partial' : 'editable';
  context.report.nodes.push({ node_id: node.id, capability: status, reasons });

  const indent = '  '.repeat(depth);
  const childParts = (node.children ?? []).map((child) => serializeNode(child, depth + 1, context));
  context.activeNodes.delete(node);
  if (opaqueFallback) childParts.unshift(opaqueFallback);
  if (text) childParts.unshift(`${'  '.repeat(depth + 1)}${serializeText(text, context)}`);

  const open = `${indent}<${tag}${attributes}>`;
  const close = `</${tag}>`;
  if (childParts.length === 0) return `${open}${close}`;
  return `${open}\n${childParts.join('\n')}\n${indent}${close}`;
}

function resolveTag(node: SceneNode, webElement: SceneWebElement | null, report: MutableReport): string {
  const requested = typeof webElement?.tag_name === 'string' ? webElement.tag_name.trim().toLowerCase() : '';
  if (webElement?.namespace_uri && webElement.namespace_uri !== 'http://www.w3.org/1999/xhtml') {
    report.sawNamespace = true;
    addLoss(report, node.id, 'props.custom.web_element.namespace_uri', 'namespace-not-realized', `Namespace "${webElement.namespace_uri}" is recorded but static serialization does not recreate namespace APIs.`);
  }
  if (requested) {
    if (!/^[a-z][a-z0-9-]*$/.test(requested) || ACTIVE_TAGS.has(requested)) {
      report.sawUnsupportedTag = true;
      addLoss(report, node.id, 'props.custom.web_element.tag_name', 'unsupported-tag', `Tag "${requested}" was replaced with a passive div.`);
      return 'div';
    }
    return requested;
  }
  if (node.kind === 'Text') return 'span';
  if (node.kind === 'Container' || node.kind === 'Canvas' || node.kind === 'Component') return 'div';
  report.sawUnsupportedTag = true;
  addLoss(report, node.id, 'kind', 'unknown-node-kind', `Node kind "${node.kind}" has no tag_name and was represented as a div.`);
  return 'div';
}

function resolvedNodeStyle(
  node: SceneNode,
  props: SceneNodeProps,
  webElement: SceneWebElement | null,
  context: SerializationContext,
): Record<string, unknown> {
  const authored = {
    ...(isRecord(webElement?.computed_css) ? webElement.computed_css : {}),
    ...(isRecord(node.style) ? node.style : {}),
    ...(isRecord(props.style) ? props.style : {}),
  };
  const realized = realizeSerializableSceneStyle(authored);
  for (const key of realized.unsupportedKeys) {
    context.report.sawUnsupportedStyle = true;
    addLoss(context.report, node.id, `props.custom.web_element.computed_css.${key}`, 'unsupported-style-value', `Style "${key}" is structured DATA and cannot be emitted as inline CSS.`);
  }
  const css = { ...realized.css } as Record<string, unknown>;
  if (node.z_index != null) css.zIndex = node.z_index;
  if (node.visible === false) css.display = 'none';

  if (context.frames) {
    const frame = context.frames[node.id];
    if (!frame) {
      context.report.missingFrameCount += 1;
    } else {
      context.report.frameCount += 1;
      css.position = 'absolute';
      css.left = frame.rect.x;
      css.top = frame.rect.y;
      css.width = frame.rect.w;
      css.height = frame.rect.h;
      if (frame.computed_clip != null) {
        context.report.sawUnsupportedGeometry = true;
        addLoss(context.report, node.id, 'frames.computed_clip', 'computed-clip', 'Computed clip geometry is not losslessly expressible as one inline CSS property.');
      }
    }
  }
  return css;
}

function realizeSerializableSceneStyle(style: Record<string, unknown>): { css: Record<string, unknown>; unsupportedKeys: string[] } {
  const css: Record<string, unknown> = {}; const unsupportedKeys: string[] = [];
  for (const key of Object.keys(style).sort()) {
    if (EXPLICIT_STYLE_KEYS.has(key)) continue;
    const value = style[key];
    if (typeof value === 'string' && value.trim() || typeof value === 'number' && Number.isFinite(value)) css[cssPropertyName(key)] = value;
    else if (value != null) unsupportedKeys.push(key);
  }
  const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
  const numberOrText = (value: unknown): string | number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : text(value);
  const assign = (key: string, value: unknown) => { if (value !== undefined) css[key] = value; };
  assign('color', text(style.color)); assign('background', text(style.highlight) ?? text(style.background)); assign('borderColor', text(style.border_color)); assign('borderWidth', numberOrText(style.border_width)); assign('borderRadius', numberOrText(style.border_radius)); assign('fontFamily', text(style.font_family)); assign('fontSize', numberOrText(style.font_size)); assign('fontWeight', numberOrText(style.font_weight)); assign('fontStyle', text(style.font_style)); assign('lineHeight', numberOrText(style.line_height)); assign('textAlign', text(style.text_align)); assign('textDecorationLine', text(style.text_decoration_line) ?? text(style.text_decoration));
  if (isRecord(style.padding)) { assign('paddingTop', numberOrText(style.padding.top)); assign('paddingRight', numberOrText(style.padding.right)); assign('paddingBottom', numberOrText(style.padding.bottom)); assign('paddingLeft', numberOrText(style.padding.left)); }
  return { css, unsupportedKeys };
}

function cssPropertyName(key: string): string { return key.startsWith('--') || !key.includes('-') ? key : key.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()); }

function serializedAttributes(
  node: SceneNode,
  props: SceneNodeProps,
  webElement: SceneWebElement | null,
  style: Record<string, unknown>,
  capability: SceneNodeCapability | null,
  context: SerializationContext,
): string {
  const regular: Array<[string, string | number | boolean]> = [['data-node-id', node.id]];
  const carriedAttributes: Record<string, unknown> = {};
  const supplied = isRecord(webElement?.attributes) ? webElement.attributes : {};

  for (const name of Object.keys(supplied).sort()) {
    const value = supplied[name];
    if (name === 'style' || name === 'data-node-id' || /^on/i.test(name) || !validAttributeName(name, context.format)) {
      carriedAttributes[name] = value;
      context.report.sawUnsupportedAttribute = true;
      addLoss(context.report, node.id, `props.custom.web_element.attributes.${name}`, 'unsupported-attribute', `Attribute "${name}" is preserved as inert DATA rather than emitted as active markup.`);
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      regular.push([context.format === 'jsx' ? jsxAttributeName(name) : name, value]);
    } else if (value != null) {
      carriedAttributes[name] = value;
      context.report.sawUnsupportedAttribute = true;
      addLoss(context.report, node.id, `props.custom.web_element.attributes.${name}`, 'non-scalar-attribute', `Attribute "${name}" is non-scalar and remains inert scene DATA.`);
    }
  }

  if (capability) regular.push(['data-scene-capability', capability.editability]);
  if (capability?.raster_fallback_ref) regular.push(['data-raster-fallback-ref', capability.raster_fallback_ref]);
  const unknown = unknownSceneProps(props, webElement);
  if (Object.keys(unknown).length > 0) regular.push(['data-scene-props', stableJson(unknown)]);
  if (hasPseudoElements(webElement?.pseudo_elements)) regular.push(['data-scene-pseudo-elements', stableJson(webElement?.pseudo_elements)]);
  if (webElement?.geometry != null) regular.push(['data-scene-geometry', stableJson(webElement.geometry)]);
  if (webElement?.resources != null) regular.push(['data-scene-resources', stableJson(webElement.resources)]);
  if (Object.keys(carriedAttributes).length > 0) regular.push(['data-scene-attributes', stableJson(carriedAttributes)]);
  const serialized = regular.map(([name, value]) => context.format === 'html'
    ? htmlAttribute(name, value)
    : jsxAttribute(name, value)).join('');
  if (Object.keys(style).length === 0) return serialized;
  return context.format === 'html'
    ? `${serialized}${htmlAttribute('style', cssText(style))}`
    : `${serialized} style={${stableJson(style)}}`;
}

function rasterFallback(
  capability: SceneNodeCapability | null,
  depth: number,
  format: SceneSerializationFormat,
): string | null {
  if (capability?.editability !== 'opaque' || !capability.raster_fallback_src) return null;
  const indent = '  '.repeat(depth);
  if (format === 'html') {
    return `${indent}<img data-scene-raster-fallback="true" src="${escapeHtmlAttribute(capability.raster_fallback_src)}" alt="">`;
  }
  return `${indent}<img data-scene-raster-fallback={true} src={${JSON.stringify(capability.raster_fallback_src)}} alt="" />`;
}

function readCapability(value: unknown): SceneNodeCapability | null {
  if (!isRecord(value)
    || (value.editability !== 'editable' && value.editability !== 'partial' && value.editability !== 'opaque')) return null;
  return {
    ...value,
    editability: value.editability,
    ...(typeof value.raster_fallback_ref === 'string' ? { raster_fallback_ref: value.raster_fallback_ref } : {}),
    ...(typeof value.raster_fallback_src === 'string' ? { raster_fallback_src: value.raster_fallback_src } : {}),
    ...(Array.isArray(value.limitations)
      ? { limitations: value.limitations.filter((item): item is string => typeof item === 'string') }
      : {}),
  };
}

function normalizeLimits(limits: Partial<SceneSerializationLimits> | undefined): SceneSerializationLimits {
  return {
    max_depth: finiteInteger(limits?.max_depth, DEFAULT_LIMITS.max_depth, 0),
    max_nodes: finiteInteger(limits?.max_nodes, DEFAULT_LIMITS.max_nodes, 1),
    max_output_bytes: finiteInteger(limits?.max_output_bytes, DEFAULT_LIMITS.max_output_bytes, 128),
  };
}

function finiteInteger(value: unknown, fallback: number, minimum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.floor(value))
    : fallback;
}

function stopAtLimit(
  report: MutableReport,
  nodeId: string | null,
  code: Exclude<SceneSerializationReport['stopped_by'], null>,
  detail: string,
): void {
  if (report.stoppedBy === null) report.stoppedBy = code;
  if (!report.losses.some((loss) => loss.code === code)) addLoss(report, nodeId, 'limits', code, detail);
}

function limitPlaceholder(format: SceneSerializationFormat, code: string): string {
  return format === 'html' ? `<!-- scene serialization omitted: ${code} -->` : `{/* scene serialization omitted: ${code} */}`;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function readWebElement(props: SceneNodeProps): SceneWebElement | null {
  if (!isRecord(props.custom) || !isRecord(props.custom.web_element)) return null;
  return props.custom.web_element as SceneWebElement;
}

function unknownSceneProps(props: SceneNodeProps, webElement: SceneWebElement | null): Record<string, unknown> {
  const topLevel = Object.fromEntries(Object.keys(props as Record<string, unknown>)
    .filter((key) => !RUST_NODE_PROPS.has(key))
    .sort()
    .map((key) => [key, (props as Record<string, unknown>)[key]]));
  const custom = isRecord(props.custom) ? props.custom : {};
  const customRest = Object.fromEntries(Object.keys(custom)
    .filter((key) => key !== 'web_element')
    .sort()
    .map((key) => [key, custom[key]]));
  const webRest = webElement ? Object.fromEntries(Object.keys(webElement)
    .filter((key) => !WEB_ELEMENT_FIELDS.has(key))
    .sort()
    .map((key) => [key, webElement[key]])) : {};
  return {
    ...topLevel,
    ...(Object.keys(customRest).length > 0 ? { custom: customRest } : {}),
    ...(Object.keys(webRest).length > 0 ? { web_element: webRest } : {}),
  };
}

function featureCapabilities(report: MutableReport): SceneSerializationFeatureCapability[] {
  const geometrySupport = !report.suppliedFrames ? 'unavailable'
    : report.missingFrameCount > 0 || report.sawUnsupportedGeometry ? 'partial'
      : 'supported';
  return [
    {
      feature: 'styles',
      support: report.sawUnsupportedStyle ? 'partial' : 'supported',
      detail: 'Scalar inline CSS is realized; structured layout/style DATA is reported.',
    },
    {
      feature: 'tags',
      support: report.sawUnsupportedTag ? 'partial' : 'supported',
      detail: 'Valid tag names are emitted except for the excluded tag set; this does not certify custom elements as inert.',
    },
    {
      feature: 'namespaces',
      support: report.sawNamespace ? 'unsupported' : 'supported',
      detail: 'HTML markup is emitted; namespace APIs are not recreated.',
    },
    {
      feature: 'attributes',
      support: report.sawUnsupportedAttribute ? 'partial' : 'supported',
      detail: 'Scalar attributes are emitted except for event handlers and invalid names. URL and resource semantics are preserved, not sanitized.',
    },
    {
      feature: 'pseudo-elements',
      support: 'unsupported',
      detail: report.sawPseudo
        ? 'Observed pseudo-element DATA is preserved but requires stylesheet rules.'
        : 'No pseudo-element stylesheet rules are generated by this serializer.',
    },
    {
      feature: 'geometry',
      support: geometrySupport,
      detail: report.suppliedFrames
        ? `Serialized ${report.frameCount} frame rectangles; ${report.missingFrameCount} nodes had no frame. Camera and computed clips are reported separately.`
        : 'No canonical snapshot frames were supplied; no geometry fidelity is claimed.',
    },
  ];
}

function cssText(style: Record<string, unknown>): string {
  return Object.keys(style).sort().map((key) => {
    const value = style[key];
    const cssName = key.startsWith('--') ? key : key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const cssValue = typeof value === 'number' && value !== 0 && !UNITLESS_CSS.has(key) ? `${value}px` : String(value);
    return `${cssName}:${cssValue}`;
  }).join(';');
}

function htmlAttribute(name: string, value: string | number | boolean): string {
  if (value === true) return ` ${name}`;
  if (value === false) return '';
  return ` ${name}="${escapeHtmlAttribute(String(value))}"`;
}

function jsxAttribute(name: string, value: string | number | boolean): string {
  if (typeof value === 'boolean' || typeof value === 'number') return ` ${name}={${String(value)}}`;
  return ` ${name}={${JSON.stringify(value)}}`;
}

function serializeText(value: string, context: SerializationContext): string {
  return serializeInlineText(value, context.format, context.inlineMarks);
}

/** Render the shared inline token/mark model as safe semantic HTML. Mark tags and
 * styles come only from the caller's current DATA rows. */
export function serializeInlineTextToHtml(value: string, marks: readonly InlineMark[] = []): string {
  return serializeInlineText(value, 'html', marks);
}

export function serializeInlineTextToJsx(value: string, marks: readonly InlineMark[] = []): string {
  return serializeInlineText(value, 'jsx', marks);
}

function serializeInlineText(value: string, format: SceneSerializationFormat, marks: readonly InlineMark[]): string {
  return parseEmphasisRuns(value, marks).map(run => {
    const label = run.type === 'ref' ? `@${run.label}` : run.text;
    let content = format === 'html' ? escapeHtmlText(label) : `{${JSON.stringify(label)}}`;
    const style = sanitizeInlineStyle(run.style);
    const css = realizeSerializableSceneStyle(style).css;
    const decorations = [style.text_underline === true ? 'underline' : '', style.text_strike === true ? 'line-through' : ''].filter(Boolean);
    if (decorations.length) css.textDecorationLine = decorations.join(' ');
    if (Object.keys(css).length) content = format === 'html'
      ? '<span style="' + escapeHtmlAttribute(cssText(css)) + '">' + content + '</span>'
      : `<span style={${JSON.stringify(css)}}>${content}</span>`;
    const href = safeInlineLinkUrl(run.link);
    if (href) content = format === 'html'
      ? `<a href="${escapeHtmlAttribute(href)}" target="_blank" rel="noopener noreferrer">${content}</a>`
      : `<a href={${JSON.stringify(href)}} target="_blank" rel="noopener noreferrer">${content}</a>`;
    for (const id of [...(run.marks ?? [])].reverse()) {
      const mark = marks.find(row => row.id === id);
      if (mark && /^[A-Za-z][A-Za-z0-9-]*$/.test(mark.render_tag) && !ACTIVE_TAGS.has(mark.render_tag.toLowerCase())) content = `<${mark.render_tag}>${content}</${mark.render_tag}>`;
    }
    return content;
  }).join('');
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function validAttributeName(name: string, format: SceneSerializationFormat): boolean {
  if (format === 'html') return /^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(name);
  return name === 'class' || name === 'for' || /^(data|aria)-[A-Za-z0-9_.:-]+$/.test(name)
    || /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function jsxAttributeName(name: string): string {
  if (name === 'class') return 'className';
  if (name === 'for') return 'htmlFor';
  return name;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value, new WeakSet<object>()));
}

function normalizeJson(value: unknown, seen: WeakSet<object>): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return null;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, seen));
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalizeJson(record[key], seen)]));
}

function hasPseudoElements(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) && Object.keys(value).length > 0;
}

function addLoss(report: MutableReport, nodeId: string | null, path: string, code: string, detail: string): void {
  report.losses.push({ node_id: nodeId, path, code, detail });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isSceneNode(value: unknown): value is SceneNode {
  return isRecord(value) && typeof value.id === 'string' && typeof value.kind === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
