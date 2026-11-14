// parts/ui/show/caption-overlay/StyledCaption.tsx
//
// PURPOSE
// A caption drawn in its caption style, the same style row the burned-in subtitle is built from
// (parts/media-composition/read-data/caption-styles.json): its font, size, bold and italic, outline, its shadow
// (x, y, blur, spread, colour, opacity), where it sits on the frame, and, for a style that lights words up as they
// are said, the said words in one colour and the words still to come in another. Drawn over a video frame in the
// editor's player, and as a sample beside the style's inspector, so a change to the style shows the moment it is made.
//
// NON-NEGOTIABLE INVARIANTS
// 1. Sizes scale with the frame exactly as the subtitle does: a style's pixels are measured on a frame whose shorter
//    side is `measuredAt`, drawn in container units of the frame (its parent must be an inline-size container, as
//    `.live-composition-frame` and `CaptionSample` are).
// 2. A caption's bottom-centre sits at its position (its own x and y, else the style's), as in the subtitle.
// 3. A shadow with spread is drawn as a ring of soft shadows around the letters (CSS text shadows have no spread),
//    each faint enough that together they reach the style's opacity, so a halo reads as it does in the video.
// 4. Nothing here names a style; everything comes from the style row.

import React from 'react';

export interface CaptionShadowLook {
  readonly x: number;
  readonly y: number;
  readonly blur: number;
  readonly spread: number;
  readonly colour: string;
  readonly opacity: number;
}

/** The fields of a caption style row this draws. */
export interface CaptionLook {
  readonly font: string;
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly outline: number;
  /** null: no shadow. */
  readonly shadow: CaptionShadowLook | null;
  readonly colours: { readonly spoken: string; readonly upcoming: string; readonly outline: string };
  readonly position: { readonly x: number; readonly y: number };
  readonly reveal: string;
  readonly preview?: { readonly fonts?: readonly string[] };
}

export interface CaptionLookLine {
  readonly text: string;
  readonly x?: number;
  readonly y?: number;
  readonly words?: readonly { readonly text: string; readonly start: number; readonly end: number }[];
}

export interface StyledCaptionProps {
  readonly look: CaptionLook;
  readonly line: CaptionLookLine;
  /** The moment shown, on the same clock as the line's word times: words starting at or before it are said. */
  readonly time: number;
  /** The frame the caption sits on, in its own pixels (the video's width and height). */
  readonly frame: { readonly width: number; readonly height: number };
  /** The shorter frame side the style's pixels are measured on. */
  readonly measuredAt: number;
}

/** Spread rings: enough shadows around the letters that the halo reads round. */
const RING = 12;
/** About how many ring shadows overlap at any point of a halo, for the opacity each one gets. */
const OVERLAP = 4;

function rgba(hex: string, alpha: number): string {
  const code = /^#?([0-9a-f]{6})/i.exec(hex)?.[1] ?? '000000';
  const [r, g, b] = [0, 2, 4].map(at => Number.parseInt(code.slice(at, at + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000})`;
}

/** The CSS text shadows that draw a style's shadow, in the caller's length unit. */
export function captionShadowCss(shadow: CaptionShadowLook | null, length: (px: number) => string): string {
  if (!shadow || !(shadow.opacity > 0)) return 'none';
  if (!(shadow.spread > 0)) return `${length(shadow.x)} ${length(shadow.y)} ${length(shadow.blur)} ${rgba(shadow.colour, shadow.opacity)}`;
  const each = rgba(shadow.colour, 1 - Math.pow(1 - Math.min(1, shadow.opacity), 1 / OVERLAP));
  return Array.from({ length: RING }, (_, at) => {
    const angle = (at / RING) * Math.PI * 2;
    return `${length(shadow.x + Math.cos(angle) * shadow.spread)} ${length(shadow.y + Math.sin(angle) * shadow.spread)} ${length(shadow.blur)} ${each}`;
  }).join(', ');
}

/** One caption in its style, placed on its frame. */
export function StyledCaption({ look, line, time, frame, measuredAt }: StyledCaptionProps) {
  const scale = Math.min(frame.width, frame.height) / measuredAt;
  const length = (px: number) => `${Math.round(((px * scale) / frame.width) * 100 * 1000) / 1000}cqw`;
  const fonts = [look.font, ...(look.preview?.fonts ?? [])].filter((font, at, all) => font && all.indexOf(font) === at);
  const lit = look.reveal === 'karaoke';
  const words = line.words?.length ? line.words : null;
  return (
    <div
      aria-hidden="true"
      data-styled-caption=""
      style={{
        position: 'absolute',
        left: `${(line.x ?? look.position.x) * 100}%`,
        top: `${(line.y ?? look.position.y) * 100}%`,
        transform: 'translate(-50%, -100%)',
        width: 'max-content',
        maxWidth: '92%',
        textAlign: 'center',
        whiteSpace: 'normal',
        lineHeight: 1.2,
        pointerEvents: 'none',
        fontFamily: fonts.map(font => (/\s/.test(font) ? `"${font}"` : font)).join(', '),
        fontSize: length(look.size),
        fontWeight: look.bold ? 700 : 400,
        fontStyle: look.italic ? 'italic' : 'normal',
        color: look.colours.spoken,
        textShadow: captionShadowCss(look.shadow, length),
        ...(look.outline > 0 ? { WebkitTextStroke: `${length(look.outline * 2)} ${look.colours.outline}`, paintOrder: 'stroke fill' } : {}),
      }}
    >
      {words && lit
        ? words.map((word, at) => (
          <React.Fragment key={at}>
            <span style={{ color: time >= word.start ? look.colours.spoken : look.colours.upcoming }}>{word.text}</span>
            {at < words.length - 1 ? ' ' : null}
          </React.Fragment>
        ))
        : line.text}
    </div>
  );
}

/** How much of the frame's height a sample shows: a band around the caption, so the words are drawn at the frame's
 *  own scale across the sample's whole width. */
const SAMPLE_BAND = 0.3;
/** Where in the band the caption's bottom sits, from the band's top. */
const SAMPLE_BASELINE = 0.78;

/** A caption style's sample: the band of a frame (of the given shape and background) the caption sits in, the caption
 *  in its style with its words half said, so every change to the style is seen at once beside its inspector. */
export function CaptionSample({ look, text, frame, measuredAt, background }: {
  look: CaptionLook; text: string; frame: { width: number; height: number }; measuredAt: number; background: string;
}) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const words = tokens.map((token, at) => ({ text: token, start: at, end: at + 1 }));
  const band = frame.height * SAMPLE_BAND;
  return (
    <div
      data-caption-sample=""
      style={{ position: 'relative', aspectRatio: `${frame.width} / ${band}`, width: '100%', overflow: 'hidden', borderRadius: 'var(--radius-lg, 12px)', background }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          width: '100%',
          aspectRatio: `${frame.width} / ${frame.height}`,
          top: `${(SAMPLE_BASELINE - look.position.y / SAMPLE_BAND) * 100}%`,
          containerType: 'inline-size',
        }}
      >
        <StyledCaption look={look} line={{ text, words }} time={Math.max(0, Math.ceil(tokens.length / 2) - 1)} frame={frame} measuredAt={measuredAt} />
      </div>
    </div>
  );
}
