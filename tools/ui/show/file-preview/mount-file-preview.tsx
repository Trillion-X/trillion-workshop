// packages/ui/show/file-preview/mount-file-preview.tsx
//
// PURPOSE
//   One file shown in a host element by FilePreview, the one preview of any file (a video or sound in the shared
//   player, a picture, a PDF, text or code, an Office document, else its card). For hosts that are not React (a
//   workspace screen, a view an AI app draws), which hand over an address and a media type and get the right viewer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The address is used as given: a player reads it by range, so a long file starts and seeks without being
//      downloaded whole. Nothing here fetches the bytes itself.
//   2. Which viewer is chosen is FilePreview's (file-viewers.json); nothing here names a kind of file.
//   3. `update` re-renders in place, so a new file replaces the old one without a remount of the host.

import { createRoot } from 'react-dom/client';
import { claimNode, releaseNode } from '../one-owner-per-node';
import { FilePreview, type FilePreviewProps } from './FilePreview';

export type MountedFilePreview = { update: (props: FilePreviewProps) => void; destroy: () => void };

export function mountFilePreview(host: HTMLElement, props: FilePreviewProps): MountedFilePreview {
  releaseNode(host);
  const root = createRoot(host);
  let destroyed = false;
  claimNode(host, () => {
    destroyed = true;
    root.unmount();
  });
  const render = (next: FilePreviewProps) => {
    if (!destroyed) root.render(<FilePreview key={next.url} {...next} />);
  };
  render(props);
  return { update: render, destroy: () => { if (!destroyed) releaseNode(host); } };
}
