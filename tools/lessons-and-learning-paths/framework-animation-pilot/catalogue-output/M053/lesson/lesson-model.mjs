import { renderContext } from '../../../anatomy-contact-replacement/context-model.mjs';

export const TREE_VIEWPORT = [670, 245, 580, 700];
const lenses = new Map([
  ['whole', { focus: 'all' }],
  ['shade', { focus: 'mechanism' }],
  ['material', { focus: 'entities' }],
]);

export function sceneFor(lensId) {
  const selected = lenses.get(lensId);
  if (!selected) throw new TypeError(`Unknown M053 view: ${lensId}`);
  const scene = renderContext({ mode: 'tree', time: 11, focus: selected.focus });
  return {
    ...scene,
    viewport: [...TREE_VIEWPORT],
    state: { ...scene.state, lens: lensId },
  };
}
