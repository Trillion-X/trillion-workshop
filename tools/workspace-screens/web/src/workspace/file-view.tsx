// src/workspace/file-view.tsx
//
// PURPOSE
//   The script of the view an AI app draws when show_file names it (parts/ui/show/file-view-document): it paints the
//   view in Trillion's look, hears which file to show (file-view-bridge.mjs), and shows it with the one file preview
//   (FilePreview): a video or sound in the same shared player as the Files screen, read by range from the file's
//   address, and a picture, PDF, text or code file, or Office document the same way the file tab shows it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The look is the one every screen of the person's wears at this moment (read-data/look-now.ts), from the worn
//      look and look plan the result carries; until it arrives, the app's own starting look (looks.json). Nothing here
//      names a colour or font.
//   2. Every change in the view's own height is reported to the app, so the view is never cut off and never leaves
//      empty space below the file.
//   3. The page writes no markup: the document's host is filled by the shared loading rows (screen-state) until the
//      app names a file, then by the shared FilePreview.

import { applyChosenScreenLook } from '../../parts/screen-look/show/apply-chosen-screen-look';
import { applyScreenLookValues, resolveScreenLookCssVariables } from '../../parts/screen-look/show/ApplyCurrentScreenLook';
import { readEditableScreenLookThemes } from 'trillion-workshop/tools/screen-look/read-data/read-editable-screen-look-themes.ts';
import { LOOK_OVER_TIME, deviceZone, readLookPlan } from 'trillion-workshop/tools/screen-look/read-data/look-over-time.ts';
import { lookNow } from '../../parts/screen-look/read-data/look-now';
import { listenForShownFile } from '../../parts/ui/show/file-view-document/file-view-bridge.mjs';
import { FILE_VIEW_HOST_ID } from '../../parts/ui/show/file-view-document/file-view-document.mjs';
import { mountFilePreview } from '../../parts/ui/show/file-preview/mount-file-preview';
import { chooseFileViewer } from '../../parts/ui/show/file-preview/choose-file-viewer';
import { mountScreenState, releaseScreenState } from '../../parts/ui/show/screen-state';
import looks from './looks.json';

type WornNow = { worn: string; plan: unknown; looks: unknown[] };
type ShownFile = { url: string; media_type?: string | null; name?: string; first_text?: { text: string; shown_bytes: number; byte_length: number }; look?: WornNow };

applyChosenScreenLook(looks.themes, looks.start_with);
// The person's worn look and plan, once the result carries them; repainted each minute while the plan is on.
let repaint: number | undefined;
function wearPersonsLook(worn: WornNow) {
  const themes = readEditableScreenLookThemes(worn.looks);
  const chosen = themes.find(theme => theme.id === worn.worn);
  if (!chosen) return;
  const plan = readLookPlan(worn.plan);
  const paint = () => { const now = lookNow(themes, chosen, plan, new Date(), deviceZone(), resolveScreenLookCssVariables); applyScreenLookValues(now.id, now.values); };
  paint();
  window.clearInterval(repaint);
  if (plan?.on) repaint = window.setInterval(paint, LOOK_OVER_TIME.repaint_every_ms);
}
const host = document.getElementById(FILE_VIEW_HOST_ID) as HTMLElement;
host.className = 'trillion-file-view';
let preview: ReturnType<typeof mountFilePreview> | null = null;
// Until the app says which file to show, the view says it is opening one.
mountScreenState(host, { status: 'loading', label: 'Opening the file', layout: 'preview' });
const bridge = listenForShownFile(window, (file: ShownFile) => {
  if (file.look && Array.isArray(file.look.looks)) wearPersonsLook(file.look);
  // A text file's first part arrives with the result, so the view never has to read it from a frame that may refuse.
  const firstText = file.first_text && typeof file.first_text.text === 'string' ? { text: file.first_text.text, shownBytes: file.first_text.shown_bytes, byteLength: file.first_text.byte_length } : undefined;
  const props = { url: file.url, contentType: file.media_type ?? 'application/octet-stream', label: (file.name ?? '').split('/').pop() ?? '', autoPlay: false, firstText };
  host.dataset.viewer = chooseFileViewer({ contentType: props.contentType, name: props.label });
  if (preview) { preview.update(props); return; }
  releaseScreenState(host);
  preview = mountFilePreview(host, props);
}, {
  // The app handed no file (not found, the call failed, or nothing came): say so instead of loading forever.
  noFile: (reason: string | null) => mountScreenState(host, { status: 'empty', icon: 'FileX', title: 'This file could not be opened', description: reason ?? 'Ask again to show it.' }),
  content: host,
});
// The frame follows the view's own content, so a short file leaves no empty space below it.
new ResizeObserver(() => bridge.reportSize()).observe(host);
