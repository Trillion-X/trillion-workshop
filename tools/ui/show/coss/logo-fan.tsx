// parts/ui/show/coss/logo-fan.tsx
//
// PURPOSE
//   A picture made of marks: one mark raised in the middle and the others fanned out on both sides of it, tilted a
//   little more the further they sit from the middle, with an optional line under them. After Higgsfield's "MCP for
//   any AI" page (mobbin.com/screens/93b4c668-a280-4a11-961a-1f5d13601b56), which leads with its own mark among the
//   AI apps it works in. Each mark is the shared Logo, so a picture that does not load shows a quiet app glyph.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file knows no company or product: every picture, name and the line are the caller's DATA.
//   2. The picture is decoration beside words that say the same thing, so the marks are hidden from screen readers
//      and only the line is read.
//   3. How far each mark sits and tilts is its place in the row (--fan-offset), never a fixed list of positions, so
//      any number of marks fans out evenly.

import * as React from 'react';
import { Logo } from './logo';

export type LogoFanMark = { src?: string; label: string };
export type LogoFanDescription = { center: LogoFanMark; around: LogoFanMark[]; caption?: string };

export function LogoFan({ fan }: { fan: LogoFanDescription }) {
  const half = Math.ceil(fan.around.length / 2);
  const marks = [...fan.around.slice(0, half), fan.center, ...fan.around.slice(half)];
  const middle = half;
  return (
    <figure className="logo-fan">
      <div className="logo-fan-row" aria-hidden>
        {marks.map((mark, index) => (
          <span key={`${index}:${mark.label}`} className="logo-fan-mark" data-center={index === middle ? '' : undefined} style={{ '--fan-offset': index - middle } as React.CSSProperties}>
            <Logo src={mark.src} name={mark.label} className="logo-fan-logo" />
          </span>
        ))}
      </div>
      {fan.caption ? <figcaption className="logo-fan-caption">{fan.caption}</figcaption> : null}
    </figure>
  );
}
