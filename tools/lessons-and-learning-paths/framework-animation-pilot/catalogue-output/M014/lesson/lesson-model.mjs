import * as K from '../../../../parts/ui/show/anatomy/iso-kit.mjs';
import { renderPersonContext } from '../../../anatomy-contact-replacement/context-model.mjs';

export const SIDE_IDS = Object.freeze(['payer', 'user']);
export const DEFAULT_SIDE = 'payer';

const ACTORS_BY_RELATIONSHIP = Object.freeze({
  payer: ['employer', 'provider'],
  user: ['provider', 'employee'],
});

function personViewport(person) {
  const joints = Object.values(person.state.joints).flatMap(value => typeof value[0] === 'number' ? [value] : value);
  const points = joints.flatMap(([x, y, z]) => K.boxCorners({ x: x - 22, y: y - 22, w: 44, d: 44, r: 0 }, z - 24, z + 24))
    .map(point => K.iso(point, person.state.projection));
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  const pad = 28;
  return [
    Math.floor(Math.min(...xs) - pad),
    Math.floor(Math.min(...ys) - pad),
    Math.ceil(Math.max(...xs) - Math.min(...xs) + pad * 2),
    Math.ceil(Math.max(...ys) - Math.min(...ys) + pad * 2),
  ];
}

export function sceneForSide(side, actorLabels) {
  if (!SIDE_IDS.includes(side)) throw new TypeError(`Unknown M014 relationship: ${String(side)}`);
  if (!actorLabels || typeof actorLabels !== 'object') throw new TypeError('M014 actor labels must come from the lesson copy');
  const actors = ACTORS_BY_RELATIONSHIP[side].map(role => {
    const label = actorLabels[role];
    if (typeof label !== 'string' || !label.trim()) throw new TypeError(`M014 needs a caller-owned ${role} label`);
    const figure = renderPersonContext({ pose: 'standing', label, ground: false });
    return { id: role, label, figure, viewport: personViewport(figure) };
  });
  return {
    actors,
    state: { selectedRelationship: side, displayedRoles: actors.map(actor => actor.id) },
  };
}
