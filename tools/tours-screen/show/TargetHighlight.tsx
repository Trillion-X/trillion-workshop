import { createPortal } from 'react-dom';
import { LAYER_ORDER } from '../../ui/show/layer-order/layer-order';
import type { CutoutGeometry } from '../../ui/show/overlay-spotlight/overlay-spotlight';
import type { LiveViewport } from './WalkthroughSurface';
import type { SpotlightAppearance } from './walkthrough-presentation';

export interface TargetHighlightProps {
  readonly cutout: CutoutGeometry | null;
  readonly viewport: LiveViewport;
  readonly appearance: SpotlightAppearance;
}

/** Accent ring painted over the punched scrim but outside the real target. */
export function TargetHighlight({ cutout, viewport, appearance }: TargetHighlightProps) {
  if (!cutout) return null;
  return createPortal(
    <div
      data-guided-overlay-target-highlight
      aria-hidden="true"
      style={{
        position: 'fixed',
        left: viewport.offsetLeft + cutout.x,
        top: viewport.offsetTop + cutout.y,
        width: cutout.width,
        height: cutout.height,
        boxSizing: 'border-box',
        border: `${appearance.ringWidthPx}px solid ${appearance.ringColor}`,
        borderRadius: Math.max(cutout.rx, cutout.ry),
        boxShadow: appearance.ringGlow,
        pointerEvents: 'none',
        zIndex: LAYER_ORDER.walkthrough - 1,
        transition: `left ${appearance.transitionMs}ms ease, top ${appearance.transitionMs}ms ease, width ${appearance.transitionMs}ms ease, height ${appearance.transitionMs}ms ease`,
      }}
    />,
    document.body,
  );
}
