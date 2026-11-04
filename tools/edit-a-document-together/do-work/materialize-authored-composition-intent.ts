// packages/documents/do-work/materialize-authored-composition-intent.ts
//
// THE SUPERWEAPON PRIMITIVE (L069).
//
// Authoring is NOT four verbs (name / publish-surface / export-file / attach).
// It is ONE addressed **authored composition unit** (the block subtree the user
// named — the SSOT) plus N **data-described projection descriptors**, each run
// by a leaf capability that dispatches to the OWNING generic package by Envelope
// (surface → this package's placeable-surface; file → the file-output owner via
// `slot::workflow`; task-attachment → `visual-database`/`tasks` via payload.attachments).
//
// The handler resolves the unit ONCE, then looks the projection's runner up in an
// INJECTED capability map and runs it. The handler NEVER names 'surface'/'file'/
// 'task-attachment' — adding a projection (knowledge-records, publish, schedule)
// is a new DATA descriptor + a registered runner, ZERO handler change
// (enum-dissolution: self-describing data, generic handler dispatching through an
// owner-provided map; L090). This is why the same engine yields Notion features
// (databases, backlinks, exports, embeds) it was never coded for.

import { sendRequestToBitfieldTarget } from '#workspace-records';
import {
  authoredThingAddress,
  findSubtree,
  type AuthoredThingRecord,
} from '../read-data/authored-thing-refs';
import type { CompositionContent } from '../read-data/documents';
import {
  nameAuthoredThing,
  type BitfieldRequestSender,
} from './publish-authored-thing';
import type { TaskRecord } from './build-task-attachment-append';
import { defaultProjectionRunners } from './projection-runners-pack';

// The resolved, addressed authored composition unit every projection reads from.
export interface AuthoredCompositionUnit {
  readonly thing: AuthoredThingRecord;
  readonly subtree: NonNullable<ReturnType<typeof findSubtree>>;
  readonly content: CompositionContent;
  readonly address: string;
}

// A self-describing projection: `kind` selects the runner, the rest is its DATA.
export interface ProjectionDescriptor {
  readonly kind: string;
  readonly [param: string]: unknown;
}

export interface ProjectionContext {
  readonly partitionLabel: string;
  readonly sender: BitfieldRequestSender;
}

// The result any projection reports back. `kind` echoes the descriptor; the rest
// is the projection's own output (surface record, file artifact, attachments…).
export interface ProjectionResult {
  readonly kind: string;
  readonly [output: string]: unknown;
}

export type ProjectionRunner = (
  unit: AuthoredCompositionUnit,
  descriptor: ProjectionDescriptor,
  ctx: ProjectionContext,
) => Promise<ProjectionResult>;

export type ProjectionRunnerMap = Readonly<Record<string, ProjectionRunner>>;

// The concrete projection runners live in the leaf capability pack
// (`projection-runners-pack.ts`), OUTSIDE this generic core — the ONLY place
// projection kinds are named. Import it from there (mount/surface do); this core
// never re-exports or defaults to it.

// THE PRIMITIVE. Resolve the addressed authored composition unit once, then
// dispatch the projection to its runner. One path for every authoring output.
export async function materializeAuthoredCompositionIntent(input: {
  partitionLabel: string;
  content: CompositionContent;
  nodeId: string;
  title: string;
  projection: ProjectionDescriptor;
  // The injected capability map — REQUIRED. The generic core never names a
  // projection nor owns a default pack (enum-dissolution: the registry lives
  // OUTSIDE the core; composition wiring installs it). The mount/surface pass the
  // shipped `defaultProjectionRunners()` pack; another owner could pass another.
  runners: ProjectionRunnerMap;
  sender?: BitfieldRequestSender;
}): Promise<ProjectionResult> {
  const sender = input.sender ?? (sendRequestToBitfieldTarget as BitfieldRequestSender);
  const runner = input.runners[input.projection.kind];
  // Fail-closed: an unknown projection is never silently dropped (L117).
  if (!runner) throw new Error(`No projection runner for "${input.projection.kind}"`);

  // Resolve the addressed authored composition unit ONCE (name → SSOT record).
  const thing = await nameAuthoredThing({
    partitionLabel: input.partitionLabel,
    content: input.content,
    nodeId: input.nodeId,
    title: input.title,
    sender,
  });
  const subtree = findSubtree(input.content, input.nodeId);
  if (!subtree) throw new Error(`No item with id ${input.nodeId} exists in the current content`);
  const unit: AuthoredCompositionUnit = {
    thing,
    subtree,
    content: input.content,
    address: authoredThingAddress(thing.id),
  };
  return runner(unit, input.projection, { partitionLabel: input.partitionLabel, sender });
}

// Convenience wrapper: attach is just the `task-attachment` projection over the
// primitive. A CALLER (like the surface) that chooses the shipped pack — the
// generic dispatch above never references it.
export async function attachAuthoredThingToTask(input: {
  partitionLabel: string;
  content: CompositionContent;
  nodeId: string;
  title: string;
  taskRecord: TaskRecord;
  filePath?: string;
  sender?: BitfieldRequestSender;
}): Promise<{ thing: AuthoredThingRecord; attachments: readonly unknown[]; changed: boolean }> {
  if (!input.taskRecord?.address?.trim()) throw new Error('A task is needed before this can be attached');
  const result = await materializeAuthoredCompositionIntent({
    partitionLabel: input.partitionLabel,
    content: input.content,
    nodeId: input.nodeId,
    title: input.title,
    projection: {
      kind: 'task-attachment',
      taskRecord: input.taskRecord,
      ...(input.filePath ? { filePath: input.filePath } : {}),
    },
    runners: defaultProjectionRunners(),
    sender: input.sender,
  });
  return {
    thing: result.thing as AuthoredThingRecord,
    attachments: (result.attachments as readonly unknown[]) ?? [],
    changed: Boolean(result.changed),
  };
}

// Re-export the openable address so attach callers keep one import site.
export { authoredNoteSurfaceAddress } from './publish-authored-thing';
