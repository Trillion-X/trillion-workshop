// parts/ui/show/device-frame/DeviceFrame.tsx
//
// A phone drawn around a real screenshot: the body, side buttons and camera island as one SVG, the
// screenshot showing through a rounded screen cut-out. Adapted from Magic UI's iPhone (MIT, see
// LICENSE.md in this folder): the same outline and screen geometry, with the body colours read from
// role tokens so a page's theme decides them, and alt text on the picture.
//
// Invariants:
// - The picture keeps its own proportions inside the screen (object-fit: cover from the top), so a
//   screenshot at the phone's aspect ratio shows whole and any other one is cropped from the bottom.
// - Colours come only from --device-frame-body, --device-frame-edge and --device-frame-screen; the
//   fallbacks are a dark titanium phone.
// - One mask id per frame (React useId), so many phones on one page never share a cut-out.

import React, { useId } from 'react';

const PHONE_WIDTH = 433;
const PHONE_HEIGHT = 882;
const SCREEN_X = 21.25;
const SCREEN_Y = 19.25;
const SCREEN_WIDTH = 389.5;
const SCREEN_HEIGHT = 843.5;
const SCREEN_RADIUS = 55.75;

const pct = (part: number, whole: number) => `${(part / whole) * 100}%`;

export type DeviceFrameProps = {
  /** The screenshot shown on the screen. */
  src: string;
  /** What the screenshot shows, for readers who cannot see it. */
  alt: string;
  /** Load the picture at once (the first phone a reader sees) instead of when it scrolls near. */
  priority?: boolean;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>;

const STYLE = `
  .device-frame { position: relative; display: inline-block; width: 100%; aspect-ratio: ${PHONE_WIDTH} / ${PHONE_HEIGHT}; line-height: 0; vertical-align: middle; }
  .device-frame__screen { position: absolute; z-index: 0; overflow: hidden; left: ${pct(SCREEN_X, PHONE_WIDTH)}; top: ${pct(SCREEN_Y, PHONE_HEIGHT)}; width: ${pct(SCREEN_WIDTH, PHONE_WIDTH)}; height: ${pct(SCREEN_HEIGHT, PHONE_HEIGHT)}; border-radius: ${pct(SCREEN_RADIUS, SCREEN_WIDTH)} / ${pct(SCREEN_RADIUS, SCREEN_HEIGHT)}; background: var(--device-frame-screen, #000); }
  .device-frame__screen img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
  .device-frame__body { position: absolute; inset: 0; width: 100%; height: 100%; }
  .device-frame__edge { fill: var(--device-frame-edge, #3a3a3c); }
  .device-frame__shell { fill: var(--device-frame-body, #1c1c1e); }
`;

export function DeviceFrame({ src, alt, priority = false, className, ...rest }: DeviceFrameProps) {
  const mask = `device-frame-screen-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <span {...rest} className={className ? `device-frame ${className}` : 'device-frame'}>
      <style>{STYLE}</style>
      <span className="device-frame__screen">
        <img src={src} alt={alt} loading={priority ? 'eager' : 'lazy'} decoding="async" />
      </span>
      <svg className="device-frame__body" viewBox={`0 0 ${PHONE_WIDTH} ${PHONE_HEIGHT}`} fill="none" aria-hidden="true">
        <g mask={`url(#${mask})`}>
          <path className="device-frame__edge" d="M2 73C2 32.6832 34.6832 0 75 0H357C397.317 0 430 32.6832 430 73V809C430 849.317 397.317 882 357 882H75C34.6832 882 2 849.317 2 809V73Z" />
          <path className="device-frame__edge" d="M0 171C0 170.448 0.447715 170 1 170H3V204H1C0.447715 204 0 203.552 0 203V171Z" />
          <path className="device-frame__edge" d="M1 234C1 233.448 1.44772 233 2 233H3.5V300H2C1.44772 300 1 299.552 1 299V234Z" />
          <path className="device-frame__edge" d="M1 319C1 318.448 1.44772 318 2 318H3.5V385H2C1.44772 385 1 384.552 1 384V319Z" />
          <path className="device-frame__edge" d="M430 279H432C432.552 279 433 279.448 433 280V384C433 384.552 432.552 385 432 385H430V279Z" />
          <path className="device-frame__shell" d="M6 74C6 35.3401 37.3401 4 76 4H356C394.66 4 426 35.3401 426 74V808C426 846.66 394.66 878 356 878H76C37.3401 878 6 846.66 6 808V74Z" />
        </g>
        <path className="device-frame__edge" opacity="0.5" d="M174 5H258V5.5C258 6.60457 257.105 7.5 256 7.5H176C174.895 7.5 174 6.60457 174 5.5V5Z" />
        <defs>
          <mask id={mask} maskUnits="userSpaceOnUse">
            <rect x="0" y="0" width={PHONE_WIDTH} height={PHONE_HEIGHT} fill="white" />
            <rect x={SCREEN_X} y={SCREEN_Y} width={SCREEN_WIDTH} height={SCREEN_HEIGHT} rx={SCREEN_RADIUS} ry={SCREEN_RADIUS} fill="black" />
          </mask>
        </defs>
      </svg>
    </span>
  );
}
