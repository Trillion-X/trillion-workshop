// parts/screen-look/show/use-screen-look-choices.ts
//
// PURPOSE
//   What every look chooser does, whatever it looks like (the Screen look card grid, the small Look popover, the corner
//   button): wear a look, keep the look on this device only or follow the account again, open the editor on the worn
//   look or on a copy of it, save an edited look and wear it, and show or hide the Look button in the corner of every
//   screen (the person's preference CORNER_LOOK_BUTTON_PREFERENCE, read by ScreenLookSurface). The choosers only
//   draw; this is the one behaviour.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A saved look is always kept among the person's own looks on the account; where it is worn (this device or the
//      account) follows the device switch (do-work/device-screen-look.ts wearScreenLook).
//   2. A failed save or wear says so in plain words and leaves the look that was showing. Saving and wearing report
//      separately: a look that saved is never called unsaved because wearing it failed.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspacePreference, writeWorkspacePreference } from '#workspace-records';
import { notify } from '../../ui/show/coss/notifications';
import { followAccountScreenLook, keepScreenLookOnThisDevice, wearScreenLook } from '../do-work/device-screen-look';
import { saveOwnScreenLook } from '../do-work/screen-look-records';
import type { EditableScreenLookTheme } from '../read-data/read-editable-screen-look-themes';
import { previewScreenLook } from './ApplyCurrentScreenLook';
import { createEditableScreenLookThemeDraft } from '../read-data/editable-screen-look-draft';
import { FOLLOW_SYSTEM, pickMode, pressLook } from '../read-data/look-follow-system';
import { useScreenLooks, type ScreenLooks } from './use-screen-looks';

/** The person's preference that shows the small Look button in the corner of every screen (ScreenLookSurface). */
export const CORNER_LOOK_BUTTON_PREFERENCE = 'screen-look.corner-button';

export type ScreenLookEditing = { title: string; draft: EditableScreenLookTheme } | null;

export type ScreenLookChoices = ScreenLooks & {
  editing: ScreenLookEditing;
  /** Font faces the person's looks wear, offered in the editor. */
  fontFaces: readonly string[];
  pending: boolean;
  cornerButton: boolean;
  showCornerButton: (show: boolean) => void;
  choose: (theme: EditableScreenLookTheme) => void;
  /** Sets the theme mode (light, dark or Automatic, look-follow-system.json). */
  setMode: (mode: string) => void;
  setOnThisDevice: (onThisDevice: boolean) => void;
  editChosen: () => void;
  copyChosen: () => void;
  changeDraft: (draft: EditableScreenLookTheme) => void;
  cancelEditing: () => void;
  saveEditing: () => Promise<void>;
};

export function useScreenLookChoices(): ScreenLookChoices {
  const looks = useScreenLooks();
  const { chosen, onThisDevice } = looks;
  const [editing, setEditing] = useState<ScreenLookEditing>(null);
  const [pending, setPending] = useState(false);
  const cornerButton = useWorkspacePreference<boolean>(CORNER_LOOK_BUTTON_PREFERENCE) === true;

  // The page is the editor's preview: while a look is being edited every change is painted on the whole page at
  // once, and closing the editor hands the page back to its painter (the worn look, or the look over the day).
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) { previewScreenLook(editing.draft); wasEditing.current = true; }
    else if (wasEditing.current) { previewScreenLook(null); wasEditing.current = false; }
  }, [editing]);

  const fontFaces = useMemo(
    () => [...new Set(looks.looks.flatMap(theme => theme.tokens.filter(token => token.kind === 'text').map(token => String(token.value))))],
    [looks.looks],
  );

  const showCornerButton = useCallback((show: boolean) => {
    writeWorkspacePreference(CORNER_LOOK_BUTTON_PREFERENCE, show).catch(() => notify('This could not be saved. Try again.', { kind: 'error' }));
  }, []);

  const { follow, looks: held } = looks;
  const choose = useCallback((theme: EditableScreenLookTheme) => {
    wearScreenLook(theme.id, onThisDevice).catch(() => notify('This look could not be saved. Your earlier look is still kept.', { kind: 'error' }));
    // With a theme mode set, the look pressed is kept for its own kind (and a fixed mode follows that kind).
    if (follow) writeWorkspacePreference(FOLLOW_SYSTEM.record_key, pressLook(follow, theme)).catch(() => notify(FOLLOW_SYSTEM.words.failed, { kind: 'error' }));
  }, [onThisDevice, follow]);

  const setMode = useCallback((mode: string) => {
    writeWorkspacePreference(FOLLOW_SYSTEM.record_key, pickMode(follow, mode, held, chosen)).catch(() => notify(FOLLOW_SYSTEM.words.failed, { kind: 'error' }));
  }, [follow, held, chosen]);

  const setOnThisDevice = useCallback((keep: boolean) => {
    if (keep) keepScreenLookOnThisDevice(chosen.id);
    else followAccountScreenLook();
  }, [chosen.id]);

  const saveEditing = useCallback(async () => {
    if (!editing) return;
    const theme = { ...editing.draft, name: editing.draft.name.trim() || 'My look' };
    setPending(true);
    // Saving and wearing are two steps with two outcomes: a look that saved stays saved (and the editor closes)
    // even when putting it on fails, and that failure offers a retry of the wearing alone.
    try {
      await saveOwnScreenLook(theme);
    } catch {
      setPending(false);
      notify('This look could not be saved. Try again.', { kind: 'error' });
      return;
    }
    setEditing(null);
    const wear = () => wearScreenLook(theme.id, onThisDevice);
    try {
      await wear();
      notify(`Saved ${theme.name}.`, { kind: 'done' });
    } catch {
      notify(`Saved ${theme.name}, but it could not be put on.`, {
        kind: 'error',
        actions: [{ id: 'wear', label: 'Put it on', onAction: () => wear().then(
          () => notify(`Wearing ${theme.name}.`, { kind: 'done' }),
          () => notify(`${theme.name} could not be put on. Your earlier look is still kept.`, { kind: 'error' }),
        ) }],
      });
    } finally {
      setPending(false);
    }
  }, [editing, onThisDevice]);

  return {
    ...looks,
    editing,
    fontFaces,
    pending,
    cornerButton,
    showCornerButton,
    choose,
    setMode,
    setOnThisDevice,
    editChosen: () => setEditing({ title: `Edit ${chosen.name}`, draft: chosen }),
    copyChosen: () => setEditing({ title: 'Create a look', draft: createEditableScreenLookThemeDraft(chosen) }),
    changeDraft: draft => setEditing(current => (current ? { ...current, draft } : current)),
    cancelEditing: () => setEditing(null),
    saveEditing,
  };
}
