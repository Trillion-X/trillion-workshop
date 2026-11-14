import React, { useEffect, useRef } from 'react';
import { paintFigure } from './paint-figure.mjs';
import '../../../screen-look/show/anatomy/figure.css';
import { ISO_CSS } from 'trillion-workshop/tools/screen-look/show/anatomy/iso-style.mjs';

export type AnatomyFigureValue = { svg: string; label?: string };
const sourceViewBoxes = new WeakMap<SVGSVGElement, string | null>();

// The Screen Look sheet is also used by standalone pages. Scope its class rules
// when the passive host embeds a figure beside unrelated lesson controls.
const isolateFigureCss = (css: string) => css.replace(/(^|[{}])\s*((?:\.[\w-][^{},]*)+(?:,\s*\.[\w-][^{},]*)*)\s*\{/g,
  (_rule, boundary: string, selectors: string) => `${boundary}${selectors.split(',').map((selector: string) => {
    const clean = selector.trim();
    return clean === '.iso' || clean.startsWith('.iso[')
      ? `.anatomy-figure-frame${clean}`
      : `.anatomy-figure-frame ${clean}`;
  }).join(',')} {`);

/** A passive accessible host for the Anatomy renderer's validated SVG. */
export function AnatomyFigure({ figure, label, className = '', appearanceCss = '', viewport }: {
  figure: AnatomyFigureValue;
  label?: string;
  className?: string;
  appearanceCss?: string;
  viewport?: [number, number, number, number];
}) {
  if (typeof appearanceCss !== 'string' || /<|@import/i.test(appearanceCss) || /url\s*\(/i.test(appearanceCss.replace(/url\(\s*(['"]?)#[\w-]+\1\s*\)/gi, ''))) throw new TypeError('Figure appearance must be local CSS');
  if (viewport && (viewport.length !== 4 || !viewport.every(Number.isFinite) || viewport[2] <= 0 || viewport[3] <= 0)) throw new TypeError('Invalid figure viewport');
  const viewBox = viewport?.join(' ');
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (host.current) {
      paintFigure(host.current, figure);
      const svg = host.current.querySelector('svg');
      svg?.setAttribute('aria-hidden', 'true');
      if (svg) {
        if (!sourceViewBoxes.has(svg)) sourceViewBoxes.set(svg, svg.getAttribute('viewBox'));
        const camera = viewBox ?? sourceViewBoxes.get(svg);
        if (camera === null || camera === undefined) svg.removeAttribute('viewBox');
        else svg.setAttribute('viewBox', camera);
      }
    }
  }, [figure?.svg, viewBox]);

  const accessibleLabel = label ?? figure?.label;
  if (!accessibleLabel?.trim()) throw new TypeError('An anatomy figure needs an accessible label');
  return <div className="iso anatomy-figure-frame" data-theme="light" role="img" aria-label={accessibleLabel}>
    <style>{isolateFigureCss(ISO_CSS + '\n' + appearanceCss)}</style>
    <div ref={host} className={`anatomy-figure ${className}`.trim()} aria-hidden="true" />
  </div>;
}
