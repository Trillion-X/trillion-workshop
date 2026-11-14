// packages/command-palette/do-work/ask-palette-bulk-actions-by-descriptor.test.ts
//
// Proves the generic palette-bulk-action-descriptor reader/dispatcher works
// for ANY group name with ZERO code change — including a deletion test that
// swaps a media-shaped descriptor for a legal-doc-shaped one.

import { describe, expect, it, vi } from 'vitest';
import {
  askPaletteBulkActionDescriptors,
  readPaletteBulkActionDescriptorsFromReply,
  runPaletteBulkAction,
  type PaletteBulkActionDescriptor,
} from './ask-palette-bulk-actions-by-descriptor';

const sendRequestToBitfieldTarget = vi.fn();

vi.mock('#workspace-records', () => ({
  sendRequestToBitfieldTarget: (...args: unknown[]) => sendRequestToBitfieldTarget(...args),
}));

function makeReply(items: unknown[]) {
  return { payload: new TextEncoder().encode(JSON.stringify({ items })) };
}

describe('readPaletteBulkActionDescriptorsFromReply', () => {
  it('returns an empty array when no rows are admitted', () => {
    expect(readPaletteBulkActionDescriptorsFromReply(makeReply([]))).toEqual([]);
  });

  it('decodes a well-formed descriptor row', () => {
    const reply = makeReply([
      {
        kind: 'palette-bulk-action-descriptor',
        id: 'add-to-collection',
        group: 'Media',
        label: 'Add to collection',
        dispatch: {
          target: 'slot::workflow',
          definition_id: 'action:add-to-collection',
          selected_field: 'items',
        },
      },
    ]);
    const descriptors = readPaletteBulkActionDescriptorsFromReply(reply);
    expect(descriptors).toEqual([
      {
        id: 'add-to-collection',
        group: 'Media',
        label: 'Add to collection',
        variant: 'default',
        dispatch: {
          target: 'slot::workflow',
          definition_id: 'action:add-to-collection',
          selected_field: 'items',
          static_input: undefined,
        },
      },
    ]);
  });

  it('skips rows of an unrelated kind', () => {
    const reply = makeReply([{ kind: 'something-else', id: 'x', group: 'Media', label: 'X' }]);
    expect(readPaletteBulkActionDescriptorsFromReply(reply)).toEqual([]);
  });

  it('skips malformed rows missing dispatch fields', () => {
    const reply = makeReply([
      { kind: 'palette-bulk-action-descriptor', id: 'a', group: 'Media', label: 'A', dispatch: {} },
      {
        kind: 'palette-bulk-action-descriptor',
        id: 'b',
        group: 'Media',
        label: 'B',
        dispatch: { target: 'slot::workflow', definition_id: 'action:x' },
      },
    ]);
    expect(readPaletteBulkActionDescriptorsFromReply(reply)).toEqual([]);
  });

  it('skips rows missing id/group/label', () => {
    const reply = makeReply([
      {
        kind: 'palette-bulk-action-descriptor',
        group: 'Media',
        label: 'A',
        dispatch: { target: 't', definition_id: 'd', selected_field: 's' },
      },
    ]);
    expect(readPaletteBulkActionDescriptorsFromReply(reply)).toEqual([]);
  });

  it('preserves a danger variant and static_input', () => {
    const reply = makeReply([
      {
        kind: 'palette-bulk-action-descriptor',
        id: 'delete',
        group: 'Media',
        label: 'Delete',
        variant: 'danger',
        dispatch: {
          target: 'slot::workflow',
          definition_id: 'action:delete-selected',
          selected_field: 'items',
          static_input: { confirm: true },
        },
      },
    ]);
    expect(readPaletteBulkActionDescriptorsFromReply(reply)[0]).toMatchObject({
      variant: 'danger',
      dispatch: expect.objectContaining({ static_input: { confirm: true } }),
    });
  });

  it('deletion test: a totally different domain (legal docs) decodes identically with zero code change', () => {
    const reply = makeReply([
      {
        kind: 'palette-bulk-action-descriptor',
        id: 'route-to-counsel',
        group: 'Contracts',
        label: 'Route to counsel',
        dispatch: {
          target: 'slot::workflow',
          definition_id: 'action:route-documents-to-counsel',
          selected_field: 'document_refs',
        },
      },
    ]);
    expect(readPaletteBulkActionDescriptorsFromReply(reply)).toEqual([
      {
        id: 'route-to-counsel',
        group: 'Contracts',
        label: 'Route to counsel',
        variant: 'default',
        dispatch: {
          target: 'slot::workflow',
          definition_id: 'action:route-documents-to-counsel',
          selected_field: 'document_refs',
          static_input: undefined,
        },
      },
    ]);
  });
});

describe('askPaletteBulkActionDescriptors', () => {
  it('returns an empty array without dispatching when no groups are requested', async () => {
    const descriptors = await askPaletteBulkActionDescriptors([]);
    expect(descriptors).toEqual([]);
    expect(sendRequestToBitfieldTarget).not.toHaveBeenCalled();
  });

  it('filters results to only the requested groups', async () => {
    sendRequestToBitfieldTarget.mockResolvedValueOnce(
      makeReply([
        {
          kind: 'palette-bulk-action-descriptor',
          id: 'add-to-collection',
          group: 'Media',
          label: 'Add to collection',
          dispatch: { target: 't', definition_id: 'd', selected_field: 's' },
        },
        {
          kind: 'palette-bulk-action-descriptor',
          id: 'move-to-folder',
          group: 'Local Files',
          label: 'Move to folder',
          dispatch: { target: 't', definition_id: 'd2', selected_field: 's' },
        },
      ]),
    );
    const descriptors = await askPaletteBulkActionDescriptors(['Media']);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].id).toBe('add-to-collection');
  });

  it('returns an empty array when the dispatch throws', async () => {
    sendRequestToBitfieldTarget.mockRejectedValueOnce(new Error('boom'));
    const descriptors = await askPaletteBulkActionDescriptors(['Media']);
    expect(descriptors).toEqual([]);
  });
});

describe('runPaletteBulkAction', () => {
  const descriptor: PaletteBulkActionDescriptor = {
    id: 'add-to-collection',
    group: 'Media',
    label: 'Add to collection',
    variant: 'default',
    dispatch: {
      target: 'slot::workflow',
      definition_id: 'action:add-to-collection',
      selected_field: 'items',
      static_input: { collection_id: 'abc' },
    },
  };

  it('merges static_input with the selected_field-keyed selection and dispatches', async () => {
    sendRequestToBitfieldTarget.mockResolvedValueOnce({});
    const outcome = await runPaletteBulkAction(descriptor, [{ id: '1' }, { id: '2' }]);
    expect(outcome).toEqual({ ok: true, error: null });
    expect(sendRequestToBitfieldTarget).toHaveBeenCalledWith({
      target: 'slot::workflow',
      payload: {
        operation: 'execute_definition',
        definition_id: 'action:add-to-collection',
        input: { collection_id: 'abc', items: [{ id: '1' }, { id: '2' }] },
      },
    });
  });

  it('returns a structured error when the dispatch fails', async () => {
    sendRequestToBitfieldTarget.mockRejectedValueOnce(new Error('dispatch failed'));
    const outcome = await runPaletteBulkAction(descriptor, []);
    expect(outcome).toEqual({ ok: false, error: 'dispatch failed' });
  });
});
