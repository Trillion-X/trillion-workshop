// parts/media-playback/show/lazy-playback-surface.ts
//
// Purpose: the shared player as a file preview, a media frame or a recorder's review draws it. Its body
// (./MediaPlaybackSurface.tsx with its controls, timed text and range reader, about 60 kB) arrives the first time a
// player is drawn, so a screen that can show a video but opens on a list never carries it.
//
// Non-negotiable invariants:
// - It is ./MediaPlaybackSurface.tsx's MediaPlaybackSurface with the same props; until the body arrives it draws
//   nothing (parts/ui/show/load-later).
// - A caller that needs the player's other exports (BrowserMediaPlayer, types) imports ./MediaPlaybackSurface.tsx.
import { later } from '../../ui/show/load-later/later';

export const MediaPlaybackSurface = later(() => import('./MediaPlaybackSurface'), module => module.MediaPlaybackSurface);
