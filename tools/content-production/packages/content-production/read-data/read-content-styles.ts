/**
 * file: packages/content-production/read-data/read-content-styles.ts
 *
 * PURPOSE: Pure queries for the Style picker surface (plan §13A U03).
 * A style IS a run-profile record (a workflow definition id + requested
 * outputs) — this module projects the evidence feed's run_profiles lane into
 * pickable cards. Adding a style is adding a run-profile record: zero code here.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Never imports from slot::workflow or slot::eeaf — pure data over the evidence feed
 * 2. Styles are never enumerated in code — every card comes from a run-profile record
 * 3. Zero side effects, zero writes
 */

import {
  readContentProductionEvidence,
  type ContentProductionRunProfile,
} from '@/packages/content-production/read-data/read-content-production';

export type ContentStyleOption = {
  /** The run-profile id — what a production run is submitted with. */
  profileId: string;
  label: string;
  /** The workflow definition the engine executes for this style. */
  executionDefinitionId: string;
  /** What this style produces, in user terms (from requested_outputs roles). */
  outputRoles: string[];
  raw: ContentProductionRunProfile;
};

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Every pickable style — one card per run-profile record in the evidence feed. */
export function readContentStyleOptions(evidenceRows: unknown): ContentStyleOption[] {
  const evidence = readContentProductionEvidence(evidenceRows);
  return evidence.runProfiles
    .map((profile) => {
      const profileId = asText(profile.profile_id);
      const executionDefinitionId = asText(profile.execution_definition_id);
      if (!profileId || !executionDefinitionId) return null;
      const outputs = Array.isArray(profile.requested_outputs) ? profile.requested_outputs : [];
      return {
        profileId,
        label: asText(profile.label) ?? profileId,
        executionDefinitionId,
        outputRoles: outputs
          .map((output) => asText((output as Record<string, unknown>)?.role))
          .filter((role): role is string => role !== null),
        raw: profile,
      };
    })
    .filter((option): option is ContentStyleOption => option !== null);
}

/** Output-role id → plain user words. Unknown roles display as themselves. */
const OUTPUT_ROLE_LABELS: Record<string, string> = {
  'source-artifact': 'source file',
  'publish-intent': 'publish request',
  'publish-attempt': 'publish attempt',
  'publish-status': 'publish status',
  'rendered-media': 'rendered video',
  'analytics-observation': 'analytics',
};

export function outputRoleLabel(role: string): string {
  return OUTPUT_ROLE_LABELS[role] ?? role.replace(/[-_]/g, ' ');
}
