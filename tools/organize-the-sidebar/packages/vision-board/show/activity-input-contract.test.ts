import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { observeOrBehavior } from '@/packages/visual-database/proof/or-behavior-observation';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const THINGS_PATH = resolve(PACKAGE_ROOT, 'things-to-store-and-run.json');
const SCOPE_PATH = resolve(PACKAGE_ROOT, 'entry-read-scope-packages.json');
const MOUNT_PATH = resolve(PACKAGE_ROOT, 'show/mount-vision-board.tsx');
const ACTIVITY_THINGS_PATH = resolve(PACKAGE_ROOT, '../activity-feed/things-to-store-and-run.json');
const ACTIVITY_INPUT = 'scoped-recent-activity';
const ACTION_AFFORDANCE_INPUT = 'action-affordance-feed';

describe('vision-board activity input contract', () => {
  it('declares the exact input used by the material and admits its owner package data', ({ task }) => {
    const things = JSON.parse(readFileSync(THINGS_PATH, 'utf8')) as {
      things: Array<{ address?: string; payload?: { bitfield_inputs?: Array<{ label?: string }> } }>;
    };
    const scope = JSON.parse(readFileSync(SCOPE_PATH, 'utf8')) as {
      entries: Array<{ entry_name?: string; read_scope_package_data_packages?: string[] }>;
    };
    const mount = readFileSync(MOUNT_PATH, 'utf8');
    const entry = things.things.find((thing) => thing.address === 'package::vision-board::entry::vision-board');
    const declared = entry?.payload?.bitfield_inputs?.map((input) => input.label) ?? [];
    const admitted = scope.entries.find((candidate) => candidate.entry_name === 'vision-board')
      ?.read_scope_package_data_packages ?? [];

    expect(mount).toContain(`useBitfieldData('${ACTIVITY_INPUT}')`);
    expect(mount).not.toContain('activity-feed::recent-activity');
    expect(mount).not.toContain('activity-feed::scoped-recent-activity');
    expect(declared).toContain(ACTIVITY_INPUT);
    expect(admitted).toContain('activity-feed');
    observeOrBehavior(task, {
      or_id: 'OR-27',
      action_ids: ['mount', 'read-scoped-activity'],
      assertion_ids: [
        'declared-input-resolves',
        'no-missing-input-error',
        'canvas-remains-interactive',
      ],
      observed: {
        mounted_feed_key: ACTIVITY_INPUT,
        declared_input_labels: declared,
        admitted_package_ids: admitted,
        rejected_legacy_input: 'activity-feed::recent-activity',
      },
    });
  });

  it('requires the producer-owned descriptor used by generated cross-package scopes', () => {
    const activityThings = JSON.parse(readFileSync(ACTIVITY_THINGS_PATH, 'utf8')) as {
      things: Array<{ address?: string; payload?: Record<string, unknown> }>;
    };
    const descriptor = activityThings.things.find(
      (thing) => thing.address === 'package::activity-feed::input::scoped-recent-activity',
    );

    expect(descriptor?.payload).toMatchObject({
      kind: 'bitfield-input-descriptor',
      input_name: 'scoped-recent-activity',
    });
  });

  it('declares every literal local input inherited through the generic board composition', () => {
    const things = JSON.parse(readFileSync(THINGS_PATH, 'utf8')) as {
      things: Array<{ address?: string; payload?: Record<string, unknown> }>;
    };
    const descriptor = things.things.find(
      (thing) => thing.address === 'package::vision-board::input::action-affordance-feed',
    );

    expect(descriptor?.payload).toEqual({
      input_name: ACTION_AFFORDANCE_INPUT,
      kind: 'bitfield-input-descriptor',
      selected_payload: {
        value_address_label: 'package::vision-board::action-affordance-feed',
        value: {
          source_bytes: {
            bytes_to_value: 'json',
          },
        },
      },
    });
  });
});
