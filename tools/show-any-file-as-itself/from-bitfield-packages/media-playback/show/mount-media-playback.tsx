import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { FloatingMaterialFrame, mountReactSurface } from '../../../../ui';
import { MediaPlaybackSurface, type TimedTextSegment } from '../../../show/MediaPlaybackSurface';
import { readMediaTranscriptSegments } from '../read-data/read-media-transcript';
import { readSurfaceMedia } from '../read-data/read-surface-media';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

// Generic handler over self-describing DATA (L090): ANY media whose surface input carries
// `timed_text_segments` (co-located on the media object, or as a sibling of it) lights up the
// caption reader plus the on-video caption overlay. The mount never enumerates which videos
// have captions, so the presence of the segments IS the switch. Segments live on the media
// object (self-describing media), but `readSurfaceMedia` intentionally strips non-string media
// fields, so the segments are read HERE from the raw input before that adapter runs. Shape is
// TimedTextSegment { id, text, start_ms?, end_ms?, words? }; any row without a string `text` is
// dropped so a malformed row never breaks playback.
function readTimedTextSegments(input: Record<string, unknown>): TimedTextSegment[] | undefined {
  const media =
    input.media && typeof input.media === 'object' && !Array.isArray(input.media)
      ? (input.media as Record<string, unknown>)
      : undefined;
  const raw = media?.timed_text_segments ?? input.timed_text_segments;
  if (!Array.isArray(raw)) return undefined;
  const segments = raw.filter(
    (segment): segment is TimedTextSegment =>
      !!segment && typeof segment === 'object' && typeof (segment as { text?: unknown }).text === 'string',
  );
  return segments.length ? segments : undefined;
}

export function MediaPlaybackMaterial({ props }: { props: Record<string, unknown> }) {
  const surfaceInput =
    props.surfaceInput && typeof props.surfaceInput === 'object'
      ? (props.surfaceInput as Record<string, unknown>)
      : props.surface_input && typeof props.surface_input === 'object'
        ? (props.surface_input as Record<string, unknown>)
        : {};
  const media = readSurfaceMedia(surfaceInput.media) ?? readSurfaceMedia(surfaceInput);
  const transcriptRecords = useBitfieldData('transcript-search-records');
  const legacyTranscriptRecords = useBitfieldData('screen-ready-records');
  const timedTextSegments = readTimedTextSegments(surfaceInput)
    ?? readMediaTranscriptSegments(transcriptRecords, media)
    ?? readMediaTranscriptSegments(legacyTranscriptRecords, media);
  // Whether to render the developer-facing metadata chrome (eyebrow source_kind plus the
  // Source/Duration/Status list plus a duplicate title) is DATA on the surface, not fixed here.
  // A member watching a course video wants the player, not backend metadata, so that surface
  // passes show_frame_chrome:false. Defaults true for back-compat with existing callers.
  const showFrameChrome = surfaceInput.show_frame_chrome !== false;
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <MediaPlaybackSurface
        media={media}
        allowEmbeddedDocument
        showFrameChrome={showFrameChrome}
        timedTextSegments={timedTextSegments}
      />
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <MediaPlaybackMaterial props={props} />);
}
