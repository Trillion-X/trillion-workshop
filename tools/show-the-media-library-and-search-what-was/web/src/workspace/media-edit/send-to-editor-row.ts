// src/workspace/media-edit/send-to-editor-row.ts
//
// The Send to editor panel's row in panels.ts. Its body (./send-to-editor.tsx, with the file drop zone) arrives the first
// time the panel is opened, so the media editor opens without it.
import { later } from '../../../parts/ui/show/load-later/later';
import { definePanel } from './panel-types';
import type { Choices } from './send-to-editor';

export const sendToEditorPanel = definePanel<Choices>({
  id: 'send-to-editor', label: 'Send to editor', icon: 'Send',
  Panel: later(() => import('./send-to-editor'), module => module.SendToEditor),
});
