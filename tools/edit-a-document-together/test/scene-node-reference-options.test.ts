import { describe, expect, it } from './vitest-shim.mjs';
import { sceneNodeReferenceOptions, sceneNodeReferenceSource } from '../read-data/scene-node-reference-options.ts';

describe('scene node reference options', () => {
  const source = {
    source_type: 'scene_nodes',
    node_scope: 'root_children',
    kind: 'document-page',
    group: 'Pages',
    icon: 'FileText',
    label_path: 'label',
    value_path: 'id',
    limit: 2,
  } as const;

  it('uses the unique DATA source and emits stable node IDs with query and cap', () => {
    expect(sceneNodeReferenceSource([source])).toEqual(source);
    expect(sceneNodeReferenceSource([source, { ...source }])).toBeNull();
    expect(sceneNodeReferenceOptions(source, [
      { id: 'page-a', label: 'Overview' },
      { id: 'page-b', label: 'Planning' },
      { id: 'page-c', label: 'Plan archive' },
    ], 'plan')).toEqual([
      { value: 'page-b', label: 'Planning', kind: 'document-page', group: 'Pages', icon: 'FileText' },
      { value: 'page-c', label: 'Plan archive', kind: 'document-page', group: 'Pages', icon: 'FileText' },
    ]);
  });

  it('deduplicates identities and ignores invalid node labels or IDs', () => {
    expect(sceneNodeReferenceOptions(source, [
      { id: 'page-a', label: 'Page A' },
      { id: 'page-a', label: 'Duplicate' },
      { id: '', label: 'No identity' },
      { id: 'page-b', label: '' },
    ], '')).toEqual([
      { value: 'page-a', label: 'Page A', kind: 'document-page', group: 'Pages', icon: 'FileText' },
    ]);
  });
});
