// tools/compare-two-movements-side-by-side/show/SideBySide.tsx
//
// PURPOSE
//   The screen of tool:read-movement-pairs: each pair of movements as two videos side by side under one title, with one play
//   button that plays both from their start marks. A page and an AI app draw the same screen from the same answer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. View is pure: no fetch and no window while it renders. Playing is the host's: the host reads the data attributes below
//      (the way media-playback's surface names its media) or wires props.onPlayBoth.
//        data-side-by-side="<pair id>"        on each pair
//        data-side-by-side-video="left|right|whole" on the box holding each video, with data-start-s="<second its play begins at>"
//        data-side-by-side-play="<pair id>"   on the one play button
//      Playing a pair sets the video inside each box to that box's data-start-s, then plays both.
//   2. A pair with one video that already holds both movements draws that one box (whole). Each video is muted and shows no controls of its own: the one play button is the pair's control.
//   3. A video's address is the row's value as given when it is a full address or starts with "/", else filesBase + value
//      (a storage key). No address is made here.
//   4. Everything drawn is a shared part (Text, Card, MediaFrame, Button); no raw HTML and no inline styling.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { Button } from '../../ui/show/button/Button.tsx';
import { MediaFrame } from '../../ui/show/media-frame/MediaFrame.tsx';
import { Text } from '../../ui/show/text/Text.tsx';
import type { Pair, Pairs } from '../do-work/pair.ts';
import { videoAddress } from './video-address.ts';

export type SideBySideProps = Pairs & {
  /** Put in front of a video value that is a storage key. */
  filesBase?: string;
  /** Called with the pair's id when its play button is pressed; the host plays both videos. */
  onPlayBoth?: (id: string) => void;
  /** The words of the play button. */
  playLabel?: string;
};

function Side({ pair, which, filesBase }: { pair: Pair; which: 'left' | 'right' | 'whole'; filesBase?: string }) {
  const side = (which === 'whole' ? pair.video : pair[which])!;
  return (
    <Text as="figure" className="m-0 grid min-w-0 gap-2" data-side-by-side-video={which} data-start-s={side.start_s}>
      <MediaFrame url={videoAddress(side.video, filesBase)} mediaType="video/mp4" label={side.label || pair.title} muted playsInline />
      {side.label === '' ? null : <Text as="figcaption" variant="caption" color="muted">{side.label}</Text>}
    </Text>
  );
}

export function View({ pairs, filesBase, onPlayBoth, playLabel = 'Play both' }: SideBySideProps) {
  return (
    <Text as="section" className="grid gap-8" data-side-by-side-list>
      {pairs.map(pair => (
        <Text as="article" key={pair.id} className="grid gap-3" data-side-by-side={pair.id}>
          {pair.title === '' ? null : <Text as="h2" variant="heading-lg">{pair.title}</Text>}
          <Text as="div" className={pair.video ? 'grid gap-3' : 'grid grid-cols-2 gap-3'}>
            {pair.video
              ? <Side pair={pair} which="whole" filesBase={filesBase} />
              : (
                <>
                  <Side pair={pair} which="left" filesBase={filesBase} />
                  <Side pair={pair} which="right" filesBase={filesBase} />
                </>
              )}
          </Text>
          <Text as="div">
            <Button variant="primary" data-side-by-side-play={pair.id} onClick={onPlayBoth ? () => onPlayBoth(pair.id) : undefined}>{playLabel}</Button>
          </Text>
          {pair.caption === '' ? null : <Text as="p" color="muted">{pair.caption}</Text>}
        </Text>
      ))}
    </Text>
  );
}
