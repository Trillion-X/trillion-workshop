// tools/show-published-clips/show/ClipStrips.tsx
//
// PURPOSE
//   The published clips of a pursuit as a page draws them under its other sections: one strip per kind, each a row that scrolls
//   sideways and is never a grid. A before-and-after strip (a comparison whose two sides are the same person on different days)
//   shows each card as its two stills side by side with the person and day under each, and plays the one combined render across
//   the card when tapped; a reel strip (a single clip of 9:16, only) shows each cover at one fixed height and plays the file when
//   tapped. The answer is tool:read-published-clips's: { clips: [{ id, moment, kind, aspect, cut_url, picture_url, pair? }] }.
//   A page row places it with that tool and its own props (which strips, their titles).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A clip is drawn only with every still it shows (both sides of a pair, or the cover of a reel); a strip with no clip is not
//      drawn, and no clip at all draws nothing.
//   2. A still is shown first; the video starts on tap, in the same frame, with the player's controls. Which cards are playing is
//      this part's own state; nothing is fetched while it renders.
//   3. A comparison whose two sides are different people is not drawn here: the side-by-sides with a reference are the page's
//      PairShowcase. Strips are chosen by `strips` (before_after, reels), both when left out, in that order.
//   4. Built from the shared parts (SectionShell, TextColumn, StatementText, Text, MediaFrame, Button) and the screen look's
//      strip classes; no raw HTML, no inline styling beyond a title's `title_font` when the row names one.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React, { useState } from 'react';
import { Button } from '../../ui/show/button/Button.tsx';
import { MediaFrame } from '../../ui/show/media-frame/MediaFrame.tsx';
import { SectionShell, StatementText, Text, TextColumn } from '../../ui/show/marketing-page/MarketingPagePrimitives.tsx';
import { DEFAULT_TITLES, stripsOf, type ClipSide, type PublishedClip, type StripName } from '../do-work/clip-strips.ts';
import styles from '../../screen-look/show/adaptive-program-landing/ClipStrips.module.css';

export type ClipStripsProps = {
  clips?: readonly PublishedClip[];
  /** Which strips to draw, in this order; both when left out. */
  strips?: readonly StripName[];
  /** The heading over each strip. */
  titles?: Partial<Record<StripName, string>>;
  /** The font family of the headings when the page names one (else the look's display family). */
  title_font?: string;
  /** The words of a card's play button. */
  play_before_after?: string;
  play_reel?: string;
};

function Side({ side }: { side: ClipSide }) {
  return (
    <Text as="figure" className={styles.side}>
      <MediaFrame url={side.picture_url ?? ''} mediaType="image/jpeg" label="" className={styles.sideMedia} fill />
      <Text as="figcaption" className={styles.sideLabel}>{`${side.person ?? ''} · ${side.day ?? ''}`}</Text>
    </Text>
  );
}

function Card({ clip, playing, onPlay, label }: { clip: PublishedClip; playing: boolean; onPlay: (id: string) => void; label: string }) {
  if (clip.pair) {
    return (
      <Text as="article" className={`${styles.card} ${styles.cardPair}`} data-clip={clip.id}>
        {playing && clip.cut_url
          ? <MediaFrame url={clip.cut_url} mediaType="video/mp4" label={label} className={styles.cardVideo} autoPlay playsInline />
          : <Button type="button" variant="plain" className={styles.cardPlay} aria-label={label} data-clip-play={clip.id} onClick={() => onPlay(clip.id)}>
              <Text as="span" className={styles.sides}><Side side={clip.pair.left} /><Side side={clip.pair.right} /></Text>
            </Button>}
      </Text>
    );
  }
  return (
    <Text as="article" className={`${styles.card} ${styles.cardReel}`} data-clip={clip.id}>
      <Button type="button" variant="plain" className={styles.cardPlay} aria-label={label} data-clip-play={clip.id} onClick={() => onPlay(clip.id)}>
        {playing && clip.cut_url
          ? <MediaFrame url={clip.cut_url} mediaType="video/mp4" label={label} className={styles.reelMedia} autoPlay playsInline />
          : <MediaFrame url={clip.picture_url ?? ''} mediaType="image/jpeg" label="" className={styles.reelMedia} fill />}
      </Button>
    </Text>
  );
}

export function View({ clips = [], strips = ['before_after', 'reels'], titles = {}, title_font, play_before_after = 'Play this comparison', play_reel = 'Play this reel' }: ClipStripsProps) {
  const [playing, setPlaying] = useState<readonly string[]>([]);
  const onPlay = (id: string) => setPlaying(current => (current.includes(id) ? current : [...current, id]));
  const by = stripsOf(clips);
  const shown = strips.filter(name => by[name]?.length > 0);
  if (shown.length === 0) return null;
  return (
    <Text as="div" className={styles.strips}>
      {shown.map(name => (
        <SectionShell key={name} className={styles.strip} size="wide" paddingY="compact">
          <TextColumn><StatementText size="footer" lines={[[{ text: titles[name] ?? DEFAULT_TITLES[name] }]]} style={title_font ? { fontFamily: title_font } : undefined} /></TextColumn>
          <Text as="div" className={styles.row}>
            {by[name].map(clip => <Card key={clip.id} clip={clip} playing={playing.includes(clip.id)} onPlay={onPlay} label={name === 'reels' ? play_reel : play_before_after} />)}
          </Text>
        </SectionShell>
      ))}
    </Text>
  );
}

export { View as ClipStrips };
