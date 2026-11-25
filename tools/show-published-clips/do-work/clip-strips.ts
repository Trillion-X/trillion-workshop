// tools/show-published-clips/do-work/clip-strips.ts
//
// PURPOSE
//   Which of the published clips (tool:read-published-clips's answer) go in which strip of show/ClipStrips.tsx, and the words a
//   strip's heading has when the page row gives none.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no I/O. A clip is in a strip only with every still it shows; the strips keep the answer's order.
//   2. A comparison of two different people is in no strip here (the page's side-by-sides show it).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
export type ClipSide = { person?: string | null; day?: string | null; picture_url?: string | null };
export type PublishedClip = {
  id: string;
  moment?: string | null;
  kind?: string | null;
  aspect?: string | null;
  cut_url?: string | null;
  picture_url?: string | null;
  pair?: { left: ClipSide; right: ClipSide };
};
export type StripName = 'before_after' | 'reels';

export const DEFAULT_TITLES: Record<StripName, string> = { before_after: 'Before and after', reels: 'Reels' };

const hasStills = (clip: PublishedClip) => (clip.pair ? [clip.pair.left, clip.pair.right].every(side => Boolean(side?.picture_url)) : Boolean(clip.picture_url));

/** The clips of each strip, in the order the answer gave them; a clip with a missing still is left out before any strip is made. */
export function stripsOf(clips: readonly PublishedClip[]): Record<StripName, PublishedClip[]> {
  const shown = clips.filter(hasStills);
  return {
    before_after: shown.filter(clip => clip.pair && clip.pair.left.person === clip.pair.right.person && clip.pair.left.day !== clip.pair.right.day),
    reels: shown.filter(clip => !clip.pair && (clip.kind === 'reel' || clip.moment === 'reel') && clip.aspect === '9x16'),
  };
}

