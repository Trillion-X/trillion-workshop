// src/workspace/media-player.tsx
//
// PURPOSE
//   The Media screen's player, in place above the list: one recording, from its own bytes (media-playback.ts), at the second
//   the person asked for (a search hit's moment, or the start). It is the shared MediaFrame, which draws the element for the
//   recording's type; this file only seeks it once its length is known.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The recording's address and second are the caller's; nothing here names a file or a kind.
//   2. The second is set once the length is known (loadedmetadata), never before, so a seek is not dropped.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { useEffect, useRef } from 'react';
import { MediaFrame } from '../../../../ui/show/media-frame/MediaFrame';

export function MediaPlayer({ url, mediaType, label, at }: { url: string; mediaType: string; label: string; at: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // MediaFrame draws no controls; the person needs pause and seek on the recording they opened.
    video.controls = true;
    const seek = () => { video.currentTime = at; };
    video.addEventListener('loadedmetadata', seek);
    return () => video.removeEventListener('loadedmetadata', seek);
  }, [url, at]);
  return <MediaFrame url={url} mediaType={mediaType} label={label} videoRef={videoRef} autoPlay />;
}
