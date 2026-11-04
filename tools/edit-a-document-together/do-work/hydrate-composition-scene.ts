import { repairOwnedFsmBindings } from '../read-data/interaction-events';
import { decodeCompositionSnapshotReply } from './send-composition-transaction';
import { normalizeAuthoredDocument } from '../read-data/normalize-authored-document';
import {
  definitionsMapFrom,
  instanceRootsFrom,
  resolveComponentInstances,
  type ComponentDefinitionRecord,
} from '../read-data/resolve-component-instances';
import type {
  CompositionContent,
  CompositionSnapshot,
  CompositionTransaction,
  EdgeConnection,
  SceneNode,
  Viewport,
} from '../read-data/documents';

export type HydratedCompositionScene = {
  snapshot: CompositionSnapshot;
  authoredRoot: SceneNode;
  authoredEdges: EdgeConnection[];
  definitions: ComponentDefinitionRecord[];
  definitionsById: Map<string, SceneNode>;
  instanceRoots: Map<string, string>;
};

type HydrateCompositionSceneArgs = {
  content: CompositionContent | null;
  session: string;
  viewport: Viewport;
  sendTransaction: (transaction: CompositionTransaction) => Promise<unknown>;
  transformChildren?: (children: SceneNode[]) => SceneNode[];
};

/**
 * The single document -> composition-engine hydration boundary used by authoring
 * and rendered scenes. React never invents frames or edge routes: it hands one
 * normalized, component-resolved scene to the isolated kernel session and renders
 * the returned snapshot.
 */
export async function hydrateCompositionScene({
  content,
  session,
  viewport,
  sendTransaction,
  transformChildren = (children) => children,
}: HydrateCompositionSceneArgs): Promise<HydratedCompositionScene> {
  const source = content ?? { children: [] };
  const rootId = 'root';
  const pre = normalizeAuthoredDocument(source.children, source.edges, { rootId });
  const definitions = source.definitions ?? [];
  const definitionsById = definitionsMapFrom(definitions);
  const authoredRoot: SceneNode = {
    id: 'composition-root',
    kind: 'Container',
    props: {},
    visible: true,
    children: pre.children,
  };

  let resolvedChildren = pre.children;
  try {
    resolvedChildren = resolveComponentInstances(authoredRoot, definitionsById)?.children ?? pre.children;
  } catch {
    // A malformed component reference cannot brick the whole document. The
    // authored nodes remain renderable and the final normalizer removes any
    // invalid/dangling topology before the kernel sees it.
  }

  const transformed = transformChildren(resolvedChildren);
  const post = normalizeAuthoredDocument(transformed, pre.edges, { rootId });
  const scene: SceneNode = repairOwnedFsmBindings({
    id: rootId,
    kind: 'Container',
    props: {},
    visible: true,
    children: post.children,
  });
  const snapshot = await decodeCompositionSnapshotReply(await sendTransaction({
    session,
    set_scene: scene,
    set_edges: post.edges,
    camera: source.camera ?? { pan_x: 0, pan_y: 0, zoom: 1 },
    viewport,
  }));

  return {
    snapshot,
    authoredRoot,
    authoredEdges: post.edges,
    definitions,
    definitionsById,
    instanceRoots: instanceRootsFrom(authoredRoot),
  };
}
