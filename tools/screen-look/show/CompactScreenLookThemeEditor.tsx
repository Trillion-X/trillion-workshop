// parts/screen-look/show/CompactScreenLookThemeEditor.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The look editor Screen look opens in place: the look's name and every value of
// the look drawn as a control you can see and drag (a colour swatch with its
// wheel, a track with a small picture of the size or corner, fonts drawn in their
// own face), through the shared TuningPanel. The whole page is the preview: while
// the editor is open, use-screen-look-choices paints the draft on the page, so
// every move shows on the real screen at once. A small card of real controls in
// the draft's colours sits beside the values, for the Look popover where the page
// is partly covered.
//
// Its layout follows the width of the pane it sits in, never the window: the
// card above the values in a narrow pane or the popover, beside them in a wide one.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. The rows come from the look's own tokens and sections; nothing here names a
//    token. How a kind of value is drawn is look-tuning.json.
// 2. Every change goes to onDraftThemeChange at once; keeping the look is onSave.
// =============================================================================

import React, { useMemo } from 'react';
import { Button, Input, Text, TuningPanel, type TuningSection, type TuningSetting, type TuningValue } from '../../ui';
import LOOK_TUNING from '../look-tuning.json';
import {
  DEFAULT_EDITABLE_SCREEN_LOOK_THEME,
  type EditableScreenLookTheme,
  type EditableScreenLookToken,
} from '../read-data/read-editable-screen-look-themes';
import { resolveScreenLookPalette } from '../read-data/resolve-screen-look-palette';
import { replaceEditableScreenLookToken } from '../read-data/screen-look-record';

export interface CompactScreenLookThemeEditorProps {
  draftTheme: EditableScreenLookTheme;
  pending?: boolean;
  title?: string;
  /** Font faces worn by the person's other looks, offered beside look-tuning.json's faces. */
  fontFaces?: readonly string[];
  onDraftThemeChange: (theme: EditableScreenLookTheme) => void;
  onCancel: () => void;
  onSave: () => void;
}

const WIDGET_BY_KIND: Readonly<Record<string, string>> = LOOK_TUNING.widget_by_kind;

function sampleFor(token: EditableScreenLookToken): TuningSetting['sample'] {
  const variable = token.css_variable ?? '';
  return LOOK_TUNING.samples.find(row => variable.startsWith(row.css_variable_prefix))?.sample;
}

function settingFor(token: EditableScreenLookToken, fontFaces: readonly string[]): TuningSetting {
  const widget = WIDGET_BY_KIND[token.kind] ?? 'choices';
  const fixed = (LOOK_TUNING.choices_by_key as Record<string, readonly string[]>)[token.key];
  return {
    key: token.key,
    label: token.label,
    widget,
    min: token.min,
    max: token.max,
    step: token.step,
    unit: widget === 'slider' ? LOOK_TUNING.number_unit : undefined,
    sample: sampleFor(token),
    options: widget === 'choices' ? (fixed ?? fontFaces).map(face => ({ value: face, label: face })) : undefined,
    options_drawn_with: widget === 'choices' && !fixed ? LOOK_TUNING.text_choices_drawn_with : undefined,
    default_value: DEFAULT_EDITABLE_SCREEN_LOOK_THEME.tokens.find(row => row.key === token.key)?.value,
  };
}

export { createEditableScreenLookThemeDraft } from '../read-data/editable-screen-look-draft';

/** Real controls painted with the draft's own variables, so the look shows even where the page is covered. */
function LookCard({ theme }: { theme: EditableScreenLookTheme }) {
  const palette = resolveScreenLookPalette(theme) as Record<string, string>;
  return (
    <div
      data-look-editor-preview
      className="grid gap-3 rounded-[var(--radius-default)] border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3 text-[var(--text-primary)]"
      style={palette as React.CSSProperties}
    >
      <div className="grid gap-2 rounded-[var(--radius-default)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-lg)]">
        <span className="h-2 w-16 rounded-full bg-[var(--accent-primary)]" aria-hidden="true" />
        <Text variant="heading">{theme.name || 'My look'}</Text>
        <Text variant="body-sm" color="muted">Your pages, lists and messages in this look.</Text>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="accent">Open</Button>
          <Button size="sm" variant="ghost">Later</Button>
        </div>
      </div>
    </div>
  );
}

export function CompactScreenLookThemeEditor({
  draftTheme,
  pending = false,
  title = 'Edit Look',
  fontFaces = [],
  onDraftThemeChange,
  onCancel,
  onSave,
}: CompactScreenLookThemeEditorProps) {
  const faces = useMemo(() => {
    const worn = draftTheme.tokens.filter(token => token.kind === 'text').map(token => String(token.value));
    return [...new Set([...LOOK_TUNING.font_faces, ...fontFaces, ...worn])].filter(Boolean);
  }, [draftTheme.tokens, fontFaces]);

  const sections: TuningSection[] = useMemo(() => {
    const byKey = new Map(draftTheme.tokens.map(token => [token.key, token]));
    return draftTheme.sections.map(section => ({
      id: section.id,
      title: section.title,
      settings: section.token_keys.flatMap(key => {
        const token = byKey.get(key);
        return token ? [settingFor(token, faces)] : [];
      }),
    }));
  }, [draftTheme.sections, draftTheme.tokens, faces]);

  const values = useMemo(
    () => Object.fromEntries(draftTheme.tokens.map(token => [token.key, token.value])) as Record<string, TuningValue>,
    [draftTheme.tokens],
  );

  const change = (key: string, value: TuningValue) => {
    if (value === undefined || typeof value === 'boolean' || Array.isArray(value)) return;
    onDraftThemeChange(replaceEditableScreenLookToken(draftTheme, key, value));
  };

  return (
    <div className="w-full min-w-0" data-look-editor>
      <TuningPanel
        sections={sections}
        values={values}
        onChange={change}
        preview={<LookCard theme={draftTheme} />}
        header={(
          <div className="flex items-end gap-2">
            <Input
              label={title}
              value={draftTheme.name}
              placeholder="Name this look"
              onChange={(event) => onDraftThemeChange({ ...draftTheme, name: event.target.value })}
            />
          </div>
        )}
        footer={(
          <div className="sticky bottom-0 flex justify-end gap-2 bg-[var(--surface-primary,transparent)] py-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>Close</Button>
            <Button size="sm" variant="accent" onClick={onSave} disabled={pending}>
              {pending ? 'Keeping…' : 'Keep this look'}
            </Button>
          </div>
        )}
      />
    </div>
  );
}
