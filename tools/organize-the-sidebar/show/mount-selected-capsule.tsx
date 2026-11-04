// The self-mounting renderer for an already-materialized Group selection.  The
// bytes are supplied by the projection owner; this entry performs no live reads
// and intentionally reuses the same read-only capsule surface as Group sharing.

import { mountReactSurface } from '../../ui';
import { SharedCapsuleView } from './SharedCapsuleView';
import type { ShareCapsule } from '../read-data/share-capsule';

export interface SelectedCapsuleMountInput {
  readonly el: HTMLElement;
  readonly capsule: ShareCapsule;
}

export function mountSelectedCapsule({ el, capsule }: SelectedCapsuleMountInput): () => void {
  return mountReactSurface(el, <SharedCapsuleView capsule={capsule} />);
}

export default mountSelectedCapsule;
