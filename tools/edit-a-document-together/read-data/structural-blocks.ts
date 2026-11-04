import type { SceneNode, ScenePatch } from './documents.ts';
import { MAX_INDENT_LEVEL } from './document-value.ts';
import { authoredPrimaryGrip } from './interaction-events.ts';

/** Optional structure contracts carried by a material's interaction DATA. */
export type StructuralBlockData = {
  primary_role?: string;
  body_role?: string;
  enter_placement?: 'body' | 'sibling';
  enter_state?: string;
  continue_material_id?: string;
  continue_state?: string;
  nestable?: boolean;
  list_item?: boolean;
};

export type StructuralPrimaryContext = {
  owner: SceneNode;
  parentId: string;
  index: number;
  data: StructuralBlockData;
};

export type StructuralContinuation = StructuralPrimaryContext & {
  placement: 'body' | 'sibling';
  materialId?: string;
  bodyId?: string;
  state?: string;
};

export type StructuralMovePlan = { handled: boolean; patches: ScenePatch[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function structureData(node: SceneNode): StructuralBlockData | null {
  const interaction = (node.props as (typeof node.props & { interaction?: unknown }) | undefined)?.interaction;
  if (!isRecord(interaction) || !isRecord(interaction.structure)) return null;
  return interaction.structure as StructuralBlockData;
}

function locatePath(root: SceneNode, nodeId: string): SceneNode[] | null {
  const visit = (node: SceneNode, path: SceneNode[]): SceneNode[] | null => {
    const next = [...path, node];
    if (node.id === nodeId) return next;
    for (const child of node.children ?? []) {
      const found = visit(child, next);
      if (found) return found;
    }
    return null;
  };
  return visit(root, []);
}

/** Find the structural owner whose DATA-designated primary text is being edited. */
export function structuralPrimaryContext(root: SceneNode, nodeId: string): StructuralPrimaryContext | null {
  const path = locatePath(root, nodeId);
  if (!path) return null;
  const text = path[path.length - 1];
  if (text.kind !== 'Text') return null;
  for (let ownerIndex = path.length - 2; ownerIndex >= 0; ownerIndex -= 1) {
    const owner = path[ownerIndex];
    const data = structureData(owner);
    if (!data) continue;
    if (authoredPrimaryGrip(owner)?.primaryNodeId !== nodeId) return null;
    // The editor acts on one designated primary text, not on arbitrary descendants
    // that happen to live inside the same structural owner.
    const parent = path[ownerIndex - 1];
    if (!parent) return null;
    const index = (parent.children ?? []).findIndex((child) => child.id === owner.id);
    return index < 0 ? null : { owner, parentId: parent.id, index, data };
  }
  return null;
}

function findBodyContainer(owner: SceneNode, bodyRole: string): SceneNode | null {
  const visit = (node: SceneNode, parent: SceneNode | null): SceneNode | null => {
    if (node.kind === 'Container' && node.props?.content_role === bodyRole) return node;
    if (node.kind === 'Text' && node.props?.content_role === bodyRole) return parent;
    for (const child of node.children ?? []) {
      const found = visit(child, node);
      if (found) return found;
    }
    return null;
  };
  return visit(owner, null);
}

/** Resolve the structural owner's DATA-designated body slot. */
export function structuralBodyContainer(owner: SceneNode, bodyRole?: string): SceneNode | null {
  return findBodyContainer(owner, bodyRole ?? structureData(owner)?.body_role ?? 'body');
}

/** Resolve the current block's DATA-described Enter destination and state. */
export function structuralContinuation(root: SceneNode, nodeId: string): StructuralContinuation | null {
  const context = structuralPrimaryContext(root, nodeId);
  if (!context) return null;
  const placement = context.data.enter_placement === 'body' ? 'body' : 'sibling';
  const state = placement === 'body'
    ? context.data.enter_state ?? context.data.continue_state
    : context.data.continue_state;
  if (placement === 'body') {
    const body = structuralBodyContainer(context.owner, context.data.body_role);
    if (!body) return null;
    return { ...context, placement, bodyId: body.id, ...(state ? { state } : {}) };
  }
  const materialId = context.data.continue_material_id;
  if (typeof materialId !== 'string' || materialId.length === 0) return null;
  return { ...context, placement, materialId, ...(state ? { state } : {}) };
}

function isNestableDisclosure(node: SceneNode): boolean {
  return structureData(node)?.nestable === true;
}

function findNode(root: SceneNode, nodeId: string): SceneNode | null {
  if (root.id === nodeId) return root;
  for (const child of root.children ?? []) {
    const found = findNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

/** Move a complete structural block beneath the previous eligible structural sibling. */
export function nestStructuralBlock(root: SceneNode, primaryId: string): ScenePatch | null {
  const current = structuralPrimaryContext(root, primaryId);
  if (!current?.data.nestable) return null;
  const parent = findNode(root, current.parentId);
  if (!parent) return null;
  const siblings = parent.children ?? [];
  const target = siblings[current.index - 1];
  if (!target || !isNestableDisclosure(target)) return null;
  const targetData = structureData(target)!;
  const body = structuralBodyContainer(target, targetData.body_role);
  if (!body) return null;
  return { type: 'MOVE_NODE', node_id: current.owner.id, new_parent_id: body.id, new_index: body.children?.length ?? 0 };
}

function findNodeLocation(root: SceneNode, nodeId: string): { parent: SceneNode; index: number } | null {
  const visit = (parent: SceneNode): { parent: SceneNode; index: number } | null => {
    const children = parent.children ?? [];
    const index = children.findIndex(child => child.id === nodeId);
    if (index >= 0) return { parent, index };
    for (const child of children) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(root);
}

function isIndentableText(node: SceneNode | null, shortcutIds: ReadonlySet<string>): node is SceneNode {
  const shortcut = node?.props?.made_by_shortcut;
  return node?.kind === 'Text' && typeof shortcut === 'string' && shortcutIds.has(shortcut);
}

function structuralListItemShell(ids: { owner: string; body: string }): SceneNode {
  return {
    id: ids.owner,
    kind: 'Container',
    props: {
      interaction: { structure: { primary_role: 'primary', body_role: 'body', nestable: true, list_item: true } },
      style: { layout: { mode: 'flex', axis: 'y', gap: 0 } },
    },
    visible: true,
    children: [{ id: ids.body, kind: 'Container', props: { content_role: 'body', style: { padding: { left: 24 }, layout: { mode: 'flex', axis: 'y', gap: 0 } } }, visible: true, children: [] }],
  };
}

/** Build the shared Container/Stack wrapper used when a flat authored list item first moves. */
export function makeStructuralListItem(primary: SceneNode, ids: { owner: string; body: string }): SceneNode {
  const shell = structuralListItemShell(ids);
  return { ...shell, children: [
    { ...primary, props: { ...primary.props, content_role: 'primary', indent_level: null } },
    ...(shell.children ?? []),
  ] };
}

/** Turn pasted flat list lines into real nested containers, retaining each primary Text id. */
export function structuralizeListBlocks(
  nodes: readonly SceneNode[],
  shortcutIds: ReadonlySet<string>,
  mint: () => string,
): SceneNode[] {
  const roots: SceneNode[] = [];
  const stack: SceneNode[] = [];
  for (const node of nodes) {
    if (!isIndentableText(node, shortcutIds)) {
      roots.push(node);
      stack.length = 0;
      continue;
    }
    const requestedDepth = Math.max(0, Math.min(MAX_INDENT_LEVEL, Number.isInteger(node.props?.indent_level) ? Number(node.props?.indent_level) : 0));
    const depth = Math.min(requestedDepth, stack.length);
    const wrapper = makeStructuralListItem(node, { owner: mint(), body: mint() });
    if (depth > 0) {
      const parent = stack[depth - 1];
      const body = structuralBodyContainer(parent)!;
      body.children = [...(body.children ?? []), wrapper];
    } else {
      roots.push(wrapper);
    }
    stack.length = depth;
    stack.push(wrapper);
  }
  return roots;
}

/** Move a flat list item under its immediately preceding list item using real scene containment.
 * Existing structured materials take the same path; flat text nodes are lazily wrapped while
 * retaining their primary Text id, props, marker, check state and content. */
export function nestIndentableBlock(
  root: SceneNode,
  primaryId: string,
  shortcutIds: ReadonlySet<string>,
  mint: () => string,
): StructuralMovePlan {
  const existing = structuralPrimaryContext(root, primaryId);
  if (existing) {
    const move = nestStructuralBlock(root, primaryId);
    if (move) return { handled: true, patches: [move] };
    const siblings = findNode(root, existing.parentId)?.children ?? [];
    const target = siblings[existing.index - 1];
    if (!isIndentableText(target ?? null, shortcutIds)) return { handled: true, patches: [] };
    const targetIds = { owner: mint(), body: mint() };
    const wrapped = structuralListItemShell(targetIds);
    const body = structuralBodyContainer(wrapped)!;
    return { handled: true, patches: [
      { type: 'INSERT_NODE', parent_id: existing.parentId, index: existing.index - 1, node: wrapped },
      { type: 'MOVE_NODE', node_id: target.id, new_parent_id: targetIds.owner, new_index: 0 },
      { type: 'UPDATE_PROPS', node_id: target.id, changes: { props: { ...target.props, content_role: 'primary', indent_level: null } } },
      { type: 'MOVE_NODE', node_id: existing.owner.id, new_parent_id: body.id, new_index: 0 },
    ] };
  }

  const current = findNode(root, primaryId);
  if (!isIndentableText(current, shortcutIds)) return { handled: false, patches: [] };
  const currentLocation = findNodeLocation(root, primaryId);
  if (!currentLocation) return { handled: true, patches: [] };
  const siblings = currentLocation.parent.children ?? [];
  const target = siblings[currentLocation.index - 1];
  if (!target) return { handled: true, patches: [] };

  let targetOwner = target;
  let targetBody = structuralBodyContainer(target);
  let targetPatches: ScenePatch[] = [];
  const targetContext = target.kind === 'Text' ? structuralPrimaryContext(root, target.id) : null;
  if (!targetBody && isIndentableText(target, shortcutIds)) {
    const targetIds = { owner: mint(), body: mint() };
    const wrapped = structuralListItemShell(targetIds);
    targetOwner = wrapped;
    targetBody = structuralBodyContainer(wrapped)!;
    targetPatches = [
      { type: 'INSERT_NODE', parent_id: currentLocation.parent.id, index: currentLocation.index - 1, node: wrapped },
      { type: 'MOVE_NODE', node_id: target.id, new_parent_id: targetIds.owner, new_index: 0 },
      { type: 'UPDATE_PROPS', node_id: target.id, changes: { props: { ...target.props, content_role: 'primary', indent_level: null } } },
    ];
  } else if (targetContext) {
    targetOwner = targetContext.owner;
    targetBody = structuralBodyContainer(targetOwner, targetContext.data.body_role);
  }
  if (!targetBody || !isNestableDisclosure(targetOwner)) return { handled: true, patches: [] };

  const currentIds = { owner: mint(), body: mint() };
  const currentWrapper = structuralListItemShell(currentIds);
  const currentIndexAfterTarget = currentLocation.index;
  return {
    handled: true,
    patches: [
      ...targetPatches,
      { type: 'INSERT_NODE', parent_id: currentLocation.parent.id, index: currentIndexAfterTarget, node: currentWrapper },
      { type: 'MOVE_NODE', node_id: current.id, new_parent_id: currentIds.owner, new_index: 0 },
      { type: 'UPDATE_PROPS', node_id: current.id, changes: { props: { ...current.props, content_role: 'primary', indent_level: null } } },
      { type: 'MOVE_NODE', node_id: currentIds.owner, new_parent_id: targetBody.id, new_index: targetBody.children?.length ?? 0 },
    ],
  };
}

/** Outdent an already wrapped item, or lazily wrap a plain continuation inside a list body. */
export function outdentIndentableBlock(
  root: SceneNode,
  primaryId: string,
  shortcutIds: ReadonlySet<string>,
  mint: () => string,
): StructuralMovePlan {
  const context = structuralPrimaryContext(root, primaryId);
  if (context) {
    const move = outdentStructuralBlock(root, primaryId);
    return { handled: true, patches: move ? [move] : [] };
  }
  const current = findNode(root, primaryId);
  if (!isIndentableText(current, shortcutIds)) return { handled: false, patches: [] };
  const location = findNodeLocation(root, primaryId);
  if (!location) return { handled: false, patches: [] };
  const path = locatePath(root, location.parent.id);
  if (!path) return { handled: false, patches: [] };
  for (let index = path.length - 1; index >= 1; index -= 1) {
    const body = path[index];
    if (body.kind !== 'Container' || body.props?.content_role !== 'body') continue;
    const owner = path[index - 1];
    if (!isNestableDisclosure(owner)) continue;
    const grandparent = path[index - 2];
    if (!grandparent) break;
    const ownerIndex = (grandparent.children ?? []).findIndex(child => child.id === owner.id);
    if (ownerIndex < 0) break;
    const ids = { owner: mint(), body: mint() };
    const wrapped = structuralListItemShell(ids);
    return { handled: true, patches: [
      { type: 'INSERT_NODE', parent_id: body.id, index: location.index, node: wrapped },
      { type: 'MOVE_NODE', node_id: current.id, new_parent_id: ids.owner, new_index: 0 },
      { type: 'UPDATE_PROPS', node_id: current.id, changes: { props: { ...current.props, content_role: 'primary', indent_level: null } } },
      { type: 'MOVE_NODE', node_id: ids.owner, new_parent_id: grandparent.id, new_index: ownerIndex + 1 },
    ] };
  }
  return { handled: false, patches: [] };
}

/** Remove a structural list wrapper while keeping its primary text and nested children in flow order. */
export function unwrapStructuralListItem(root: SceneNode, primaryId: string): ScenePatch[] | null {
  const context = structuralPrimaryContext(root, primaryId);
  if (!context || structureData(context.owner)?.list_item !== true) return null;
  const primary = findNode(root, primaryId);
  const body = structuralBodyContainer(context.owner, context.data.body_role);
  const location = findNodeLocation(root, context.owner.id);
  if (!primary || !body || !location) return null;
  const children = body.children ?? [];
  return [
    { type: 'MOVE_NODE', node_id: primary.id, new_parent_id: location.parent.id, new_index: location.index },
    ...children.map((child, index) => ({ type: 'MOVE_NODE' as const, node_id: child.id, new_parent_id: location.parent.id, new_index: location.index + 1 + index })),
    { type: 'REMOVE_SUBTREE', node_id: context.owner.id },
    { type: 'UPDATE_PROPS', node_id: primary.id, changes: { props: { ...primary.props, text: '', content_role: null, made_by_shortcut: null, shortcut_material_id: null, indent_level: null } } },
  ];
}

/** Move a nested structural block out after the disclosure that owns its body slot. */
export function outdentStructuralBlock(root: SceneNode, primaryId: string): ScenePatch | null {
  const current = structuralPrimaryContext(root, primaryId);
  if (!current?.data.nestable) return null;
  const path = locatePath(root, current.owner.id);
  if (!path) return null;
  for (let parentIndex = path.length - 2; parentIndex >= 0; parentIndex -= 1) {
    const parentOwner = path[parentIndex];
    if (!isNestableDisclosure(parentOwner)) continue;
    const parentData = structureData(parentOwner)!;
    const body = structuralBodyContainer(parentOwner, parentData.body_role);
    if (!body || !path.some((node) => node.id === body.id)) return null;
    const grandparent = path[parentIndex - 1];
    if (!grandparent) return null;
    const parentIndexInGrandparent = (grandparent.children ?? []).findIndex((child) => child.id === parentOwner.id);
    return parentIndexInGrandparent < 0 ? null : {
      type: 'MOVE_NODE', node_id: current.owner.id,
      new_parent_id: grandparent.id, new_index: parentIndexInGrandparent + 1,
    };
  }
  return null;
}
