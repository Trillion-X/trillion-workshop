// parts/screen-look/do-work/update-editable-screen-look-theme.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Workflow-backed writes for screen-look-owned editable theme records.
//
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records';
import type {
  EditableScreenLookTheme,
  EditableScreenLookToken,
} from '../read-data/read-editable-screen-look-themes';

const UPDATE_EDITABLE_THEME_ACTION = 'action:update-editable-screen-look-theme';

export async function updateEditableScreenLookTheme(
  theme: EditableScreenLookTheme,
): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: UPDATE_EDITABLE_THEME_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        theme_id: theme.id,
        theme_record: theme,
      },
    },
  });
}

export function replaceEditableScreenLookToken(
  theme: EditableScreenLookTheme,
  tokenKey: string,
  value: EditableScreenLookToken['value'],
): EditableScreenLookTheme {
  return {
    ...theme,
    tokens: theme.tokens.map((token) => (
      token.key === tokenKey ? { ...token, value } : token
    )),
  };
}
