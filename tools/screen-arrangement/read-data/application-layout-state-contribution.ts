// screen-arrangement-owned default layout contribution. Application DATA picks
// an opaque address label and supplies ordinary LayoutState JSON; the generic
// mount reads and persists that address without learning a product identity.

import { normalizeLayoutState } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/read-screen-arrangement.ts';
import type { LayoutState } from './layout-types';

type Plain = Record<string, unknown>;

const OWNER_REF = 'package::screen-arrangement::application-contribution::default-layout';

function plain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Plain).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical((value as Plain)[key])}`
  )).join(',')}}`;
}

export function validateApplicationLayoutState(value: unknown): LayoutState {
  if (!plain(value)) throw new Error('config.layout_state must be an object');
  const normalized = normalizeLayoutState(value as Partial<LayoutState>);
  if (canonical(normalized) !== canonical(value)) {
    throw new Error('config.layout_state must be a complete canonical LayoutState with valid references');
  }
  return normalized;
}

export function buildApplicationLayoutStateContribution(input: unknown) {
  if (!plain(input)) throw new Error('contribution operation must be an object');
  if (input.owner_ref !== OWNER_REF) throw new Error(`owner_ref must be ${OWNER_REF}`);
  if (input.operation !== 'upsert' && input.operation !== 'retract') throw new Error('operation must be upsert or retract');
  if (!plain(input.config)) throw new Error('config must be an object');
  const address = text(input.config.address_label, 'config.address_label');
  if (input.operation === 'retract') {
    return {
      schema: 'screen-arrangement.application-layout-state-contribution/canonical-seed-write-set',
      write_set: {
        upserts: [],
        retractions: [{
          type: 'record',
          address,
          path: ['current-item', 'published-record'],
          remove: true,
        }],
      },
    };
  }
  const layoutState = validateApplicationLayoutState(input.config.layout_state);
  return {
    schema: 'screen-arrangement.application-layout-state-contribution/canonical-seed-write-set',
    write_set: {
      upserts: [{
        type: 'record',
        address,
        address_mode: 'label_hash',
        live_write_policy: 'seed-only',
        path: ['current-item', 'published-record'],
        payload: layoutState,
        payload_text: null,
        payload_base64: null,
        remove: false,
      }],
      retractions: [],
    },
  };
}
