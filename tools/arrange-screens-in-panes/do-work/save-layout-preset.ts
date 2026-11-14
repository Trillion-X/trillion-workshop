// packages/screen-arrangement/do-work/save-layout-preset.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// LEGACY SUNSET SHIM. Saved layouts now live as GROUP records (see
// save-arrangement-as-group.ts — the T3/W1 membership-SSOT design); the
// `prop:layout_preset:*` family is retired. The ONLY surviving legacy verb is
// the archive action, which the one-shot migration
// (migrate-layout-presets-to-groups.ts) uses to flip already-migrated legacy
// rows to `archived` (append-only — history preserved, never deleted). Once a
// live sweep confirms zero active legacy rows remain, this file and the legacy
// reader die together with the family's action definitions (L030/L101).
//
// The write path (`writeLayoutPreset`) is DELETED — no code path may create new
// legacy preset rows.
//
// =============================================================================

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit'

const ARCHIVE_LAYOUT_PRESET_ACTION = 'action:archive-layout-preset'

export async function archiveLayoutPreset(presetId: string, updatedAt = new Date().toISOString()): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: ARCHIVE_LAYOUT_PRESET_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        preset_id: presetId,
        updated_at: updatedAt,
      },
    },
  })
}
