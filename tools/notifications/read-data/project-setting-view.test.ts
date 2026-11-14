// packages/notifications/read-data/project-setting-view.test.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Golden + adversarial tests for the Blind Human-View Projection
// (projectSettingView). This is the L069 primitive of the notifications UI: a
// pure function that turns the descriptor logic view + runtime write phase into
// a HumanSettingView of human strings and OPAQUE option ids only.
//
// Two test families:
//   1. GOLDEN — pin the exact human projection for every reachable presentation
//      state (the 9-state collapse, phase precedence, save-disable precedence,
//      error-copy fallback, current-label derivation).
//   2. ADVERSARIAL — prove structural blindness: routing/address/payload data
//      fed INTO the policy can never leak OUT through the projected view, the
//      view exposes exactly the human fields, opaque ids round-trip verbatim,
//      and the projection is pure (no mutation, deterministic).
//
// Acceptance criterion 2 of the UI rebase plan:
//   "project-setting-view.ts produces HumanSettingView with opaque ids only;
//    golden + adversarial tests green."
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { describe, it, expect } from 'vitest';

import { projectSettingView } from './project-setting-view';
import type { SettingOptionView, SettingPolicyView } from './read-notifications-policy';
import {
  settingCopy,
  SAVE_LABEL,
  REVERT_LABEL,
  SAVE_DISABLED_NO_CHANGE,
  SAVE_DISABLED_OFFLINE,
  SAVE_DISABLED_SAVING,
} from './setting-copy-table';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function option(over: Partial<SettingOptionView> = {}): SettingOptionView {
  return {
    id: 'opt-a',
    label: 'Option A',
    description: 'First choice.',
    iconName: 'bell',
    selected: false,
    isCurrent: false,
    ...over,
  };
}

/**
 * A SettingPolicyView fixture. Defaults to a clean, saved ('ready') policy with
 * a *poisoned* routing surface — descriptorAddress, actionRoute, and proofRefs
 * carry real backend vocabulary so the adversarial tests can prove none of it
 * survives the projection. The `save` block derives from `status` unless the
 * caller overrides it (so a 'dirty' fixture is save-enabled by default).
 */
function policy(over: Partial<SettingPolicyView> = {}): SettingPolicyView {
  const status = over.status ?? 'ready';
  const options =
    over.options ??
    [
      option({ id: 'opt-a', label: 'Option A', selected: true, isCurrent: true }),
      option({ id: 'opt-b', label: 'Option B', description: 'Second choice.', iconName: 'moon' }),
    ];
  const dirty = status === 'dirty';
  return {
    descriptorAddress: 'package::notifications::published-record::setting-control::notification-mode',
    heading: 'Notifications',
    explanation: 'Choose how this workspace notifies you.',
    options,
    currentOptionId: 'opt-a',
    selectedOptionId: dirty ? 'opt-b' : 'opt-a',
    status,
    statusCopy: 'Current choice is saved.',
    errorCopy: status === 'invalid' ? 'The saved choice is not described by this setting.' : null,
    save: { label: 'Save', enabled: dirty, disabledReason: dirty ? null : 'Choose a different option to save.' },
    revert: { label: 'Revert', enabled: dirty },
    actionRoute: {
      id: 'authority-owned-action',
      target: 'slot::workflow',
      valuePath: ['input', 'mode_id'],
      payloadTemplate: {
        operation: 'execute_definition',
        definition_id: 'action:update-workspace-notification-mode',
        prop: 'prop:settings',
      },
    },
    proofRefs: ['package::notifications::published-record::side-effect-intent-route::authority-owned-action'],
    ...over,
  };
}

// -----------------------------------------------------------------------------
// GOLDEN — the exact human projection per presentation state
// -----------------------------------------------------------------------------

describe('projectSettingView — golden projection', () => {
  it('a ready policy projects to the clean saved-state view', () => {
    const view = projectSettingView({ policy: policy() });

    expect(view.heading).toBe('Notifications');
    expect(view.explanation).toBe('Choose how this workspace notifies you.');
    expect(view.status).toBe('ready');
    expect(view.statusTone).toBe(settingCopy('ready').tone);
    expect(view.statusCopy).toBe(settingCopy('ready').statusCopy);
    expect(view.errorCopy).toBeNull();
    expect(view.currentLabel).toBe('Option A');

    expect(view.save.label).toBe(SAVE_LABEL);
    expect(view.save.enabled).toBe(false);
    expect(view.save.disabledReason).toBe(SAVE_DISABLED_NO_CHANGE);
    expect(view.revert.label).toBe(REVERT_LABEL);
    expect(view.revert.enabled).toBe(false);

    expect(view.options.map((o) => o.id)).toEqual(['opt-a', 'opt-b']);
  });

  it('a dirty policy enables save and revert', () => {
    const view = projectSettingView({ policy: policy({ status: 'dirty' }) });

    expect(view.status).toBe('dirty');
    expect(view.statusTone).toBe(settingCopy('dirty').tone);
    expect(view.save.enabled).toBe(true);
    expect(view.save.disabledReason).toBeNull();
    expect(view.revert.enabled).toBe(true);
  });

  it('an invalid policy surfaces the invalid error copy', () => {
    const view = projectSettingView({ policy: policy({ status: 'invalid' }) });

    expect(view.status).toBe('invalid');
    expect(view.statusTone).toBe(settingCopy('invalid').tone);
    expect(view.errorCopy).toBe(settingCopy('invalid').statusCopy);
  });

  it('an empty policy reads as loading from the user view', () => {
    const view = projectSettingView({ policy: policy({ status: 'empty', options: [] }) });

    expect(view.status).toBe('loading');
    expect(view.statusCopy).toBe(settingCopy('loading').statusCopy);
    expect(view.currentLabel).toBeNull();
  });

  it('currentLabel is null when no option is the saved value', () => {
    const view = projectSettingView({
      policy: policy({ options: [option({ id: 'opt-a' }), option({ id: 'opt-b' })], currentOptionId: null }),
    });

    expect(view.currentLabel).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// GOLDEN — runtime phase precedence over data states
// -----------------------------------------------------------------------------

describe('projectSettingView — phase precedence', () => {
  it('loading phase wins over the data state', () => {
    const view = projectSettingView({ policy: policy({ status: 'dirty' }), phase: 'loading' });
    expect(view.status).toBe('loading');
  });

  it('saving phase blocks save with the in-flight reason', () => {
    const view = projectSettingView({ policy: policy({ status: 'dirty' }), phase: 'saving' });

    expect(view.status).toBe('saving');
    expect(view.save.enabled).toBe(false);
    expect(view.save.disabledReason).toBe(SAVE_DISABLED_SAVING);
    expect(view.revert.enabled).toBe(false);
  });

  it('error phase uses the supplied human message, falling back to table copy', () => {
    const withMessage = projectSettingView({
      policy: policy(),
      phase: 'error',
      errorMessage: 'The workspace refused the change.',
    });
    expect(withMessage.status).toBe('error');
    expect(withMessage.errorCopy).toBe('The workspace refused the change.');

    const withoutMessage = projectSettingView({ policy: policy(), phase: 'error' });
    expect(withoutMessage.errorCopy).toBe(settingCopy('error').statusCopy);
  });

  it('saved phase surfaces the transient confirmation only from a clean policy', () => {
    const fromReady = projectSettingView({ policy: policy({ status: 'ready' }), phase: 'saved' });
    expect(fromReady.status).toBe('saved');

    // A 'saved' confirmation must never mask an unsaved (dirty) change.
    const fromDirty = projectSettingView({ policy: policy({ status: 'dirty' }), phase: 'saved' });
    expect(fromDirty.status).toBe('dirty');
  });

  it('offline overrides every other state and blocks save', () => {
    const view = projectSettingView({ policy: policy({ status: 'dirty' }), phase: 'saving', offline: true });

    expect(view.status).toBe('offline');
    expect(view.statusTone).toBe(settingCopy('offline').tone);
    expect(view.save.enabled).toBe(false);
    expect(view.save.disabledReason).toBe(SAVE_DISABLED_OFFLINE);
  });
});

// -----------------------------------------------------------------------------
// ADVERSARIAL — structural blindness is the whole point (L063 / L069 / L090)
// -----------------------------------------------------------------------------

describe('projectSettingView — structural blindness', () => {
  const ALLOWED_VIEW_KEYS = [
    'heading',
    'explanation',
    'options',
    'status',
    'statusTone',
    'statusCopy',
    'errorCopy',
    'currentLabel',
    'save',
    'revert',
  ].sort();

  const ALLOWED_OPTION_KEYS = ['id', 'label', 'description', 'iconName', 'selected', 'isCurrent'].sort();

  it('exposes exactly the human fields — no address, route, or payload field', () => {
    const view = projectSettingView({ policy: policy() });

    expect(Object.keys(view).sort()).toEqual(ALLOWED_VIEW_KEYS);
    for (const opt of view.options) {
      expect(Object.keys(opt).sort()).toEqual(ALLOWED_OPTION_KEYS);
    }
  });

  it('routing data fed into the policy never leaks into the projected view', () => {
    // The fixture's descriptorAddress, actionRoute, and proofRefs carry real
    // backend vocabulary. None of it may survive the projection.
    const serialized = JSON.stringify(projectSettingView({ policy: policy({ status: 'dirty' }) }));

    for (const leak of [
      'slot::workflow',
      'mode_id',
      'action:update-workspace-notification-mode',
      'prop:settings',
      'descriptorAddress',
      'actionRoute',
      'proofRefs',
      'side-effect-intent-route',
      'package::notifications',
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('opaque option ids round-trip verbatim without interpretation', () => {
    const ids = ['9f3c-token', 'opaque::42', 'whatever-the-owner-chose'];
    const view = projectSettingView({
      policy: policy({ options: ids.map((id) => option({ id })), currentOptionId: null }),
    });

    expect(view.options.map((o) => o.id)).toEqual(ids);
  });

  it('is pure — identical inputs yield deep-equal outputs and never mutate the policy', () => {
    const fixture = policy({ status: 'dirty' });
    const before = JSON.stringify(fixture);

    const first = projectSettingView({ policy: fixture });
    const second = projectSettingView({ policy: fixture });

    expect(first).toEqual(second);
    expect(JSON.stringify(fixture)).toBe(before);
  });
});
