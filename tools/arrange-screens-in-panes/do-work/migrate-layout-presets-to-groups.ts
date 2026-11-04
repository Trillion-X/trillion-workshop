// packages/screen-arrangement/do-work/migrate-layout-presets-to-groups.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// ONE-TIME additive migration (plan T3, L030/L101): rewrite every legacy
// `prop:layout_preset:*` saved layout as a group-backed preset through the
// `group.apply-mutation` door, then ARCHIVE the legacy rows (append-only —
// history preserved, the legacy reader's archived-filter drops them). Never
// blind-deletes; verifies each preset by reading the group back before
// archiving its source rows.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Additive: group records are written FIRST and readback-verified; only
//    then are legacy rows archived (status:'archived'), never removed.
// 2. Idempotent: re-running skips presets whose group already folds to the
//    same layout (safe to fire on every boot until the family is retired).
// 3. This module never writes group records itself — it dispatches ops by
//    address, exactly like every other consumer.
//
// =============================================================================

import { readInputValue, sendRequestToBitfieldTarget, writeInputValue } from '#workspace-records'
import type { SavedLayout as LegacyLayoutPreset } from '../read-data/read-layout-presets'
import { readProjectedRows } from '../read-data/read-projected-rows'
import { requireSuccessfulGroupGraphReply } from '../read-data/read-tab-collections'
import {
  buildSaveArrangementBatch,
  foldGroupToLayoutState,
  layoutPresetRef,
  GROUP_APPLY_MUTATION_TARGET,
  LAYOUT_PRESET_INDEX_REF,
} from './save-arrangement-as-group'

const GROUP_LOAD_GRAPH_TARGET = 'group.load-graph'

export interface MigrationReport {
  migrated: string[]
  alreadyMigrated: string[]
  archived: string[]
  failed: Array<{ id: string; error: string }>
}

interface GraphReply { ok?: boolean; graph?: { groups?: Record<string, unknown> } | null }

async function loadPresetGroup(
  presetId: string,
  send: typeof sendRequestToBitfieldTarget,
): Promise<unknown | null> {
  const rawReply = await send({
    target: GROUP_LOAD_GRAPH_TARGET,
    payload: { roots: [layoutPresetRef(presetId)] },
  })
  const reply = requireSuccessfulGroupGraphReply(rawReply) as GraphReply
  const groups = reply?.graph?.groups ?? {}
  const values = Object.values(groups)
  return values.length > 0 ? values[0] : null
}

/**
 * Migrate all active legacy presets. The caller supplies the decoded legacy
 * rows (the SAME `readLayoutPresets(useBitfieldData('layout-presets'))` feed
 * the menu already reads — the legacy reader stays alive until migration is
 * verified, then dies in the same chain, L101). `send` is injectable for tests.
 */
export async function migrateLayoutPresetsToGroups(
  legacyPresets: readonly LegacyLayoutPreset[],
  send: typeof sendRequestToBitfieldTarget = sendRequestToBitfieldTarget,
): Promise<MigrationReport> {
  const presets = legacyPresets
  const report: MigrationReport = { migrated: [], alreadyMigrated: [], archived: [], failed: [] }

  for (const preset of presets) {
    try {
      // Idempotence: skip when the group already folds to a preset.
      const existing = await loadPresetGroup(preset.id, send)
      const folded = existing ? foldGroupToLayoutState(existing) : null
      if (folded) {
        report.alreadyMigrated.push(preset.id)
      } else {
        await send({
          target: GROUP_APPLY_MUTATION_TARGET,
          payload: { ops: buildSaveArrangementBatch(preset.id, preset.name, preset.layout) },
        })
        // Readback verify BEFORE touching the legacy rows.
        const verify = foldGroupToLayoutState(await loadPresetGroup(preset.id, send))
        if (!verify) throw new Error('group readback did not fold to a preset')
        report.migrated.push(preset.id)
      }
      // The same declared input owns the legacy feed and its archived status.
      const rows = readProjectedRows(readInputValue('layout-presets')) as Array<{ subject_id?: string; property_id?: string; value?: unknown }>
      await writeInputValue('layout-presets', [
        ...rows.filter(row => row.subject_id !== preset.id || row.property_id !== 'prop:layout_preset:status'),
        { subject_id: preset.id, property_id: 'prop:layout_preset:status', value: 'archived' },
      ])
      report.archived.push(preset.id)
    } catch (error) {
      report.failed.push({ id: preset.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return report
}

export { LAYOUT_PRESET_INDEX_REF }
