// tools/show-published-clips/show/ClipStrip.tsx
//
// PURPOSE
//   The screen of tool:read-a-strip-of-published-clips: one strip of clip stills in a row that scrolls sideways and is never a grid. A
//   still is shown; the video starts on tap. A page and an AI app draw the same strip from the same answer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. View is pure: no fetch and no window while it renders. Which clips are playing is the host's: it passes props.playing
//      (clip ids) and wires props.onPlay(id), or reads data-clip-play="<id>" on each still's button.
//   2. A clip with no still or no video is not drawn; no clips at all draws nothing.
//   3. A still opens as a video in place: the same frame, autoplaying with the player's own controls, the still gone.
//   4. Everything drawn is a shared part (Text, MediaFrame, Button); no raw HTML and no inline styling.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { videoAddress } from '../../compare-two-movements-side-by-side/show/video-address.ts';
import { Button } from '../../ui/show/button/Button.tsx';
import { MediaFrame } from '../../ui/show/media-frame/MediaFrame.tsx';
import { Text } from '../../ui/show/text/Text.tsx';
import type { Clip, Clips } from '../do-work/clips.ts';

export type ClipStripProps = Clips & {
  /** The heading over the strip; none when absent. */
  title?: string;
  /** Put in front of a still or video value that is a storage key. */
  filesBase?: string;
  /** Ids of the clips playing now. */
  playing?: readonly string[];
  /** Called with the clip's id when its still is tapped; the host adds it to `playing`. */
  onPlay?: (id: string) => void;
  /** The words of a still's button, with the clip's title after them when it has one. */
  playLabel?: string;
};

function Card({ clip, filesBase, playing, onPlay, playLabel }: { clip: Clip; filesBase?: string; playing: boolean; onPlay?: (id: string) => void; playLabel: string }) {
  const label = clip.title === '' ? playLabel : `${playLabel}: ${clip.title}`;
  return (
    <Text as="article" className="m-0 w-[min(86vw,640px)] shrink-0 snap-start" data-clip={clip.id}>
      {playing
        ? <MediaFrame url={videoAddress(clip.video, filesBase)} mediaType="video/mp4" label={clip.title || playLabel} autoPlay playsInline />
        : (
          <Button variant="ghost" className="block h-auto w-full p-0" aria-label={label} data-clip-play={clip.id} onClick={onPlay ? () => onPlay(clip.id) : undefined}>
            <MediaFrame url={videoAddress(clip.still, filesBase)} mediaType="image/jpeg" label={clip.title || playLabel} />
          </Button>
        )}
    </Text>
  );
}

export function View({ clips, title, filesBase, playing = [], onPlay, playLabel = 'Play' }: ClipStripProps) {
  if (clips.length === 0) return null;
  return (
    <Text as="section" className="grid gap-4" data-clip-strip>
      {title === undefined || title === '' ? null : <Text as="h2" variant="heading-lg">{title}</Text>}
      <Text as="div" className="flex snap-x snap-mandatory flex-nowrap gap-3 overflow-x-auto pb-2">
        {clips.map(clip => <Card key={clip.id} clip={clip} filesBase={filesBase} playing={playing.includes(clip.id)} onPlay={onPlay} playLabel={playLabel} />)}
      </Text>
    </Text>
  );
}
