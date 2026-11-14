// src/workspace/action-picker.ts
//
// PURPOSE
//   The "Your AI will" picker over the person's saved actions (each folder its own menu), for any box that sends to their
//   AI: the message box (src/workspace/send-choices.ts), the tray (src/workspace/tray-screen.tsx) and the menu rows
//   (src/workspace/menu-rows.tsx). Kept apart from send-choices.ts so the page's first load carries only the picker, not
//   the message box's choices, outbox wiring and words.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The actions are the person's own list; nothing here names an action.
//   2. Words are DATA (send-choices.json, `action`).

import type { ComposerPicker, ComposerPickerOption } from '../../parts/ui/show/composer';
import { actionTree } from '../action-folders.mjs';
import words from './send-choices.json';

/** One of the person's saved actions, and a folder of them (src/agents.mjs saved instructions). */
export type Action = { id: string; label: string; words: string; folder: string | null };
export type Folder = { id: string; label: string; folder: string | null };
type Node = { action: Action } | { folder: Folder; rows: Node[] };

/** The person's actions as the menu offers them: each folder a menu of what is inside it, in the list's order. */
const actionOptions = (nodes: Node[]): ComposerPickerOption[] => nodes.map(node => ('action' in node
  ? { value: node.action.id, label: node.action.label, icon: words.action.action_icon }
  : { value: `folder:${node.folder.id}`, label: node.folder.label, icon: words.action.folder_icon, options: actionOptions(node.rows) }));

/** The "Your AI will" picker over the person's saved actions (each folder its own menu), for any box that sends to
 *  their AI: the message box here and the tray (src/workspace/tray-screen.tsx). `onCreate` makes a new action from
 *  typed words. */
export function actionPicker(saved: { actions: Action[]; folders?: Folder[] }, action: string | null, onChange: (action: string | null) => void, onCreate?: (name: string) => void): ComposerPicker {
  return {
    id: 'action', label: words.action.label, icon: words.action.icon, many: false, chosen: action ? [action] : [],
    onChange: chosen => onChange(chosen[0] ?? null),
    options: actionOptions(actionTree({ actions: saved.actions, folders: saved.folders ?? [] }) as Node[]),
    search: { placeholder: words.action.search, ...(onCreate ? { create: { label: words.action.create, onCreate } } : {}) },
  };
}
