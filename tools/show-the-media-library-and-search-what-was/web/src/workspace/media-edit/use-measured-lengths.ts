// src/workspace/media-edit/use-measured-lengths.ts
//
// A clip opened without a known length (a file an AI saved, which the library has not measured) gets its length
// from the file itself, and that length is kept as the file's `duration` fact so Media and every AI see it too.
//
// Invariants
//   1. The length is the browser decoder's measured duration (parts/media-playback measure-media-length); a file that
//      cannot say keeps `end: null` and the person is told, never a guessed number.
//   2. Each file is measured once per editor, however many clips play it.

import React from 'react';
import { measureMediaLength } from '../../../parts/media-playback/read-data/measure-media-length';
import { fileResults } from '../api';
import type { MediaEditClip } from './panel-types';

export function useMeasuredLengths(clips: readonly MediaEditClip[], apply: (identity: string, seconds: number) => void, tell: (text: string) => void): boolean {
  const asked = React.useRef(new Set<string>());
  const waiting = clips.filter(clip => clip.end === null);
  React.useEffect(() => {
    for (const clip of waiting) {
      if (asked.current.has(clip.identity)) continue;
      asked.current.add(clip.identity);
      void measureMediaLength(clip.bytes, clip.mediaKind === 'audio' || clip.mediaType.startsWith('audio/') ? 'audio' : 'video').then(seconds => {
        if (seconds === null) { tell(`The length of ${clip.name} could not be read from its file.`); return; }
        apply(clip.identity, seconds);
        void fileResults.merge(clip.identity, { kind: 'facts', value: { duration: seconds }, produced_by: 'media editor' }).catch(() => undefined);
      });
    }
  }, [waiting.map(clip => clip.identity).join('|')]);
  return waiting.length > 0;
}
