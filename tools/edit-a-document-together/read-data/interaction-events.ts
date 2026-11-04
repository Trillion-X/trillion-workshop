/** A single event dispatch accepted by the composition transaction owner. */
export type CompositionInteractionEvent = Readonly<{
  node_id: string;
  event: string;
}>;

/**
 * Translate a node's declared DATA handlers into composition-engine events.
 *
 * This intentionally understands only the generic `DISPATCH_FSM` operation;
 * ownership of the actual interaction target and persistence stays with the
 * caller and the existing composition/document owners.
 */
export function compositionInteractionsForHandler(
  nodeId: string,
  handlers: unknown,
  handlerName = 'click',
): CompositionInteractionEvent[] {
  if (!nodeId || !isRecord(handlers)) return [];
  const actions = handlers[handlerName];
  if (!Array.isArray(actions)) return [];

  const interactions: CompositionInteractionEvent[] = [];
  for (const action of actions) {
    if (!isRecord(action) || action.kind !== 'DISPATCH_FSM' || !isRecord(action.event)) continue;
    const event = action.event.type;
    if (typeof event !== 'string' || event.length === 0) continue;
    interactions.push({ node_id: nodeId, event });
  }
  return interactions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve an unguarded transition from authored DATA. Guarded/contextual FSMs
 * retain their engine owner; no browser guess may commit their next state. */
export function authoredInteractionState(fsm: unknown, handlers: unknown): string | null {
  if (!isRecord(fsm) || typeof fsm.initial !== 'string' || !isRecord(fsm.states)) return null;
  if (!isRecord(handlers) || !Array.isArray(handlers.click) || handlers.click.some(action => !isRecord(action) || action.kind !== 'DISPATCH_FSM')) return null;
  let state = fsm.initial;
  for (const interaction of compositionInteractionsForHandler('owner', handlers)) {
    const current = fsm.states[state];
    const transitions = isRecord(current) && isRecord(current.on) ? current.on[interaction.event] : null;
    if (!Array.isArray(transitions) || transitions.some(row => !isRecord(row) || row.guard !== undefined || (Array.isArray(row.actions) && row.actions.length > 0))) return null;
    const transition = transitions.find(row => isRecord(row) && row.guard === undefined);
    if (!isRecord(transition) || typeof transition.target !== 'string' || !isRecord(fsm.states[transition.target])) return null;
    state = transition.target;
  }
  return state !== fsm.initial ? state : null;
}

/** FSM identities are opaque object keys, never dotted paths. Repair older
 * scene bindings only when their exact string names an actual inline owner. */
export function repairOwnedFsmBindings<T>(root: T): T {
  const owners = new Set<string>();
  const collect = (value: unknown) => {
    if (!isRecord(value)) return;
    if (isRecord(value.fsm) && typeof value.id === 'string') owners.add(value.id);
    for (const child of Array.isArray(value.children) ? value.children : []) collect(child);
  };
  collect(root);
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isRecord(value)) return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    if (value.$kind === 'binding' && isRecord(value.select) && value.select.from === 'fsm'
      && typeof value.select.path === 'string' && owners.has(value.select.path)) {
      result.select = { ...value.select, path: `[${JSON.stringify(value.select.path)}]` };
    }
    return result;
  };
  return visit(root) as T;
}


/** Primary editable ownership is carried through layout wrappers while rendering. */
export function authoredPrimaryGrip(node: unknown): { ownerId: string; role: string; primaryNodeId: string; bodyNodeId?: string } | null {
  if (!isRecord(node) || typeof node.id !== 'string' || !isRecord(node.props) || !isRecord(node.props.interaction)) return null;
  const structure = node.props.interaction.structure;
  if (!isRecord(structure)) return null;
  const role = typeof structure.primary_role === 'string' ? structure.primary_role : 'primary';
  const primary = (candidate: Record<string, unknown>): string | null => {
    // A nested interaction owns its own primary; an outer material cannot
    // claim it merely because both DATA contracts use the same role name.
    if (candidate !== node && isRecord(candidate.props) && isRecord(candidate.props.interaction)) return null;
    if (candidate.kind === 'Text' && candidate.synthetic !== true && typeof candidate.id === 'string'
      && isRecord(candidate.props) && candidate.props.content_role === role) return candidate.id;
    for (const child of Array.isArray(candidate.children) ? candidate.children : []) {
      if (!isRecord(child)) continue;
      const found = primary(child);
      if (found) return found;
    }
    return null;
  };
  const primaryNodeId = primary(node);
  if (!primaryNodeId) return null;
  const bodyRole = typeof structure.body_role === 'string' ? structure.body_role : 'body';
  const body = (candidate: Record<string, unknown>, parent?: Record<string, unknown>): string | undefined => {
    if (candidate !== node && isRecord(candidate.props) && isRecord(candidate.props.interaction)) return;
    if (isRecord(candidate.props) && candidate.props.content_role === bodyRole) {
      const container = candidate.kind === 'Container' ? candidate : parent?.kind === 'Container' ? parent : undefined;
      if (typeof container?.id === 'string' && container !== node) return container.id;
    }
    for (const child of Array.isArray(candidate.children) ? candidate.children : []) {
      if (!isRecord(child)) continue;
      const found = body(child, candidate);
      if (found) return found;
    }
  };
  const bodyNodeId = body(node);
  return { ownerId: node.id, role, primaryNodeId, ...(bodyNodeId ? { bodyNodeId } : {}) };
}
