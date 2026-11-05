// packages/command-palette/do-work/ask-palette-bulk-action-descriptors.test.ts
//
// Unit tests for bulk-action descriptor reading seam.
// Tests verify that descriptors are read generically from DATA rows,
// field-mapped correctly, and that missing/malformed descriptors are skipped.

import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { readPaletteBulkActionDescriptorsFromReply } from '../../../do-work/ask-palette-bulk-action-descriptors.ts';

describe('readPaletteBulkActionDescriptorsFromReply', () => {
  it('reads valid bulk-action descriptors', () => {
    const jsonString = JSON.stringify([
      {
        kind: 'palette-bulk-action-descriptor',
        id: 'action-1',
        label: 'Download',
        icon: 'Download',
        target: 'workflow::execute',
        definition_id: 'download-action',
      },
      {
        kind: 'palette-bulk-action-descriptor',
        id: 'action-2',
        label: 'Delete',
        target: 'workflow::execute',
        definition_id: 'delete-action',
      },
    ]);
    const encoder = new TextEncoder();
    const reply = {
      payload: encoder.encode(jsonString),
    };

    const descriptors = readPaletteBulkActionDescriptorsFromReply(reply);

    expect(descriptors).toHaveLength(2);
    expect(descriptors[0]?.id).toBe('action-1');
    expect(descriptors[0]?.label).toBe('Download');
    expect(descriptors[0]?.icon).toBe('Download');
    expect(descriptors[0]?.target).toBe('workflow::execute');
    expect(descriptors[0]?.definition_id).toBe('download-action');

    expect(descriptors[1]?.id).toBe('action-2');
    expect(descriptors[1]?.label).toBe('Delete');
    expect(descriptors[1]?.icon).toBeUndefined();
    expect(descriptors[1]?.target).toBe('workflow::execute');
  });

  it('skips descriptors missing required fields', () => {
    const jsonString = JSON.stringify([
      {
        kind: 'palette-bulk-action-descriptor',
        id: 'action-1',
        label: 'Download',
        // missing target and definition_id
      },
      {
        kind: 'palette-bulk-action-descriptor',
        id: 'action-2',
        label: 'Delete',
        target: 'workflow::execute',
        definition_id: 'delete-action',
      },
    ]);
    const encoder = new TextEncoder();
    const reply = {
      payload: encoder.encode(jsonString),
    };

    const descriptors = readPaletteBulkActionDescriptorsFromReply(reply);

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.id).toBe('action-2');
  });

  it('skips non-matching kinds', () => {
    const jsonString = JSON.stringify([
      {
        kind: 'other-descriptor',
        id: 'action-1',
        label: 'Download',
        target: 'workflow::execute',
        definition_id: 'download-action',
      },
      {
        kind: 'palette-bulk-action-descriptor',
        id: 'action-2',
        label: 'Delete',
        target: 'workflow::execute',
        definition_id: 'delete-action',
      },
    ]);
    const encoder = new TextEncoder();
    const reply = {
      payload: encoder.encode(jsonString),
    };

    const descriptors = readPaletteBulkActionDescriptorsFromReply(reply);

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.id).toBe('action-2');
  });

  it('uses label as id fallback when id is missing', () => {
    const reply = {
      payload: JSON.stringify([
        {
          kind: 'palette-bulk-action-descriptor',
          // id is missing
          label: 'Download',
          target: 'workflow::execute',
          definition_id: 'download-action',
        },
      ]),
    };

    const descriptors = readPaletteBulkActionDescriptorsFromReply(reply);

    expect(descriptors).toHaveLength(0); // should skip because id is required
  });

  it('handles Uint8Array payload encoding', () => {
    const jsonString = JSON.stringify([
      {
        kind: 'palette-bulk-action-descriptor',
        id: 'action-1',
        label: 'Download',
        target: 'workflow::execute',
        definition_id: 'download-action',
      },
    ]);
    const encoder = new TextEncoder();
    const uint8payload = encoder.encode(jsonString);

    const reply = {
      payload: uint8payload,
    };

    const descriptors = readPaletteBulkActionDescriptorsFromReply(reply);

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.id).toBe('action-1');
  });

  it('handles static_input field', () => {
    const jsonString = JSON.stringify([
      {
        kind: 'palette-bulk-action-descriptor',
        id: 'action-1',
        label: 'Download',
        target: 'workflow::execute',
        definition_id: 'download-action',
        static_input: { format: 'mp4', quality: 'hd' },
      },
    ]);
    const encoder = new TextEncoder();
    const reply = {
      payload: encoder.encode(jsonString),
    };

    const descriptors = readPaletteBulkActionDescriptorsFromReply(reply);

    expect(descriptors[0]?.static_input).toEqual({ format: 'mp4', quality: 'hd' });
  });

  it('returns empty array for invalid/empty replies', () => {
    expect(readPaletteBulkActionDescriptorsFromReply(null)).toEqual([]);
    expect(readPaletteBulkActionDescriptorsFromReply(undefined)).toEqual([]);
    expect(readPaletteBulkActionDescriptorsFromReply('')).toEqual([]);
    expect(readPaletteBulkActionDescriptorsFromReply({})).toEqual([]);
    expect(readPaletteBulkActionDescriptorsFromReply([])).toEqual([]);
  });
});
