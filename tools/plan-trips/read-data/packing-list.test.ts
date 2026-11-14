// package-set://bitfield-studio/packages/packing-list/read-data/packing-list.test.ts

import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { buildPackingOperations, decodePackingList, itemsByCategory, packingProgress } from './packing-list.ts';

describe('packing-list package code', () => {
  it('groups items and computes packing progress', () => {
    const list = decodePackingList({
      id: 'list:1',
      name: 'Trip packing',
      items: [
        { id: 'item:1', listId: 'list:1', label: 'Shoes', category: 'clothes', status: 'packed', quantity: { count: 1 } },
        { id: 'item:2', listId: 'list:1', label: 'Coat', category: 'clothes', status: 'planned', quantity: { count: 1 } },
      ],
    });

    expect(packingProgress(list)).toEqual({ packed: 1, total: 2, ratio: 0.5 });
    expect(itemsByCategory(list).clothes).toHaveLength(2);
  });

  it('decodes containers and dependencies into owner-produced operation records', () => {
    const list = decodePackingList({
      id: 'list:1',
      trip_ref: 'trip:1',
      name: 'Trip packing',
      containers: [{ id: 'bag:1', label: 'Carry on' }],
      dependencies: [{ id: 'dep:1', item_ref: 'item:2', depends_on_ref: 'item:1', reason: 'Pack passport first' }],
      items: [
        { id: 'item:1', list_id: 'list:1', label: 'Passport', category: 'Documents', status: 'packed', quantity: { count: 1 }, container_ref: 'bag:1' },
        { id: 'item:2', list_id: 'list:1', label: 'Rain shell', category: 'Clothes', status: 'missing', quantity: { count: 1 }, dependency_refs: ['dep:manual'] },
      ],
    });

    const operations = buildPackingOperations(list);
    const missing = operations.find((operation) => operation.source.id === 'item:2');
    expect(list.containers[0]?.id).toBe('bag:1');
    expect(missing?.priority).toBe('high');
    expect(missing?.dependencyRefs).toEqual(['dep:manual', 'item:1']);
    expect(missing?.transitions[0]?.actionDefinitionId).toBe('action:packing-list:update-status');
  });
});
