import { describe, expect, it } from 'vitest';

import boundary from '../things-to-store-and-run.json';
import { readNotificationsPolicy, readNotificationsPolicyFromBoundary } from './read-notifications-policy';

const descriptor = {
  id: 'setting:any',
  kind: 'setting-control',
  title: 'Plain setting',
  description: 'A choice described by data.',
  options: [
    { value: 'alpha', label: 'Alpha', description: 'First described choice', icon: 'Circle' },
    { value: 'beta', label: 'Beta', description: 'Second described choice', icon: 'Square' },
  ],
  value: {
    default: 'alpha',
    property_ids: ['prop:any:active'],
  },
  write: {
    target: 'slot::workflow',
    value_path: ['input', 'choice'],
    payload: {
      operation: 'execute_definition',
      definition_id: 'action:update-any-setting',
    },
  },
};

describe('notifications policy reader', () => {
  it('projects the package boundary descriptor and action route from data', () => {
    const view = readNotificationsPolicyFromBoundary(boundary);

    expect(view.heading).toBe('Notification Mode');
    expect(view.options.map((option) => option.label)).toEqual([
      'Normal',
      'Focus',
      'Do Not Disturb',
      'Scheduled',
    ]);
    expect(view.currentOptionId).toBe('normal');
    expect(view.status).toBe('ready');
    expect(view.actionRoute).toEqual(expect.objectContaining({
      target: 'slot::workflow',
      valuePath: ['input', 'mode_id'],
      payloadTemplate: {
        operation: 'execute_definition',
        definition_id: 'action:update-workspace-notification-mode',
        include_steps: false,
        include_output: false,
      },
    }));
    expect(view.proofRefs).toEqual(expect.arrayContaining([
      'package::notifications::published-record::record-policy-action-graph::settings-policy',
      'package::notifications::published-record::side-effect-intent-route::authority-owned-action',
    ]));
  });

  it('derives dirty state from an opaque selected option id', () => {
    const view = readNotificationsPolicyFromBoundary(boundary, 'focus');

    expect(view.currentOptionId).toBe('normal');
    expect(view.selectedOptionId).toBe('focus');
    expect(view.status).toBe('dirty');
    expect(view.save.enabled).toBe(true);
    expect(view.revert.enabled).toBe(true);
    expect(view.options.find((option) => option.id === 'focus')?.selected).toBe(true);
  });

  it('uses the same projection for a non-notification descriptor', () => {
    const view = readNotificationsPolicy({
      descriptor,
      currentRecords: [{ property_id: 'prop:any:active', value: 'beta' }],
      selectedOptionId: 'alpha',
    });

    expect(view.heading).toBe('Plain setting');
    expect(view.options.map((option) => option.id)).toEqual(['alpha', 'beta']);
    expect(view.currentOptionId).toBe('beta');
    expect(view.selectedOptionId).toBe('alpha');
    expect(view.status).toBe('dirty');
    expect(view.actionRoute).toEqual(expect.objectContaining({
      target: 'slot::workflow',
      valuePath: ['input', 'choice'],
      // The descriptor fallback now carries write.payload verbatim — no field is
      // dropped (the lossy 4-field extraction is gone).
      payloadTemplate: {
        operation: 'execute_definition',
        definition_id: 'action:update-any-setting',
      },
    }));
  });

  it('resolves nested current values through descriptor-declared value keys', () => {
    const view = readNotificationsPolicy({
      descriptor: {
        ...descriptor,
        value: {
          ...(descriptor.value as Record<string, unknown>),
          keys: ['choice'],
        },
      },
      currentRecords: [{ property_id: 'prop:any:active', value: { choice: 'beta' } }],
    });

    expect(view.currentOptionId).toBe('beta');
    expect(view.status).toBe('ready');
    expect(view.options.find((option) => option.id === 'beta')?.isCurrent).toBe(true);
  });

  it('reports an invalid saved value instead of correcting it', () => {
    const view = readNotificationsPolicy({
      descriptor,
      currentRecords: [{ property_id: 'prop:any:active', value: 'gamma' }],
    });

    expect(view.currentOptionId).toBe('gamma');
    expect(view.status).toBe('invalid');
    expect(view.errorCopy).toBe('The saved choice is not described by this setting.');
    expect(view.save.enabled).toBe(false);
  });
});
