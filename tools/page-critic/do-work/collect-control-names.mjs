// Collect Chromium's computed accessible names for a DATA-selected set of DOM controls.
// Names come only from the browser accessibility tree; DOM labels are never reimplemented here.
export const controlDomObservationExpression = String.raw`element => {
  // Some composite controls retain an autofill/form node that paints nothing.
  // aria-hidden alone is insufficient: visible or tab-sequence controls still
  // require AX evidence, and a currently focused node must not disappear here.
  const fullyClippedHidden = node => {
    if (node.getAttribute('aria-hidden') !== 'true' || node.tabIndex >= 0 || node === document.activeElement) return false;
    const style = getComputedStyle(node);
    const match = /^inset\(([^()]+)\)$/.exec(style.clipPath);
    const parts = match?.[1].trim().split(/\s+/) ?? [];
    if (!parts.length || parts.length > 4 || parts.some(value => !/^-?(?:\d+(?:\.\d*)?|\.\d+)%$/.test(value))) return false;
    const [top, right = top, bottom = top, left = right] = parts;
    // Percentage insets prove an empty clip independently of transforms and
    // rounded screen bounds. Other shapes/units remain candidates.
    return parseFloat(top) + parseFloat(bottom) >= 100
      || parseFloat(left) + parseFloat(right) >= 100;
  };
  const diagnosticParts = [];
  for (let node = element; node && node.nodeType === 1 && diagnosticParts.length < 4; node = node.parentElement) {
    if (node === document.body) { diagnosticParts.unshift('body'); break; }
    let part = node.tagName.toLowerCase();
    if (node.id && !/\d{3,}|[0-9a-f]{8,}/i.test(node.id)) { diagnosticParts.unshift(part + '#' + node.id); break; }
    const named = [...node.classList].filter(name => /^[a-z][\w-]*$/i.test(name) && name.length < 50);
    if (named.length) part += '.' + named[named.length - 1];
    const same = node.parentElement ? [...node.parentElement.children].filter(other => other.tagName === node.tagName) : [];
    if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    diagnosticParts.unshift(part);
  }
  const identityParts = [];
  const identityVisible = node => {
    const computed = getComputedStyle(node);
    if (computed.visibility === 'hidden' || computed.display === 'none' || Number(computed.opacity) <= 0 || fullyClippedHidden(node)) return false;
    if (computed.display === 'contents') return true;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    let part = node.localName.toLowerCase();
    const same = node.parentElement ? [...node.parentElement.children].filter(other => other.localName === node.localName && identityVisible(other)) : [];
    part += '[' + (same.indexOf(node) + 1) + ']';
    identityParts.unshift(part);
  }
  const structuralParts = [];
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    let part = node.localName.toLowerCase();
    const same = node.parentElement ? [...node.parentElement.children].filter(other => other.localName === node.localName) : [];
    if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    structuralParts.unshift(part);
  }
  const box = element.getBoundingClientRect(), style = getComputedStyle(element);
  return {
    selector: diagnosticParts.join(' > '),
    identitySelector: identityParts.join(' > '),
    structuralSelector: structuralParts.join(' > '),
    shown: box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0 && !fullyClippedHidden(element),
    rect: { x: Math.round(box.left), y: Math.round(box.top + scrollY), width: Math.round(box.width), height: Math.round(box.height) },
  };
}`;

export async function collectControlNames({ send, selector, roles, frameId = null }) {
  await send('DOM.enable');
  await send('Accessibility.enable');
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
  const documentForFrame = (tree, wantedFrameId) => {
    const pending = [tree];
    const visited = new Set();
    while (pending.length) {
      const node = pending.pop();
      if (!node || visited.has(node)) continue;
      visited.add(node);
      if (node.frameId === wantedFrameId && node.contentDocument) return node.contentDocument;
      pending.push(...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.pseudoElements ?? []));
      if (node.contentDocument) pending.push(node.contentDocument);
      if (node.templateContent) pending.push(node.templateContent);
    }
    return null;
  };
  let rootNode = root;
  if (frameId) {
    const { frameTree } = await send('Page.getFrameTree');
    rootNode = frameTree?.frame?.id === frameId ? root : documentForFrame(root, frameId);
  }
  const rootNodeId = rootNode?.nodeId;
  if (!rootNodeId) throw new Error('control_name AX unavailable: the document root could not be read');
  const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: rootNodeId, selector });
  let executionContextId;
  if (frameId && nodeIds?.length) {
    const world = await send('Page.createIsolatedWorld', { frameId, worldName: 'pageCraftControlNames' });
    executionContextId = world.executionContextId;
    if (!executionContextId) throw new Error('control_name AX unavailable: the frame execution context could not be created');
  }
  const { nodes } = await send('Accessibility.getFullAXTree', frameId ? { frameId } : {});
  const byBackend = new Map();
  for (const node of nodes ?? []) {
    if (!node.backendDOMNodeId) continue;
    const rows = byBackend.get(node.backendDOMNodeId) ?? [];
    rows.push(node);
    byBackend.set(node.backendDOMNodeId, rows);
  }
  const result = [];
  const inspectDOM = async objectId => {
    const { result: inspected } = await send('Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () { return (${controlDomObservationExpression})(this); }`,
    });
    return inspected?.value ?? null;
  };
  for (const nodeId of nodeIds ?? []) {
    const { node } = await send('DOM.describeNode', { nodeId });
    const backendNodeId = node?.backendNodeId;
    if (!backendNodeId) throw new Error('control_name AX unavailable: a selected control has no backend DOM identity');
    const { object } = await send('DOM.resolveNode', { backendNodeId, ...(executionContextId ? { executionContextId } : {}) });
    if (!object?.objectId) {
      result.push({ backendNodeId, state: 'unavailable', reason: 'DOM node could not be resolved' });
      continue;
    }
    const domObservation = await inspectDOM(object.objectId).catch(() => null);
    const observedDOM = domObservation ?? {};
    let accessibleRows = (byBackend.get(backendNodeId) ?? []).filter(node => !node.ignored);
    if (!accessibleRows.length) {
      try {
        const partial = await send('Accessibility.getPartialAXTree', { objectId: object.objectId, fetchRelatives: false });
        accessibleRows = (partial.nodes ?? []).filter(node => node.backendDOMNodeId === backendNodeId && !node.ignored);
      } catch (error) {
        await send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
        result.push({ backendNodeId, ...observedDOM, state: 'unavailable', reason: `partial accessibility-tree lookup failed: ${String(error?.message ?? error).slice(0, 160)}` });
        continue;
      }
    }
    const explicitRole = (() => {
      const at = (node.attributes ?? []).indexOf('role');
      return at >= 0 ? node.attributes[at + 1] ?? '' : '';
    })();
    const matches = accessibleRows.filter(node => !explicitRole || roles.includes(node.role?.value));
    if (matches.length !== 1) {
      const role = accessibleRows.length === 1 ? accessibleRows[0].role?.value : undefined;
      result.push({ backendNodeId, ...(role ? { role } : {}), ...observedDOM, state: 'unavailable', reason: matches.length
        ? 'ambiguous accessibility-tree nodes'
        : role && explicitRole ? `unsupported accessibility-tree role: ${role}` : accessibleRows.length ? 'ambiguous accessibility-tree nodes' : 'no applicable accessibility-tree node' });
      await send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
      continue;
    }
    const ax = matches[0];
    await send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    if (!domObservation) {
      result.push({ backendNodeId, role: ax.role.value, state: 'unavailable', reason: 'DOM node inspection failed' });
      continue;
    }
    result.push({ backendNodeId, role: ax.role.value, name: ax.name?.value ?? '', ...domObservation, state: 'available' });
  }
  return result;
}
