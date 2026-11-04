// packages/screen-look/show/scroll-edge-style.ts
//
// PURPOSE
//   The one scroll-edge fade appearance. Any scroll container that carries
//   the class `bf-scroll-fade` fades each edge that has more content past it.
//   How much content lies past each edge is measured by
//   ui/show/scrollable-surface/scroll-fade.ts, which writes four custom
//   properties; this file only turns them into a mask.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A mask, never a shadow: the fade shows whatever sits behind the list.
//   2. Each edge is one custom property, --scroll-fade-top/right/bottom/left,
//      a length from 0 (nothing past this edge) to --scroll-fade-size.
//   3. --scroll-fade-inset-top keeps a band at the top fully opaque, so a
//      sticky header row stays readable and the fade starts under it.
//   4. Keyboard focus, reduced transparency and forced colors remove the mask.
//   5. A viewport draws no scrollbar: the fade says there is more, and a bar
//      showing while a list scrolls is noise the person asked to be rid of.

/** Shared scroll-edge appearance; the amount per edge is measured by ui/scroll-fade. */
export const SCROLL_EDGE_STYLE = `
.bf-scroll-viewport { min-height:0; min-width:0; overflow:auto; overscroll-behavior:contain; scrollbar-width:none; }
.bf-scroll-viewport::-webkit-scrollbar { display:none; }
.bf-scroll-fade {
  --scroll-fade-size:24px; --scroll-fade-inset-top:0px;
  --scroll-fade-top:0px; --scroll-fade-right:0px; --scroll-fade-bottom:0px; --scroll-fade-left:0px;
  -webkit-mask-image:linear-gradient(to bottom,#000 0,#000 var(--scroll-fade-inset-top),transparent var(--scroll-fade-inset-top),#000 calc(var(--scroll-fade-inset-top) + var(--scroll-fade-top)),#000 calc(100% - var(--scroll-fade-bottom)),transparent 100%),linear-gradient(to right,transparent 0,#000 var(--scroll-fade-left),#000 calc(100% - var(--scroll-fade-right)),transparent 100%);
  mask-image:linear-gradient(to bottom,#000 0,#000 var(--scroll-fade-inset-top),transparent var(--scroll-fade-inset-top),#000 calc(var(--scroll-fade-inset-top) + var(--scroll-fade-top)),#000 calc(100% - var(--scroll-fade-bottom)),transparent 100%),linear-gradient(to right,transparent 0,#000 var(--scroll-fade-left),#000 calc(100% - var(--scroll-fade-right)),transparent 100%);
  -webkit-mask-composite:source-in; mask-composite:intersect;
}
.bf-scroll-fade:focus-visible { outline:2px solid var(--accent-primary,currentColor); outline-offset:-2px; -webkit-mask-image:none; mask-image:none; }
@media (prefers-reduced-transparency:reduce), (forced-colors:active) { .bf-scroll-fade { -webkit-mask-image:none !important; mask-image:none !important; } }
`;
