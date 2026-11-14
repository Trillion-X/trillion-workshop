const CAPTURE_REQUEST_SCHEMA = 'browsing-surface-provider.spatial-source-capture.request';
const CAPTURE_RESPONSE_SCHEMA = 'browsing-surface-provider.spatial-source-capture.response';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requirePolicy(value) {
  if (!isRecord(value) || !Array.isArray(value.default_computed_styles)) {
    throw new TypeError('spatialCapturePolicy with default_computed_styles is required');
  }
  const numericKeys = [
    'maximum_computed_styles', 'maximum_selector_bytes', 'maximum_surface_key_bytes',
    'backend_node_id_minimum', 'backend_node_id_maximum',
    'matched_style_nodes_minimum', 'default_matched_style_nodes', 'maximum_matched_style_nodes',
    'resources_minimum', 'default_resources', 'maximum_resources',
    'resource_bytes_minimum', 'default_resource_bytes', 'maximum_resource_bytes',
  ];
  for (const key of numericKeys) {
    if (!Number.isSafeInteger(value[key])) throw new TypeError(`spatialCapturePolicy.${key} must be an exact integer`);
  }
  return value;
}

function exactInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an exact integer from ${min} through ${max}`);
  }
  return value;
}

function boundedText(value, label, maxBytes) {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new TypeError(`${label} must be non-empty bounded text`);
  }
  return value;
}

function styleProperty(value) {
  if (typeof value !== 'string' || !/^(?:--[A-Za-z0-9_-]+|[A-Za-z][A-Za-z0-9-]*)$/.test(value)) {
    throw new TypeError('computed_styles entries must be CSS property names');
  }
  return value;
}

const URL_ATTRIBUTE_NAMES = new Set([
  'action', 'background', 'cite', 'data', 'formaction', 'href', 'icon', 'manifest',
  'poster', 'src', 'srcset', 'xlink:href',
]);
const RESOURCE_ATTRIBUTE_NAMES = new Set([
  'background', 'data', 'icon', 'poster', 'src', 'srcset', 'xlink:href',
]);
const FORM_NODE_NAMES = new Set(['BUTTON', 'INPUT', 'OPTION', 'SELECT', 'TEXTAREA']);
const SENSITIVE_NAME = /(?:auth|bearer|cookie|credential|csrf|jwt|pass(?:word)?|private|secret|session|token)/i;
const SCREENSHOT_REDACTION_MARKER = 'data-bitfield-spatial-capture-redaction';

function sanitizeUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (value.startsWith('#')) return value;
  try {
    const parsed = new URL(value, 'https://bitfield.invalid/');
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'javascript:') {
      return `${parsed.protocol}[redacted]`;
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    if (parsed.origin === 'https://bitfield.invalid') return `${parsed.pathname}`;
    return parsed.toString();
  } catch {
    return value.replace(/[?#].*$/s, '');
  }
}

function sanitizeText(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/\b((?:auth|cookie|credential|csrf|jwt|password|private[_-]?key|secret|session|token)\s*[:=]\s*)[^\s;,"']+/gi, '$1[redacted]');
}

function sanitizeCss(value) {
  if (typeof value !== 'string') return value;
  return sanitizeText(value).replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (_all, quote, url) => `url(${quote}${sanitizeUrl(url)}${quote})`);
}

function stringAt(strings, index) {
  return Number.isSafeInteger(index) && typeof strings[index] === 'string' ? strings[index] : '';
}

function rareValueAt(rareData, nodeIndex) {
  if (!isRecord(rareData) || !Array.isArray(rareData.index) || !Array.isArray(rareData.value)) return undefined;
  const position = rareData.index.indexOf(nodeIndex);
  return position === -1 ? undefined : rareData.value[position];
}

function filterRareData(value, retained, nodeIndexMap, transformValue = (item) => item) {
  if (!isRecord(value) || !Array.isArray(value.index)) return value;
  const output = { index: [] };
  const hasValues = Array.isArray(value.value);
  if (hasValues) output.value = [];
  for (let position = 0; position < value.index.length; position += 1) {
    const oldIndex = value.index[position];
    if (!retained.has(oldIndex)) continue;
    output.index.push(nodeIndexMap.get(oldIndex));
    if (hasValues) output.value.push(transformValue(value.value[position]));
  }
  return output;
}

function descendantIndices(documentSnapshot, rootIndex = null) {
  const nodes = isRecord(documentSnapshot && documentSnapshot.nodes) ? documentSnapshot.nodes : {};
  const count = Array.isArray(nodes.backendNodeId) ? nodes.backendNodeId.length : 0;
  if (rootIndex === null) return new Set(Array.from({ length: count }, (_unused, index) => index));
  const retained = new Set([rootIndex]);
  const parents = Array.isArray(nodes.parentIndex) ? nodes.parentIndex : [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < count; index += 1) {
      if (!retained.has(index) && retained.has(parents[index])) {
        retained.add(index);
        changed = true;
      }
    }
  }
  return retained;
}

function selectedSnapshotDocuments(snapshot, selectedBackendNodeId) {
  const documents = snapshot.documents;
  const selectedRoots = new Map();
  if (selectedBackendNodeId === null) {
    for (let index = 0; index < documents.length; index += 1) selectedRoots.set(index, null);
  } else {
    for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
      const ids = documents[documentIndex] && documents[documentIndex].nodes && documents[documentIndex].nodes.backendNodeId;
      const nodeIndex = Array.isArray(ids) ? ids.indexOf(selectedBackendNodeId) : -1;
      if (nodeIndex !== -1) {
        selectedRoots.set(documentIndex, nodeIndex);
        break;
      }
    }
    if (selectedRoots.size === 0) throw new Error('selected backend node was absent from the captured snapshot');
  }

  // An iframe in the selected subtree makes its content document reachable. Include
  // that document and repeat so nested frames remain attached, but no sibling frame
  // document can enter the persisted evidence.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [documentIndex, rootIndex] of [...selectedRoots]) {
      const documentSnapshot = documents[documentIndex];
      const retained = descendantIndices(documentSnapshot, rootIndex);
      const contentDocuments = documentSnapshot && documentSnapshot.nodes && documentSnapshot.nodes.contentDocumentIndex;
      for (const nodeIndex of retained) {
        const childDocumentIndex = rareValueAt(contentDocuments, nodeIndex);
        if (Number.isSafeInteger(childDocumentIndex) && !selectedRoots.has(childDocumentIndex)) {
          selectedRoots.set(childDocumentIndex, null);
          changed = true;
        }
      }
    }
  }
  return selectedRoots;
}

const NODE_PARALLEL_ARRAYS = new Set([
  'parentIndex', 'nodeType', 'nodeName', 'nodeValue', 'backendNodeId', 'attributes',
]);
const NODE_RARE_FIELDS = new Set([
  'shadowRootType', 'textValue', 'inputValue', 'inputChecked', 'optionSelected',
  'contentDocumentIndex', 'pseudoType', 'pseudoIdentifier', 'isClickable',
  'currentSourceURL', 'originURL',
]);

function filterDocumentSnapshot(documentSnapshot, retained, documentIndexMap) {
  const nodes = isRecord(documentSnapshot.nodes) ? documentSnapshot.nodes : {};
  const retainedList = [...retained].sort((left, right) => left - right);
  const nodeIndexMap = new Map(retainedList.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  const filteredNodes = {};
  for (const [key, value] of Object.entries(nodes)) {
    if (NODE_PARALLEL_ARRAYS.has(key) && Array.isArray(value)) {
      filteredNodes[key] = retainedList.map((oldIndex) => {
        const item = value[oldIndex];
        if (key !== 'parentIndex') return item;
        return nodeIndexMap.has(item) ? nodeIndexMap.get(item) : -1;
      });
    } else if (NODE_RARE_FIELDS.has(key)) {
      filteredNodes[key] = filterRareData(
        value,
        retained,
        nodeIndexMap,
        key === 'contentDocumentIndex' ? (item) => documentIndexMap.get(item) : undefined,
      );
    }
  }

  const layout = isRecord(documentSnapshot.layout) ? documentSnapshot.layout : {};
  const retainedLayoutPositions = [];
  const layoutIndexMap = new Map();
  for (let position = 0; position < (layout.nodeIndex || []).length; position += 1) {
    if (!retained.has(layout.nodeIndex[position])) continue;
    layoutIndexMap.set(position, retainedLayoutPositions.length);
    retainedLayoutPositions.push(position);
  }
  const filteredLayout = {};
  for (const [key, value] of Object.entries(layout)) {
    if (key === 'stackingContexts') {
      const retainedLayout = new Set(retainedLayoutPositions);
      filteredLayout[key] = filterRareData(value, retainedLayout, layoutIndexMap);
    } else if (Array.isArray(value)) {
      filteredLayout[key] = retainedLayoutPositions.map((position) => (
        key === 'nodeIndex' ? nodeIndexMap.get(value[position]) : value[position]
      ));
    }
  }

  const textBoxes = isRecord(documentSnapshot.textBoxes) ? documentSnapshot.textBoxes : {};
  const retainedTextBoxes = [];
  for (let position = 0; position < (textBoxes.layoutIndex || []).length; position += 1) {
    if (layoutIndexMap.has(textBoxes.layoutIndex[position])) retainedTextBoxes.push(position);
  }
  const filteredTextBoxes = {};
  for (const [key, value] of Object.entries(textBoxes)) {
    if (!Array.isArray(value)) continue;
    filteredTextBoxes[key] = retainedTextBoxes.map((position) => (
      key === 'layoutIndex' ? layoutIndexMap.get(value[position]) : value[position]
    ));
  }
  return { ...documentSnapshot, nodes: filteredNodes, layout: filteredLayout, textBoxes: filteredTextBoxes };
}

function filterSnapshotToSelection(snapshot, selectedBackendNodeId) {
  const selectedRoots = selectedSnapshotDocuments(snapshot, selectedBackendNodeId);
  const selectedDocumentIndices = [...selectedRoots.keys()];
  const documentIndexMap = new Map(selectedDocumentIndices.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  const documents = selectedDocumentIndices.map((oldIndex) => filterDocumentSnapshot(
    snapshot.documents[oldIndex],
    descendantIndices(snapshot.documents[oldIndex], selectedRoots.get(oldIndex)),
    documentIndexMap,
  ));
  if (selectedBackendNodeId !== null) for (const document of documents) delete document.title;
  return {
    strings: snapshot.strings,
    documents,
  };
}

function redactAndCompactSnapshot(snapshot) {
  const oldStrings = snapshot.strings;
  const strings = [];
  const stringMap = new Map();
  const remap = (index, kind = 'text') => {
    const key = `${kind}:${index}`;
    if (stringMap.has(key)) return stringMap.get(key);
    const original = stringAt(oldStrings, index);
    const next = kind === 'url' ? sanitizeUrl(original)
      : kind === 'secret' ? '[redacted]'
        : kind === 'css' ? sanitizeCss(original)
          : sanitizeText(original);
    const mapped = strings.length;
    strings.push(next);
    stringMap.set(key, mapped);
    return mapped;
  };

  const documents = snapshot.documents.map((documentSnapshot) => {
    const document = { ...documentSnapshot };
    for (const key of ['documentURL', 'baseURL']) if (Number.isSafeInteger(document[key])) document[key] = remap(document[key], 'url');
    for (const key of ['title', 'contentLanguage', 'encodingName', 'publicId', 'systemId', 'frameId']) {
      if (Number.isSafeInteger(document[key])) document[key] = remap(document[key]);
    }
    const nodes = { ...document.nodes };
    const nodeNames = (nodes.nodeName || []).map((index) => stringAt(oldStrings, index).toUpperCase());
    const sensitiveNodes = new Set();
    for (let index = 0; index < nodeNames.length; index += 1) {
      const attributes = Array.isArray(nodes.attributes && nodes.attributes[index]) ? nodes.attributes[index] : [];
      if (FORM_NODE_NAMES.has(nodeNames[index])) sensitiveNodes.add(index);
      for (let offset = 0; offset < attributes.length; offset += 2) {
        const name = stringAt(oldStrings, attributes[offset]);
        const value = stringAt(oldStrings, attributes[offset + 1]);
        if (SENSITIVE_NAME.test(name) || (name.toLowerCase() === 'type' && value.toLowerCase() === 'password')) sensitiveNodes.add(index);
      }
    }
    const parents = nodes.parentIndex || [];
    for (let index = 0; index < nodeNames.length; index += 1) {
      if (sensitiveNodes.has(parents[index])) sensitiveNodes.add(index);
    }
    nodes.nodeName = (nodes.nodeName || []).map((index) => remap(index));
    nodes.nodeValue = (nodes.nodeValue || []).map((index, nodeIndex) => remap(index, sensitiveNodes.has(nodeIndex) ? 'secret' : 'text'));
    nodes.attributes = (nodes.attributes || []).map((attributes, nodeIndex) => {
      if (!Array.isArray(attributes)) return [];
      const output = [];
      for (let offset = 0; offset < attributes.length; offset += 2) {
        const nameIndex = attributes[offset];
        const valueIndex = attributes[offset + 1];
        const name = stringAt(oldStrings, nameIndex).toLowerCase();
        const isFormValue = FORM_NODE_NAMES.has(nodeNames[nodeIndex]) && name === 'value';
        const kind = name === 'srcdoc' || isFormValue || SENSITIVE_NAME.test(name)
          ? 'secret'
          : URL_ATTRIBUTE_NAMES.has(name) ? 'url'
            : name === 'style' ? 'css' : 'text';
        output.push(remap(nameIndex), remap(valueIndex, kind));
      }
      return output;
    });
    for (const key of ['shadowRootType', 'textValue', 'pseudoType', 'pseudoIdentifier']) {
      if (isRecord(nodes[key]) && Array.isArray(nodes[key].value)) {
        nodes[key] = { ...nodes[key], value: nodes[key].value.map((index) => remap(index)) };
      }
    }
    if (isRecord(nodes.inputValue) && Array.isArray(nodes.inputValue.value)) {
      nodes.inputValue = { ...nodes.inputValue, value: nodes.inputValue.value.map((index) => remap(index, 'secret')) };
    }
    for (const key of ['currentSourceURL', 'originURL']) {
      if (isRecord(nodes[key]) && Array.isArray(nodes[key].value)) {
        nodes[key] = { ...nodes[key], value: nodes[key].value.map((index) => remap(index, 'url')) };
      }
    }
    const layout = { ...document.layout };
    layout.styles = (layout.styles || []).map((style) => Array.isArray(style) ? style.map((index) => remap(index, 'css')) : []);
    layout.text = (layout.text || []).map((index) => remap(index));
    layout.blendedBackgroundColors = (layout.blendedBackgroundColors || []).map((index) => remap(index, 'css'));
    return { ...document, nodes, layout };
  });
  return { strings, documents };
}

function urlsFromCss(value, output) {
  if (typeof value !== 'string') return;
  for (const match of value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) output.push(match[1]);
}

function collectReachableResourceUrls(snapshot) {
  const strings = snapshot.strings;
  const output = [];
  for (const documentSnapshot of snapshot.documents) {
    const base = stringAt(strings, documentSnapshot.baseURL) || stringAt(strings, documentSnapshot.documentURL);
    const documentOutput = [];
    const nodes = documentSnapshot.nodes || {};
    const names = (nodes.nodeName || []).map((index) => stringAt(strings, index).toUpperCase());
    for (let nodeIndex = 0; nodeIndex < (nodes.attributes || []).length; nodeIndex += 1) {
      const attributes = nodes.attributes[nodeIndex];
      if (!Array.isArray(attributes)) continue;
      let rel = '';
      for (let offset = 0; offset < attributes.length; offset += 2) {
        if (stringAt(strings, attributes[offset]).toLowerCase() === 'rel') rel = stringAt(strings, attributes[offset + 1]).toLowerCase();
      }
      for (let offset = 0; offset < attributes.length; offset += 2) {
        const name = stringAt(strings, attributes[offset]).toLowerCase();
        const value = stringAt(strings, attributes[offset + 1]);
        const linkResource = name === 'href' && names[nodeIndex] === 'LINK' && /(?:stylesheet|icon|preload|modulepreload)/.test(rel);
        if (!RESOURCE_ATTRIBUTE_NAMES.has(name) && !linkResource) {
          if (name === 'style') urlsFromCss(value, documentOutput);
          continue;
        }
        if (name === 'srcset') {
          for (const candidate of value.split(',')) documentOutput.push(candidate.trim().split(/\s+/)[0]);
        } else documentOutput.push(value);
      }
    }
    const currentSources = nodes.currentSourceURL;
    if (isRecord(currentSources) && Array.isArray(currentSources.value)) {
      for (const index of currentSources.value) documentOutput.push(stringAt(strings, index));
    }
    for (const style of (documentSnapshot.layout && documentSnapshot.layout.styles) || []) {
      if (Array.isArray(style)) for (const index of style) urlsFromCss(stringAt(strings, index), documentOutput);
    }
    for (const value of documentOutput) {
      try { output.push(new URL(value, base || undefined).href); } catch { /* unreachable malformed URL */ }
    }
  }
  return new Set(output.filter((value) => typeof value === 'string' && value.length > 0));
}

function redactStructured(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, key));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactStructured(child, childKey)]));
  if (typeof value !== 'string') return value;
  if (SENSITIVE_NAME.test(key)) return '[redacted]';
  if (/url|source/i.test(key)) return sanitizeUrl(value);
  return sanitizeCss(value);
}

export function normalizeCaptureRequest(value, policyValue) {
  const policy = requirePolicy(policyValue);
  if (!isRecord(value) || value.schema !== CAPTURE_REQUEST_SCHEMA) {
    throw new TypeError(`capture request schema must be ${CAPTURE_REQUEST_SCHEMA}`);
  }
  const computedStyles = value.computed_styles === undefined
    ? [...policy.default_computed_styles]
    : value.computed_styles;
  if (!Array.isArray(computedStyles) || computedStyles.length > policy.maximum_computed_styles) {
    throw new TypeError(`computed_styles must be an array of at most ${policy.maximum_computed_styles} names`);
  }
  const selector = value.selector === undefined ? null : boundedText(value.selector, 'selector', policy.maximum_selector_bytes);
  const backendNodeId = value.backend_node_id === undefined
    ? null
    : exactInteger(value.backend_node_id, 'backend_node_id', policy.backend_node_id_minimum, policy.backend_node_id_maximum);
  if (selector !== null && backendNodeId !== null) throw new TypeError('selector and backend_node_id are mutually exclusive');
  return Object.freeze({
    schema: CAPTURE_REQUEST_SCHEMA,
    surface_key: value.surface_key === undefined ? null : boundedText(value.surface_key, 'surface_key', policy.maximum_surface_key_bytes),
    selector,
    backend_node_id: backendNodeId,
    computed_styles: Object.freeze([...new Set(computedStyles.map(styleProperty))]),
    max_matched_style_nodes: exactInteger(value.max_matched_style_nodes ?? policy.default_matched_style_nodes, 'max_matched_style_nodes', policy.matched_style_nodes_minimum, policy.maximum_matched_style_nodes),
    max_resources: exactInteger(value.max_resources ?? policy.default_resources, 'max_resources', policy.resources_minimum, policy.maximum_resources),
    max_resource_bytes: exactInteger(value.max_resource_bytes ?? policy.default_resource_bytes, 'max_resource_bytes', policy.resource_bytes_minimum, policy.maximum_resource_bytes),
  });
}

function flattenResourceTree(frameTree, output = []) {
  if (!isRecord(frameTree)) return output;
  const frameId = isRecord(frameTree.frame) && typeof frameTree.frame.id === 'string' ? frameTree.frame.id : null;
  if (frameId && Array.isArray(frameTree.resources)) {
    for (const resource of frameTree.resources) {
      if (isRecord(resource) && typeof resource.url === 'string') output.push({ frameId, resource });
    }
  }
  if (Array.isArray(frameTree.childFrames)) {
    for (const child of frameTree.childFrames) flattenResourceTree(child, output);
  }
  return output;
}

function decodedByteLength(content, base64Encoded) {
  if (typeof content !== 'string') return 0;
  if (!base64Encoded) return new TextEncoder().encode(content).byteLength;
  const clean = content.replace(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : (clean.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function resourceContentKind(resource) {
  const mime = typeof resource.mimeType === 'string' ? resource.mimeType.toLowerCase().split(';')[0].trim() : '';
  if (mime === 'text/css') return 'css';
  if (/^image\/(?:avif|gif|jpeg|png|webp)$/.test(mime)) return 'image';
  if (/^(?:font\/|application\/(?:font-woff|font-woff2|vnd\.ms-fontobject|x-font-ttf))/.test(mime)) return 'binary';
  return null;
}

async function acquireResources(cdp, sessionId, maximumCount, maximumBytes, reachableUrls) {
  if (maximumCount === 0) return [];
  let tree;
  try { tree = await cdp.send('Page.getResourceTree', {}, sessionId); }
  catch { return [{ status: 'error', error: 'resource-tree-unavailable' }]; }
  const resources = flattenResourceTree(tree && tree.frameTree)
    .filter(({ resource }) => reachableUrls.has(resource.url))
    .slice(0, maximumCount);
  const output = [];
  let usedBytes = 0;
  for (const { frameId, resource } of resources) {
    const item = {
      frame_id: frameId,
      url: sanitizeUrl(resource.url),
      type: typeof resource.type === 'string' ? resource.type : null,
      mime_type: typeof resource.mimeType === 'string' ? resource.mimeType : null,
    };
    const contentKind = resourceContentKind(resource);
    if (contentKind === null) {
      item.status = 'omitted';
      item.reason = 'privacy-unsupported-resource-type';
      output.push(item);
      continue;
    }
    // Reachable images can contain rendered credentials or private user content
    // even when their URL and surrounding DOM are safe. Persist the sanitized
    // reference only; raw pixels require an explicit image-redaction owner.
    if (contentKind === 'image') {
      item.status = 'omitted';
      item.reason = 'privacy-image-redaction-required';
      output.push(item);
      continue;
    }
    try {
      const result = await cdp.send('Page.getResourceContent', { frameId, url: resource.url }, sessionId);
      const base64Encoded = result && result.base64Encoded === true;
      if (contentKind === 'binary' && !base64Encoded) {
        item.status = 'omitted';
        item.reason = 'privacy-invalid-binary-encoding';
        output.push(item);
        continue;
      }
      const content = contentKind === 'css' ? sanitizeCss(result && result.content) : result && result.content;
      const byteLength = decodedByteLength(content, base64Encoded);
      item.byte_length = byteLength;
      if (usedBytes + byteLength > maximumBytes) {
        item.status = 'omitted'; item.reason = 'capture-byte-budget';
      } else {
        usedBytes += byteLength;
        item.status = 'captured';
        item.content = typeof content === 'string' ? content : '';
        item.base64_encoded = base64Encoded;
      }
    } catch { item.status = 'error'; item.error = 'resource-content-unavailable'; }
    output.push(item);
  }
  return output;
}

function backendIdsFromSnapshot(snapshot, preferred, maximum) {
  if (maximum === 0) return [];
  const ids = preferred === null ? [] : [preferred];
  for (const documentSnapshot of snapshot.documents || []) {
    const values = documentSnapshot && documentSnapshot.nodes && documentSnapshot.nodes.backendNodeId;
    if (!Array.isArray(values)) continue;
    for (const value of values) if (Number.isSafeInteger(value) && value > 0) ids.push(value);
  }
  return [...new Set(ids)].slice(0, maximum);
}

async function acquireMatchedStyles(cdp, sessionId, backendNodeIds) {
  if (backendNodeIds.length === 0) return [];
  let frontend;
  try { frontend = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds }, sessionId); }
  catch {
    return backendNodeIds.map((backendNodeId) => ({ backend_node_id: backendNodeId, status: 'error', error: 'backend-node-unavailable' }));
  }
  const nodeIds = Array.isArray(frontend && frontend.nodeIds) ? frontend.nodeIds : [];
  const output = [];
  for (let index = 0; index < backendNodeIds.length; index += 1) {
    const backendNodeId = backendNodeIds[index];
    const nodeId = nodeIds[index];
    if (!Number.isSafeInteger(nodeId) || nodeId <= 0) {
      output.push({ backend_node_id: backendNodeId, status: 'error', error: 'backend node was not available in the target document' });
      continue;
    }
    try {
      const styles = await cdp.send('CSS.getMatchedStylesForNode', { nodeId }, sessionId);
      output.push({ backend_node_id: backendNodeId, status: 'captured', styles: redactStructured(styles) });
    } catch { output.push({ backend_node_id: backendNodeId, status: 'error', error: 'matched-styles-unavailable' }); }
  }
  return output;
}

async function resolveSelectedNode(cdp, sessionId, request) {
  if (request.backend_node_id !== null) {
    const frontend = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [request.backend_node_id] }, sessionId);
    const nodeId = frontend && frontend.nodeIds && frontend.nodeIds[0];
    if (!Number.isSafeInteger(nodeId) || nodeId <= 0) throw new Error('selected backend node was not available in the target document');
    return { backendNodeId: request.backend_node_id, nodeId };
  }
  if (request.selector === null) return { backendNodeId: null, nodeId: null };
  const root = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
  const rootNodeId = root && root.root && root.root.nodeId;
  if (!Number.isSafeInteger(rootNodeId) || rootNodeId <= 0) throw new Error('CDP did not return a document root');
  const selected = await cdp.send('DOM.querySelector', { nodeId: rootNodeId, selector: request.selector }, sessionId);
  if (!selected || !Number.isSafeInteger(selected.nodeId) || selected.nodeId <= 0) throw new Error('selector did not match a DOM node');
  const described = await cdp.send('DOM.describeNode', { nodeId: selected.nodeId }, sessionId);
  const backendNodeId = described && described.node && described.node.backendNodeId;
  if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) throw new Error('selected DOM node did not have a backend identity');
  return { backendNodeId, nodeId: selected.nodeId };
}

async function selectedNodeClip(cdp, sessionId, nodeId) {
  if (nodeId === null) return null;
  const result = await cdp.send('DOM.getBoxModel', { nodeId }, sessionId);
  const quad = result && result.model && result.model.border;
  if (!Array.isArray(quad) || quad.length !== 8 || quad.some((value) => !Number.isFinite(value))) {
    throw new Error('selected DOM node did not have a capturable border box');
  }
  const xValues = [quad[0], quad[2], quad[4], quad[6]];
  const yValues = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xValues);
  const y = Math.min(...yValues);
  const width = Math.max(...xValues) - x;
  const height = Math.max(...yValues) - y;
  if (!(width > 0 && height > 0)) throw new Error('selected DOM node had an empty border box');
  return { x, y, width, height, scale: 1 };
}

const INSTALL_SCREENSHOT_REDACTIONS = `(() => {
  const marker = '${SCREENSHOT_REDACTION_MARKER}';
  const sensitive = /(?:auth|bearer|cookie|credential|csrf|jwt|pass(?:word)?|private|secret|session|token)/i;
  const selectors = 'input,textarea,select,option,[contenteditable=""],[contenteditable="true"],iframe';
  const documents = [document];
  for (let index = 0; index < documents.length; index += 1) {
    const doc = documents[index];
    for (const frame of doc.querySelectorAll('iframe')) {
      try { if (frame.contentDocument) documents.push(frame.contentDocument); }
      catch { frame.setAttribute(marker, 'source'); }
    }
    const nodes = new Set();
    const roots = [doc];
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      const root = roots[rootIndex];
      for (const node of root.querySelectorAll(selectors)) nodes.add(node);
      for (const node of root.querySelectorAll('*')) {
        for (const attribute of node.attributes) if (sensitive.test(attribute.name) || sensitive.test(attribute.value)) nodes.add(node);
        const directText = Array.from(node.childNodes)
          .filter((child) => child.nodeType === Node.TEXT_NODE)
          .map((child) => child.textContent || '')
          .join(' ');
        if (sensitive.test(directText)) nodes.add(node);
        if (node.shadowRoot) roots.push(node.shadowRoot);
        else if (node.localName && node.localName.includes('-')) nodes.add(node);
      }
    }
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const cover = doc.createElement('div');
      cover.setAttribute(marker, 'cover');
      cover.style.cssText = 'position:absolute!important;z-index:2147483647!important;background:#000!important;pointer-events:none!important;';
      cover.style.left = (rect.left + doc.defaultView.scrollX) + 'px';
      cover.style.top = (rect.top + doc.defaultView.scrollY) + 'px';
      cover.style.width = rect.width + 'px';
      cover.style.height = rect.height + 'px';
      doc.documentElement.appendChild(cover);
    }
  }
  return documents.reduce((count, doc) => count + doc.querySelectorAll('[' + marker + '="cover"]').length, 0);
})()`;

const REMOVE_SCREENSHOT_REDACTIONS = `(() => {
  const marker = '${SCREENSHOT_REDACTION_MARKER}';
  const documents = [document];
  for (let index = 0; index < documents.length; index += 1) {
    const doc = documents[index];
    for (const frame of doc.querySelectorAll('iframe')) { try { if (frame.contentDocument) documents.push(frame.contentDocument); } catch {} }
    for (const node of doc.querySelectorAll('[' + marker + ']')) {
      if (node.getAttribute(marker) === 'cover') node.remove(); else node.removeAttribute(marker);
    }
  }
  return true;
})()`;

async function captureRedactedScreenshot(cdp, sessionId, clip) {
  const installed = await cdp.send('Runtime.evaluate', { expression: INSTALL_SCREENSHOT_REDACTIONS, returnByValue: true }, sessionId);
  if (!isRecord(installed) || !isRecord(installed.result) || installed.exceptionDetails) {
    throw new Error('screenshot redaction could not be installed');
  }
  try {
    const params = { format: 'png', fromSurface: true, captureBeyondViewport: clip !== null };
    if (clip !== null) params.clip = clip;
    return await cdp.send('Page.captureScreenshot', params, sessionId);
  } finally {
    const removed = await cdp.send('Runtime.evaluate', { expression: REMOVE_SCREENSHOT_REDACTIONS, returnByValue: true }, sessionId);
    if (!isRecord(removed) || !isRecord(removed.result) || removed.exceptionDetails) {
      throw new Error('screenshot redaction could not be removed');
    }
  }
}

/** Capture against one already-owned SurfacePage CDP session. No browser is launched here. */
export async function captureDomSnapshot(cdp, sessionId, requestValue, policy, context = {}) {
  if (!cdp || typeof cdp.send !== 'function') throw new TypeError('cdp.send is required');
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('an active target session id is required');
  const request = normalizeCaptureRequest(requestValue, policy);
  await cdp.send('DOM.enable', {}, sessionId);
  await cdp.send('CSS.enable', {}, sessionId);
  const selectedNode = await resolveSelectedNode(cdp, sessionId, request);
  const selectedBackendNodeId = selectedNode.backendNodeId;
  const snapshot = await cdp.send('DOMSnapshot.captureSnapshot', {
    computedStyles: request.computed_styles,
    includePaintOrder: true,
    includeDOMRects: true,
    includeBlendedBackgroundColors: true,
    includeTextColorOpacities: true,
  }, sessionId);
  if (!isRecord(snapshot) || !Array.isArray(snapshot.strings) || !Array.isArray(snapshot.documents)) {
    throw new Error('DOMSnapshot.captureSnapshot returned an invalid snapshot');
  }
  const selectedSnapshot = filterSnapshotToSelection(snapshot, selectedBackendNodeId);
  const reachableResourceUrls = collectReachableResourceUrls(selectedSnapshot);
  const redactedSnapshot = redactAndCompactSnapshot(selectedSnapshot);
  const backendNodeIds = backendIdsFromSnapshot(selectedSnapshot, selectedBackendNodeId, request.max_matched_style_nodes);
  const [matchedStyles, resources, clip] = await Promise.all([
    acquireMatchedStyles(cdp, sessionId, backendNodeIds),
    acquireResources(cdp, sessionId, request.max_resources, request.max_resource_bytes, reachableResourceUrls),
    selectedNodeClip(cdp, sessionId, selectedNode.nodeId),
  ]);
  const screenshot = await captureRedactedScreenshot(cdp, sessionId, clip);
  if (!screenshot || typeof screenshot.data !== 'string' || screenshot.data.length === 0) {
    throw new Error('Page.captureScreenshot returned no image');
  }
  return {
    schema: CAPTURE_RESPONSE_SCHEMA,
    captured_at: typeof context.capturedAt === 'string' ? context.capturedAt : new Date().toISOString(),
    source: {
      url: typeof context.url === 'string' ? sanitizeUrl(context.url) : null,
      target_id: typeof context.targetId === 'string' ? context.targetId : null,
      surface_key: request.surface_key,
      selected_backend_node_id: selectedBackendNodeId,
    },
    viewport: {
      width: Number.isFinite(context.cssW) ? context.cssW : null,
      height: Number.isFinite(context.cssH) ? context.cssH : null,
      device_scale_factor: Number.isFinite(context.dpr) ? context.dpr : null,
    },
    computed_style_properties: [...request.computed_styles],
    snapshot: redactedSnapshot,
    matched_styles: matchedStyles,
    resources,
    screenshot: {
      format: 'png',
      data_base64: screenshot.data,
      clip,
      redaction: 'sensitive-elements-masked-before-capture',
    },
  };
}

export const DOM_SNAPSHOT_CONTRACT = Object.freeze({
  requestSchema: CAPTURE_REQUEST_SCHEMA,
  responseSchema: CAPTURE_RESPONSE_SCHEMA,
});
