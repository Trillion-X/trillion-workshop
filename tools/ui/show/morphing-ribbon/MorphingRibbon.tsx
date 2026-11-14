import React from 'react';

export const MORPHING_RIBBON_REFERENCE_VIEWBOX = '0 0 736 414';

export const MORPHING_RIBBON_PATHS = {
  wave: 'M -20 132 C 15 180 50 235 105 220 C 155 205 220 168 300 135 C 410 88 540 75 756 70 C 756 130 756 190 756 250 C 675 245 600 245 525 246 C 455 248 400 252 350 260 C 280 273 220 302 160 330 C 76 366 20 326 -20 286 C -20 250 -20 220 -20 200 C -20 180 -20 150 -20 132 Z',
  band: 'M -8 160 C 100 160 180 160 260 160 C 300 160 436 160 476 160 C 560 160 640 160 744 160 C 748 160 748 164 748 206 C 748 220 748 235 748 249 C 640 253 560 253 476 253 C 436 253 300 253 260 253 C 180 253 100 253 -8 252 C -12 248 -12 220 -12 206 C -12 190 -12 164 -8 160 Z',
  pill: 'M 165 160 C 210 160 255 160 300 160 C 345 160 391 160 436 160 C 481 160 526 160 571 160 C 597 160 617 180 617 206 C 617 232 597 253 571 253 C 526 253 481 253 436 253 C 391 253 345 253 300 253 C 255 253 210 253 165 253 C 139 253 119 232 119 206 C 119 180 139 160 165 160 Z',
  card: 'M 132 99 C 250 99 330 100 410 100 C 470 100 530 101 594 101 C 611 101 624 113 624 130 C 624 180 625 240 625 282 C 625 299 615 312 598 312 C 520 312 450 312 380 312 C 320 312 220 311 141 312 C 123 311 112 300 111 282 C 108 220 104 160 102 130 C 101 111 114 98 132 99 Z',
} as const;

export const MORPHING_RIBBON_GUIDES = {
  wave: 'M -20 218 C 44 286 82 308 155 270 C 292 198 418 158 610 155 C 660 154 708 154 756 154',
  band: 'M 0 220 C 180 220 260 220 368 220 C 476 220 556 220 676 220 C 696 220 716 220 736 220',
  pill: 'M 145 220 C 250 220 300 220 368 220 C 436 220 486 220 561 220 C 571 220 581 220 591 220',
  card: 'M 122 230 C 250 230 300 230 368 230 C 436 230 486 230 584 230 C 594 230 604 230 614 230',
} as const;

export type MorphingRibbonFrame = keyof typeof MORPHING_RIBBON_PATHS;
export type MorphingRibbonMotion = 'still' | 'loop';

export type MorphingRibbonProps = {
  lead: string;
  emphasis: string;
  frame?: MorphingRibbonFrame;
  motion?: MorphingRibbonMotion;
  accessibleLabel?: string;
  className?: string;
};

const FRAME_ORDER: readonly MorphingRibbonFrame[] = ['wave', 'band', 'pill', 'card', 'pill', 'band', 'wave'];

function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  return reduced;
}

/**
 * Structure and motion for the saved-reference ribbon sequence. Visual styling
 * is intentionally absent: screen-look owns the colors, type, blur, and shadow.
 */
export function MorphingRibbon({
  lead,
  emphasis,
  frame = 'band',
  motion = 'still',
  accessibleLabel = `${lead}${emphasis}`,
  className,
}: MorphingRibbonProps) {
  const reducedMotion = useReducedMotion();
  const animate = motion === 'loop' && !reducedMotion;
  const pathId = React.useId().replace(/:/g, '');
  const shapeAnimationRef = React.useRef<SVGAnimateElement | null>(null);
  const guideAnimationRef = React.useRef<SVGAnimateElement | null>(null);
  const pathValues = FRAME_ORDER.map((key) => MORPHING_RIBBON_PATHS[key]).join(';');
  const guideValues = FRAME_ORDER.map((key) => MORPHING_RIBBON_GUIDES[key]).join(';');

  React.useEffect(() => {
    if (!animate) return;
    shapeAnimationRef.current?.beginElement?.();
    guideAnimationRef.current?.beginElement?.();
  }, [animate]);

  return (
    <figure
      aria-label={accessibleLabel}
      className={['morphing-ribbon', className].filter(Boolean).join(' ')}
      data-frame={frame}
      data-motion={animate ? 'loop' : 'still'}
      role="img"
    >
      <svg aria-hidden="true" className="morphing-ribbon__stage" viewBox={MORPHING_RIBBON_REFERENCE_VIEWBOX}>
        <path className="morphing-ribbon__shape" d={MORPHING_RIBBON_PATHS[frame]}>
          {animate ? (
            <animate ref={shapeAnimationRef} attributeName="d" dur="6.4s" repeatCount="indefinite" values={pathValues} />
          ) : null}
        </path>
        <path className="morphing-ribbon__guide" d={MORPHING_RIBBON_GUIDES[frame]} fill="none" id={pathId}>
          {animate ? (
            <animate ref={guideAnimationRef} attributeName="d" dur="6.4s" repeatCount="indefinite" values={guideValues} />
          ) : null}
        </path>
        <text className="morphing-ribbon__message">
          <textPath href={`#${pathId}`} startOffset="50%" textAnchor="middle">
            <tspan className="morphing-ribbon__lead">{lead}</tspan>
            <tspan className="morphing-ribbon__emphasis">{emphasis}</tspan>
          </textPath>
        </text>
      </svg>
    </figure>
  );
}
