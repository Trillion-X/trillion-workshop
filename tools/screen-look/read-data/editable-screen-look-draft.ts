// parts/screen-look/read-data/editable-screen-look-draft.ts
//
// Purpose: a new editable copy of a look (`createEditableScreenLookThemeDraft`): a fresh id from its name, "Custom
// Look" or "<name> Copy", and its own copies of every token and section. Kept apart from the editor that draws it
// (show/CompactScreenLookThemeEditor.tsx, which re-exports it), so choosing to copy a look loads no editor.
import {
  DEFAULT_EDITABLE_SCREEN_LOOK_THEME,
  type EditableScreenLookTheme,
} from './read-editable-screen-look-themes';

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'custom-look';
}

export function createEditableScreenLookThemeDraft(
  source: EditableScreenLookTheme = DEFAULT_EDITABLE_SCREEN_LOOK_THEME,
): EditableScreenLookTheme {
  const suffix = Date.now().toString(36);
  return {
    ...source,
    id: `${slugify(source.name)}-${suffix}`,
    name: source.id === DEFAULT_EDITABLE_SCREEN_LOOK_THEME.id ? 'Custom Look' : `${source.name} Copy`,
    description: source.description || 'Custom screen-look token set.',
    author: 'screen-look',
    is_public: false,
    is_favorite: false,
    order: undefined,
    tokens: source.tokens.map((token) => ({ ...token })),
    sections: source.sections.map((section) => ({
      ...section,
      token_keys: [...section.token_keys],
    })),
  };
}
