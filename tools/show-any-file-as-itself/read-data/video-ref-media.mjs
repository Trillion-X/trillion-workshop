// tools/show-any-file-as-itself/read-data/video-ref-media.mjs
//
// PURPOSE
//   The media record the shared player draws for a video ref (ShowRef's video face). The ref's address is the playback
//   address and its kind is video, so the player's own controls (play, seek, volume, speed, fullscreen) draw it, the same
//   as every other video the player shows. It reads nothing and fetches nothing.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

/** { id, label, source_kind, playback_url } for one video address. */
export function videoRefMedia(src, label) {
  return { id: src, label, source_kind: 'video', playback_url: src };
}
