// packages/group/show/WalkthroughOverlay.tsx
//
// R7 product surface: the guided walkthrough overlay. It spotlights the current step's
// target on the board and shows a step card (title, body, progress, Prev/Next/Done). It
// reads the pure tour model (walkthrough.ts); the mounting surface resolves each step's
// target to a rect and owns the current-step state.
//
// Generic: it never names a specific tour or step — it renders whatever DATA it is given.
// The spotlight ring is dynamic (position of an arbitrary target), so it uses positioned
// Containers; chrome uses the Card popover variant and ui Buttons (L065).

import { Button, Card, Container, Text } from '../../ui';
import { NODE_REF_ATTR } from '../../ui/show/node-actions';
import { STAGE_CHROME_ATTR } from '../../ui/show/canvas-viewport/stage-chrome';
import {
  isFirstStep,
  isLastStep,
  stepAt,
  tourProgressLabel,
  type Tour,
} from '../read-data/walkthrough';

export interface TargetRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * The VISUALLY RENDERED rect of a step's target (R34a). A member's frame (its w/h DATA)
 * can be taller than the card actually drawn inside it — a fit-mode note renders at
 * content height — so a spotlight sized to the frame overshoots the card. This measures
 * the drawn content: find the node element stamped with `nodeRefValue` (the serialized
 * `data-node-ref` every CanvasNode carries), and take the max offset extent of its
 * content wrapper's children. Offset geometry is PRE-transform, so it is world-space at
 * any camera zoom — the same space the frame rects already live in. The origin stays the
 * frame origin; only the extent tightens. Unmeasurable (element absent, zero-sized boxes,
 * jsdom) → the frame unchanged, never a broken rect.
 */
export function renderedTargetRect(
  stage: HTMLElement | null | undefined,
  nodeRefValue: string,
  frame: TargetRect,
): TargetRect {
  if (!stage) return frame;
  let node: HTMLElement | null = null;
  for (const el of Array.from(stage.querySelectorAll(`[${NODE_REF_ATTR}]`))) {
    if (el.getAttribute(NODE_REF_ATTR) === nodeRefValue) {
      node = el as HTMLElement;
      break;
    }
  }
  // The node root is frame-sized by construction; the drawn card lives inside its first
  // child (the content wrapper). Children offset against the positioned node root.
  const wrapper = node?.firstElementChild as HTMLElement | null;
  if (!wrapper) return frame;
  let right = 0;
  let bottom = 0;
  for (const child of Array.from(wrapper.children) as HTMLElement[]) {
    const w = child.offsetWidth ?? 0;
    const h = child.offsetHeight ?? 0;
    if (w <= 0 || h <= 0) continue;
    right = Math.max(right, (child.offsetLeft ?? 0) + w);
    bottom = Math.max(bottom, (child.offsetTop ?? 0) + h);
  }
  if (right <= 0 || bottom <= 0) return frame;
  return { x: frame.x, y: frame.y, w: right, h: bottom };
}

export interface WalkthroughOverlayProps {
  readonly tour: Tour;
  readonly index: number;
  /** Resolved rect of the current step's target — the member FRAME (world coords).
   *  Absent → step is centered. */
  readonly targetRect?: TargetRect;
  /** The target's measured RENDERED rect (renderedTargetRect). When present it wins
   *  over `targetRect` for the spotlight and the card anchor, so the ring grips the
   *  drawn card instead of a taller frame (R34a). Absent → the frame is used. */
  readonly renderedRect?: TargetRect;
  /** World→screen projection for the spotlight rect and card anchor (R42b). When the
   *  overlay is mounted in the top HUD layer (above the minimap) rather than inside the
   *  camera's world transform, its coords must be screen-space, else the CSS transform
   *  would apply twice. The mounting surface passes `r => ({x:r.x*zoom+panX, ...})`.
   *  Absent → identity (world-space mount, the test/default path). Lifting the card into
   *  the HUD layer is what keeps its buttons clickable when a step's target sits under the
   *  bottom-right minimap — the minimap paints over anything left in the world layer. */
  readonly project?: (rect: TargetRect) => TargetRect;
  readonly onNext: () => void;
  readonly onPrev: () => void;
  readonly onClose: () => void;
}

export function WalkthroughOverlay({
  tour,
  index,
  targetRect,
  renderedRect,
  project,
  onNext,
  onPrev,
  onClose,
}: WalkthroughOverlayProps): JSX.Element | null {
  const step = stepAt(tour, index);
  if (!step) return null;
  const total = tour.steps.length;
  const last = isLastStep(tour, index);
  const first = isFirstStep(index);
  // The spotlight grips the DRAWN card when a measured rect exists (R34a); the
  // frame rect is the fallback, never a second highlight. R42b: when the overlay
  // is mounted in the HUD layer (above the minimap) it is passed a world→screen
  // `project`; without it the rect is used as-is (world-space mount, tests).
  const worldRect = renderedRect ?? targetRect;
  const spotlightRect = worldRect && project ? project(worldRect) : worldRect;
  // R34b: ONE step counter. A generated tour (readingTour) carries "N of M" as its
  // step body — the exact string the counter already shows. Rendering both reads as
  // duplicated copy, so a body that says nothing beyond the counter is dropped.
  const progress = tourProgressLabel(index, total);
  const body = step.body.trim() === progress ? '' : step.body;

  // Place the step card just below the target if there is one, else centered near top.
  const cardStyle = spotlightRect
    ? { left: spotlightRect.x, top: spotlightRect.y + spotlightRect.h + 12, maxWidth: 300, zIndex: 60 }
    : { left: '50%' as const, top: 40, transform: 'translateX(-50%)', maxWidth: 300, zIndex: 60 };

  return (
    <>
      {/* Spotlight ring around the current target (highlights without hiding it). */}
      {spotlightRect ? (
        <Container
          data-testid="walkthrough-spotlight"
          position="absolute"
          pointerEvents="none"
          style={{
            left: spotlightRect.x - 4,
            top: spotlightRect.y - 4,
            width: spotlightRect.w + 8,
            height: spotlightRect.h + 8,
            border: '3px solid var(--accent-primary, #3b6fe0)',
            borderRadius: 12,
            boxShadow: '0 0 0 9999px rgba(15,20,30,.45)',
            zIndex: 55,
          }}
        />
      ) : null}
      {/* data-stage-chrome (R42): this card floats over the canvas but is chrome —
          a press on its buttons must NOT reach the stage's marquee/pan interpreter,
          whose pointer capture would steal the click and leave Next/Skip/Done dead. */}
      <Container position="absolute" style={cardStyle} {...{ [STAGE_CHROME_ATTR]: '' }}>
        <Card variant="popover" padding="md">
          <Container layout="vertical" gap="sm">
            <Text variant="body-sm" tone="muted">
              {progress}
            </Text>
            <Text variant="body-md" weight="semibold">
              {step.title}
            </Text>
            {body ? <Text variant="body-sm">{body}</Text> : null}
            <Container layout="horizontal" gap="sm" alignItems="center">
              {!first ? (
                <Button variant="ghost" size="sm" onClick={onPrev} aria-label="Previous step">
                  Back
                </Button>
              ) : null}
              <Button variant="primary" size="sm" onClick={last ? onClose : onNext} aria-label={last ? 'Finish walkthrough' : 'Next step'}>
                {last ? 'Done' : 'Next'}
              </Button>
              {!last ? (
                <Button variant="ghost" size="sm" onClick={onClose} aria-label="Skip walkthrough">
                  Skip
                </Button>
              ) : null}
            </Container>
          </Container>
        </Card>
      </Container>
    </>
  );
}
