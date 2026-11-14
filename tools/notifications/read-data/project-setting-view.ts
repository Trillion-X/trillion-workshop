// packages/notifications/read-data/project-setting-view.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The Blind Human-View Projection. A pure function that maps the descriptor
// logic view (SettingPolicyView, from read-notifications-policy.ts) plus the
// runtime write phase into a HumanSettingView containing HUMAN STRINGS and
// OPAQUE OPTION IDS ONLY.
//
// Structural blindness is the whole point (L063 category fix): HumanSettingView
// has NO field that names a mode key, property id, descriptor address, write
// target, action definition, or payload path. The renderer consumes only this
// type, so the renderer is *structurally incapable* of naming a notification
// mode or a backend route. Add a new mode tomorrow → one descriptor data row,
// zero renderer/projection code change (L090: self-describing data, generic
// handler).
//
// The option id IS opaque: it round-trips from descriptor data, through the
// renderer's selection callback, back to the write authority (do-work/
// save-setting.ts) — but no code on the render side ever interprets it.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. HumanSettingView carries zero addresses, routes, keys, or payload paths.
//    The render side cannot reach the write route through this type.
// 2. The projection is pure: same inputs → same output. No I/O, no DOM, no
//    `window` — safe to run identically in the browser envelope and the iOS
//    JSCore envelope.
// 3. All status copy comes from setting-copy-table.ts. The projection never
//    authors a status sentence inline.
// 4. The 4-state descriptor logic status is enriched into the 9-state
//    presentation status using the runtime phase + connectivity — data-only
//    states map from the policy, runtime-only states map from the phase.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { SettingPolicyView } from './read-notifications-policy';
import {
  settingCopy,
  SAVE_LABEL,
  REVERT_LABEL,
  SAVE_DISABLED_NO_CHANGE,
  SAVE_DISABLED_OFFLINE,
  SAVE_DISABLED_SAVING,
  type SettingStatus,
  type SettingTone,
} from './setting-copy-table';

/**
 * One selectable option, as the human sees it. `id` is opaque — the renderer
 * passes it back on selection and never inspects it.
 */
export interface HumanOptionView {
  /** OPAQUE selection token. Round-trips to the write authority untouched. */
  id: string;
  label: string;
  description: string;
  /** Generic icon name (e.g. a Lucide name) carried as presentation data. */
  iconName: string;
  /** True when this option is the user's pending choice. */
  selected: boolean;
  /** True when this option is the saved/current value. */
  isCurrent: boolean;
}

/**
 * The entire input to the blind renderer. Human strings + opaque ids only.
 */
export interface HumanSettingView {
  heading: string;
  explanation: string;
  options: HumanOptionView[];
  /** Presentation status (9-state). Drives the status dot, badge, and copy. */
  status: SettingStatus;
  /** Generic tone for the status dot / badge. */
  statusTone: SettingTone;
  /** Plain-language status sentence. */
  statusCopy: string;
  /** Plain-language error sentence, or null when there is no error. */
  errorCopy: string | null;
  /** Human label of the saved/current option (e.g. for a sidecar), or null. */
  currentLabel: string | null;
  save: { label: string; enabled: boolean; disabledReason: string | null };
  revert: { label: string; enabled: boolean };
}

/**
 * The runtime write phase the envelope is in. Data alone cannot express these —
 * they exist only while a human is mid-interaction.
 */
export type WritePhase = 'idle' | 'loading' | 'saving' | 'saved' | 'error';

export interface ProjectSettingViewInput {
  /** Descriptor logic view from readNotificationsPolicy(...). */
  policy: SettingPolicyView;
  /** Current runtime write phase. Defaults to 'idle'. */
  phase?: WritePhase;
  /** True when the surface cannot reach the write target. */
  offline?: boolean;
  /** Human-readable error sentence to override the default error copy. */
  errorMessage?: string | null;
}

/**
 * Collapse the 4-state descriptor logic status + runtime phase + connectivity
 * into the single presentation status. Runtime phases win over data states
 * because they describe what is happening right now to the user's action.
 */
function presentationStatus(
  policy: SettingPolicyView,
  phase: WritePhase,
  offline: boolean,
): SettingStatus {
  if (offline) return 'offline';
  if (phase === 'loading') return 'loading';
  if (phase === 'saving') return 'saving';
  if (phase === 'error') return 'error';

  switch (policy.status) {
    case 'invalid':
      return 'invalid';
    case 'dirty':
      return 'dirty';
    case 'empty':
      // No options described yet — treat as still loading from the user's view.
      return 'loading';
    case 'ready':
    default:
      // A just-saved write resolves back to a clean 'ready' policy; surface the
      // transient 'saved' confirmation until the next interaction.
      return phase === 'saved' ? 'saved' : 'ready';
  }
}

function saveDisabledReason(status: SettingStatus, policyEnabled: boolean): string | null {
  if (status === 'offline') return SAVE_DISABLED_OFFLINE;
  if (status === 'saving') return SAVE_DISABLED_SAVING;
  if (policyEnabled) return null;
  return SAVE_DISABLED_NO_CHANGE;
}

/**
 * The Blind Human-View Projection. The ONLY producer of HumanSettingView.
 */
export function projectSettingView(input: ProjectSettingViewInput): HumanSettingView {
  const { policy } = input;
  const phase: WritePhase = input.phase ?? 'idle';
  const offline = input.offline ?? false;

  const status = presentationStatus(policy, phase, offline);
  const copy = settingCopy(status);

  const currentOption = policy.options.find((option) => option.isCurrent) ?? null;

  const saveEnabled = policy.save.enabled && status !== 'saving' && status !== 'offline';
  const revertEnabled = policy.revert.enabled && status !== 'saving';

  const errorCopy =
    status === 'error'
      ? input.errorMessage ?? copy.statusCopy
      : status === 'invalid'
        ? copy.statusCopy
        : null;

  return {
    heading: policy.heading,
    explanation: policy.explanation,
    // SettingOptionView is structurally HumanOptionView — pass through, but map
    // explicitly so the blind contract is enforced field-by-field (no leakage
    // of any future logic-view field into the render side).
    options: policy.options.map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
      iconName: option.iconName,
      selected: option.selected,
      isCurrent: option.isCurrent,
    })),
    status,
    statusTone: copy.tone,
    statusCopy: copy.statusCopy,
    errorCopy,
    currentLabel: currentOption ? currentOption.label : null,
    save: {
      label: SAVE_LABEL,
      enabled: saveEnabled,
      disabledReason: saveEnabled ? null : saveDisabledReason(status, policy.save.enabled),
    },
    revert: {
      label: REVERT_LABEL,
      enabled: revertEnabled,
    },
  };
}
