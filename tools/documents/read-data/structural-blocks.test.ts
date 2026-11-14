import { describe, expect, it } from '../../../test/vitest-shim.mjs';
import type { SceneNode } from './documents.ts';
import { applyScenePatches } from '../do-work/apply-scene-patches.ts';
import {
  makeStructuralListItem,
  nestIndentableBlock,
  outdentIndentableBlock,
  nestStructuralBlock,
  outdentStructuralBlock,
  structuralBodyContainer,
  structuralContinuation,
  structuralPrimaryContext,
  structuralizeListBlocks,
  unwrapStructuralListItem,
} from './structural-blocks.ts';
import { DEFAULT_STRUCTURAL_MATERIALS } from './default-structural-materials.ts';

const toggle = (id: string, title: string, placement?: 'body' | 'sibling'): SceneNode => ({
  id,
  kind: 'Container',
  props: { interaction: { structure: {
    primary_role: 'primary', body_role: 'body',
    ...(placement ? { enter_placement: placement } : {}),
    ...(placement === 'body' ? { enter_state: 'open' } : {}),
    continue_material_id: 'material:disclosure',
    continue_state: 'open', nestable: true,
  } } },
  fsm: { initial: 'open', states: { open: {}, closed: {} } },
  children: [
    { id: `${id}:header`, kind: 'Container', synthetic: true, children: [
      { id: `${id}:title`, kind: 'Text', props: { text: title, content_role: 'primary' }, children: [] },
    ] },
    { id: `${id}:body`, kind: 'Container', props: { content_role: 'body' }, children: [] },
  ],
});

const page = (...children: SceneNode[]): SceneNode => ({ id: 'page', kind: 'Container', children });

describe('DATA-described structural blocks', () => {
  it('all shipped disclosure variants provide the same generic structural contract', () => {
    const ids = ['block:toggle', 'block:toggle-h1', 'block:toggle-h2', 'block:toggle-h3'];
    for (const id of ids) {
      const material = DEFAULT_STRUCTURAL_MATERIALS.find(candidate => candidate.id === id);
      const owner = material?.node;
      expect(owner).toBeDefined();
      expect(owner?.props?.interaction).toMatchObject({ structure: {
        primary_role: 'primary', body_role: 'body', continue_material_id: id,
        continue_state: 'open', enter_placement: 'body', enter_state: 'open', nestable: true,
      } });
    }
  });

  it('resolves continuation material and open state from the structural owner', () => {
    const first = toggle('first', 'Title');
    const tree = page(first);
    expect(structuralPrimaryContext(tree, 'first:title')?.owner.id).toBe('first');
    expect(structuralContinuation(tree, 'first:title')).toMatchObject({
      owner: { id: 'first' }, parentId: 'page', index: 0,
      placement: 'sibling', materialId: 'material:disclosure', state: 'open',
    });
    expect(structuralContinuation(tree, 'first:body')).toBeNull();
  });

  it('resolves body placement and the state to open from DATA', () => {
    const first = toggle('first', 'Title', 'body');
    const tree = page(first);
    expect(structuralBodyContainer(first)?.id).toBe('first:body');
    expect(structuralContinuation(tree, 'first:title')).toMatchObject({
      owner: { id: 'first' }, placement: 'body', bodyId: 'first:body', state: 'open',
    });
  });

  it('does not treat body text with the primary role as the structural title', () => {
    const first = toggle('first', 'Title', 'body');
    first.children![1].children = [{ id: 'ordinary-primary', kind: 'Text', props: { text: 'Body', content_role: 'primary' } }];
    expect(structuralPrimaryContext(page(first), 'ordinary-primary')).toBeNull();
    expect(structuralContinuation(page(first), 'ordinary-primary')).toBeNull();
    expect(structuralContinuation(page(first), 'first:title')?.bodyId).toBe('first:body');
  });

  it('nests a whole eligible block under the prior structural sibling body', () => {
    const first = toggle('first', 'First');
    const second = toggle('second', 'Second');
    const tree = page(first, second);
    expect(nestStructuralBlock(tree, 'second:title')).toEqual({
      type: 'MOVE_NODE', node_id: 'second', new_parent_id: 'first:body', new_index: 0,
    });
  });

  it('outdents a nested block after its owning structural sibling', () => {
    const first = toggle('first', 'First');
    const second = toggle('second', 'Second');
    first.children![1].children = [second];
    const tree = page(first, toggle('third', 'Third'));
    expect(outdentStructuralBlock(tree, 'second:title')).toEqual({
      type: 'MOVE_NODE', node_id: 'second', new_parent_id: 'page', new_index: 1,
    });
    expect(nestStructuralBlock(tree, 'first:title')).toBeNull();
  });

  it('lazily wraps flat list rows, moves the original text node, and outdents in sibling order', () => {
    let next = 0;
    const mint = () => `generated:${++next}`;
    const first: SceneNode = { id: 'first', kind: 'Text', props: { text: '•  parent', made_by_shortcut: 'shortcut:bullet-dash' }, children: [] };
    const second: SceneNode = { id: 'second', kind: 'Text', props: { text: '☐  child', made_by_shortcut: 'shortcut:todo-done', checked: true, indent_level: 1 }, children: [] };
    const after: SceneNode = { id: 'after', kind: 'Text', props: { text: 'following' }, children: [] };
    const original = page(first, second, after);
    const shortcutIds = new Set(['shortcut:bullet-dash', 'shortcut:todo-done']);

    const plan = nestIndentableBlock(original, 'second', shortcutIds, mint);
    expect(plan.handled).toBe(true);
    const nested = applyScenePatches(original, plan.patches)!;
    expect((nested.children ?? []).map(node => node.id)).toEqual(['generated:1', 'after']);
    const firstOwner = (nested.children ?? [])[0];
    const firstPrimary = firstOwner.children?.find(node => node.id === 'first');
    const firstBody = firstOwner.children?.find(node => node.props?.content_role === 'body');
    expect(firstPrimary?.props?.text).toBe('•  parent');
    expect(firstBody?.children?.map(node => node.id)).toEqual(['generated:3']);
    const childOwner = firstBody!.children![0];
    const childPrimary = childOwner.children?.find(node => node.id === 'second');
    expect(childPrimary?.props).toMatchObject({ text: '☐  child', made_by_shortcut: 'shortcut:todo-done', checked: true, indent_level: null });
    expect(structuralPrimaryContext(nested, 'second')?.owner.id).toBe('generated:3');

    const outdent = outdentStructuralBlock(nested, 'second');
    expect(outdent).toEqual({ type: 'MOVE_NODE', node_id: 'generated:3', new_parent_id: 'page', new_index: 1 });
    const restored = applyScenePatches(nested, [outdent!])!;
    expect((restored.children ?? []).map(node => node.id)).toEqual(['generated:1', 'generated:3', 'after']);
    expect(findPrimaryText(restored, 'second')?.props?.text).toBe('☐  child');
  });

  it('does not nest across an intervening non-list sibling', () => {
    let next = 0;
    const original = page(
      { id: 'list-a', kind: 'Text', props: { text: '• a', made_by_shortcut: 'bullet' }, children: [] },
      { id: 'paragraph', kind: 'Text', props: { text: 'plain text' }, children: [] },
      { id: 'list-b', kind: 'Text', props: { text: '• b', made_by_shortcut: 'bullet' }, children: [] },
    );
    const plan = nestIndentableBlock(original, 'list-b', new Set(['bullet']), () => `generated:${++next}`);
    expect(plan).toEqual({ handled: true, patches: [] });
  });

  it('pasted list indentation becomes bounded nested containers and keeps every text identity', () => {
    let next = 0;
    const mint = () => `paste:${++next}`;
    const flat = [0, 1, 2].map((indent, index): SceneNode => ({
      id: `line:${index}`, kind: 'Text', props: { text: `•  line ${index}`, made_by_shortcut: 'bullet', indent_level: indent }, children: [],
    }));
    flat.push({ id: 'paragraph', kind: 'Text', props: { text: 'after' }, children: [] });
    const nested = structuralizeListBlocks(flat, new Set(['bullet']), mint);
    expect(nested.map(node => node.id)).toEqual(['paste:1', 'paragraph']);
    const levelOne = nested[0].children?.find(node => node.props?.content_role === 'body')?.children?.[0];
    const levelTwo = levelOne?.children?.find(node => node.props?.content_role === 'body')?.children?.[0];
    expect(levelOne?.children?.find(node => node.id === 'line:1')?.props?.text).toBe('•  line 1');
    expect(levelTwo?.children?.find(node => node.id === 'line:2')?.props?.text).toBe('•  line 2');
  });

  it('outdents an unwrapped continued list row from a parent body without losing its text id', () => {
    let next = 0;
    const parent = { id: 'parent', kind: 'Text', props: { text: '• parent', made_by_shortcut: 'bullet' }, children: [] } as SceneNode;
    const owner = makeStructuralListItem(parent, { owner: 'owner', body: 'body' });
    const child: SceneNode = { id: 'continued', kind: 'Text', props: { text: '• continued', made_by_shortcut: 'bullet' }, children: [] };
    owner.children!.find(node => node.props?.content_role === 'body')!.children = [child];
    const original = page(owner, { id: 'after', kind: 'Text', props: { text: 'following' }, children: [] });
    const plan = outdentIndentableBlock(original, 'continued', new Set(['bullet']), () => `generated:${++next}`);
    expect(plan.handled).toBe(true);
    const nested = applyScenePatches(original, plan.patches)!;
    expect((nested.children ?? []).map(node => node.id)).toEqual(['owner', 'generated:1', 'after']);
    expect(findPrimaryText(nested, 'continued')?.props?.text).toBe('• continued');
    expect(structuralPrimaryContext(nested, 'continued')?.owner.id).toBe('generated:1');
  });

  it('exits an empty list item by unwrapping it and retaining nested child blocks', () => {
    const primary: SceneNode = { id: 'empty', kind: 'Text', props: { text: '', made_by_shortcut: 'bullet' }, children: [] };
    const owner = makeStructuralListItem(primary, { owner: 'owner', body: 'body' });
    const nestedChild: SceneNode = { id: 'nested-child', kind: 'Text', props: { text: '• child', made_by_shortcut: 'bullet' }, children: [] };
    owner.children!.find(node => node.props?.content_role === 'body')!.children = [nestedChild];
    const original = page(owner, { id: 'after', kind: 'Text', props: { text: 'following' }, children: [] });
    const patches = unwrapStructuralListItem(original, 'empty');
    expect(patches).not.toBeNull();
    const unwrapped = applyScenePatches(original, patches!)!;
    expect((unwrapped.children ?? []).map(node => node.id)).toEqual(['empty', 'nested-child', 'after']);
    expect(unwrapped.children?.[0].props).toMatchObject({ text: '', made_by_shortcut: null, content_role: null });
    expect(findPrimaryText(unwrapped, 'nested-child')?.props?.text).toBe('• child');
  });
});

function findPrimaryText(root: SceneNode, id: string): SceneNode | null {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findPrimaryText(child, id);
    if (found) return found;
  }
  return null;
}
