/**
 * Publish how much of the viewport bottom a default-docked floating control
 * covers, so other overlays (the toast stack) stack above it. The arranged
 * stage never reads this value and never shrinks for an overlay.
 */
const PROPERTY = '--floating-occlusion-bottom';
/** Announced on the document whenever a docked control is added, moves, resizes or leaves. */
export const FLOATING_OCCLUSION_CHANGE = 'floating-occlusion-change';

/** Where one docked control sits, in viewport pixels: its sides and its top (its bottom is the viewport's). */
export type DockedBox = {left: number; right: number; top: number};

type OwnerState = {
  values: Map<HTMLElement, number>;
  boxes: Map<HTMLElement, DockedBox>;
  original: {value: string; priority: string};
};
const owners = new WeakMap<Document, OwnerState>();

function stateFor(doc: Document): OwnerState {
  let state = owners.get(doc);
  if (!state) {
    const root = doc.documentElement;
    state = {values: new Map(), boxes: new Map(), original: {
      value: root.style.getPropertyValue(PROPERTY), priority: root.style.getPropertyPriority(PROPERTY),
    }};
    owners.set(doc, state);
  }
  return state;
}

function paint(doc: Document, state: OwnerState) {
  const root = doc.documentElement;
  const largest = Math.max(0, ...state.values.values());
  if (largest > 0) root.style.setProperty(PROPERTY, `${largest}px`);
  else if (state.original.value) root.style.setProperty(PROPERTY, state.original.value, state.original.priority);
  else root.style.removeProperty(PROPERTY);
  doc.dispatchEvent(new CustomEvent(FLOATING_OCCLUSION_CHANGE));
}

/** Every control docked at the viewport bottom now, so an overlay can sit beside one instead of above all of them. */
export function dockedFloatingBoxes(doc: Document): DockedBox[] {
  return [...(owners.get(doc)?.boxes.values() ?? [])];
}

/**
 * The value is published only while this control is visibly docked against
 * the viewport bottom. A user-moved or collapsed control releases it.
 */
export function reserveBottomFloatingInset(node: HTMLElement, gutter = 8): () => void {
  const doc = node.ownerDocument;
  const win = doc.defaultView;
  const state = stateFor(doc);
  const update = () => {
    const rect = node.getBoundingClientRect();
    const viewportHeight = win?.innerHeight ?? doc.documentElement.clientHeight;
    const docked = node.isConnected && !node.hidden && !node.hasAttribute('data-collapsed')
      && !node.hasAttribute('data-moved') && rect.height > 0 && rect.top < viewportHeight
      && rect.bottom >= viewportHeight - 48;
    if (docked) {
      state.values.set(node, Math.ceil(viewportHeight - rect.top + gutter));
      state.boxes.set(node, {left: Math.floor(rect.left), right: Math.ceil(rect.right), top: Math.floor(rect.top)});
    } else {
      state.values.delete(node);
      state.boxes.delete(node);
    }
    paint(doc, state);
  };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
  resize?.observe(node);
  const mutations = typeof MutationObserver === 'function' ? new MutationObserver(update) : null;
  mutations?.observe(node, {attributes: true, attributeFilter: ['data-collapsed', 'data-moved', 'hidden', 'style', 'class']});
  win?.addEventListener('resize', update);
  const frame = win?.requestAnimationFrame?.(update);
  update();
  return () => {
    if (frame !== undefined) win?.cancelAnimationFrame?.(frame);
    resize?.disconnect();
    mutations?.disconnect();
    win?.removeEventListener('resize', update);
    state.values.delete(node);
    state.boxes.delete(node);
    paint(doc, state);
    if (state.values.size === 0) owners.delete(doc);
  };
}
