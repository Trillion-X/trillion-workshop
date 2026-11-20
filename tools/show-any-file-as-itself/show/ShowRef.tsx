// tools/show-any-file-as-itself/show/ShowRef.tsx
//
// PURPOSE
//   Draws one ref as itself, at the width of its surface: a picture at its own proportions, a video with its controls (it
//   plays), a sound with its controls, and a web page in a frame that scrolls and takes clicks. Which of these it is comes
//   from classifyRef (read-data/classify-ref.mjs) and from nothing else, so a caller never branches on a kind. Every ref
//   also gets a line with its label and an "Open in a new tab" link, so the thing is still reachable where a page refuses
//   to be drawn inside another page.
//   The element is created only when this component mounts: a caller that draws it inside a closed row loads nothing until
//   the row is opened. Pictures and sounds load lazily; a video loads its length only, never the picture of its first frame
//   beyond its metadata until the person presses play (preload is metadata). A frame runs its page without the page's
//   origin (no same-origin access): a stored page can script itself but cannot read this page.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { classifyRef } from '../read-data/classify-ref.mjs';
import { videoRefMedia } from '../read-data/video-ref-media.mjs';
import { MediaPlaybackSurface } from './lazy-playback-surface';

const FRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';

export function ShowRef({ source, label }: { source: string; label: string }) {
  const shown = classifyRef(source);
  const media = 'block w-full rounded-xl';
  return (
    <figure className="m-0 flex flex-col gap-2">
      {shown.kind === 'image' && <img src={shown.src} alt={label} loading="lazy" className={`${media} h-auto max-h-[480px] object-contain`} />}
      {shown.kind === 'video' && <MediaPlaybackSurface media={videoRefMedia(shown.src, label)} showFrameChrome={false} preload="metadata" />}
      {shown.kind === 'audio' && <audio src={shown.src} controls preload="none" aria-label={label} className="w-full" />}
      {shown.kind === 'page' && <iframe src={shown.src} title={label} sandbox={FRAME_SANDBOX} loading="lazy" referrerPolicy="no-referrer" className={`${media} h-[480px] border`} />}
      {shown.kind === 'unsupported' && <p className="m-0 text-[13px] leading-5 break-all">This address can not be opened here: {shown.src}</p>}
      <figcaption className="flex items-center gap-3 text-[12px] leading-5">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {shown.kind !== 'unsupported' && <a href={shown.src} target="_blank" rel="noopener noreferrer" className="flex-none underline underline-offset-2">Open in a new tab</a>}
      </figcaption>
    </figure>
  );
}
