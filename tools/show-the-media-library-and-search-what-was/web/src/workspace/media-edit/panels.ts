// src/workspace/media-edit/panels.ts
//
// ===== MEDIA EDITOR PANELS: ONE LINE PER PANEL =====
// Every side panel in the media editor is one row here, in display order.
// To add a panel: write `src/workspace/media-edit/<your-panel>.tsx` exporting a
// `definePanel({...})` row (see panel-types.ts), import it, and add it below.
// Do not edit media-edit-screen.tsx to add a panel.
// Give your panel's own outer element `data-media-edit-panel="<your id>"`: the live proof photographs every
// panel by it (the editor's own areas carry sources, preview, tools, timeline, text, effects and audio).

import type { MediaEditPanel } from './panel-types';
import { transcribePanel } from './transcribe-panel';
import { lookPanel } from './look-panel';
import { captionsPanel } from './captions-panel';
import { sendToEditorPanel } from './send-to-editor-row';
import { layersPanel } from './layers-panel';
import { makePanel } from './make-panel';

export const PANELS: MediaEditPanel[] = [
  transcribePanel,
  lookPanel,
  captionsPanel,
  sendToEditorPanel,
  layersPanel,
  makePanel,
];
