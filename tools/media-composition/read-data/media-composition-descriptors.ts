import type { LayoutState, SplitTreeNode } from '@/packages/screen-arrangement/read-data/layout-types';

export type DescriptorLabel = {
  key: string;
  label: string;
};

export type MediaCompositionOwnerAliasDescriptor = {
  alias: string;
  ownerPackage: string;
  taskCode: string;
};

export type MediaCompositionActionDescriptor = {
  id: string;
  label: string;
  kind: 'edit-decision' | 'workflow-process' | 'record-write';
  action?: string;
  workflowDefinitionId?: string;
};

export const MEDIA_COMPOSITION_OWNER_ALIAS: MediaCompositionOwnerAliasDescriptor = {
  alias: 'media-editor',
  ownerPackage: 'media-composition',
  taskCode: 'CS-303',
};

export const ROLE_LABEL_DESCRIPTORS: readonly DescriptorLabel[] = [
  { key: 'recorded_files', label: 'Sources' },
  { key: 'source_files', label: 'Sources' },
  { key: 'results', label: 'Transcript' },
  { key: 'chapters', label: 'Chapters' },
  { key: 'claims', label: 'Findings' },
  { key: 'phases', label: 'Motion' },
  { key: 'alignments', label: 'Matches' },
  { key: 'clusters', label: 'People' },
  { key: 'matches', label: 'Matches' },
  { key: 'plans', label: 'Plans' },
  { key: 'render_manifests', label: 'Render plans' },
  { key: 'edit_decisions', label: 'Edits' },
  { key: 'markers', label: 'Markers' },
] as const;

export const KIND_LABEL_DESCRIPTORS: readonly DescriptorLabel[] = [
  { key: 'record-action-projection.record', label: 'Sources' },
  { key: 'audio-transcription.result', label: 'Transcript' },
  { key: 'media-analysis.chapter', label: 'Chapters' },
  { key: 'media-analysis.claim', label: 'Findings' },
  { key: 'motion-analysis.phase', label: 'Motion' },
  { key: 'motion-analysis.alignment', label: 'Matches' },
  { key: 'media-identity.cluster', label: 'People' },
  { key: 'media-identity.match', label: 'Identity matches' },
  { key: 'speech-generation.result', label: 'Voice' },
  { key: 'media-composition.plan', label: 'Plans' },
  { key: 'media-composition.render-manifest', label: 'Render plans' },
  { key: 'media-composition.edit-decision', label: 'Edits' },
  { key: 'media-composition.marker', label: 'Markers' },
] as const;

export const KIND_ITEM_LABEL_DESCRIPTORS: readonly DescriptorLabel[] = [
  { key: 'record-action-projection.record', label: 'Source' },
  { key: 'audio-transcription.result', label: 'Transcript' },
  { key: 'media-analysis.chapter', label: 'Chapter' },
  { key: 'media-analysis.claim', label: 'Finding' },
  { key: 'motion-analysis.phase', label: 'Motion' },
  { key: 'motion-analysis.alignment', label: 'Match' },
  { key: 'media-identity.cluster', label: 'Person' },
  { key: 'media-identity.match', label: 'Identity match' },
  { key: 'speech-generation.result', label: 'Voice' },
  { key: 'media-composition.plan', label: 'Plan' },
  { key: 'media-composition.render-manifest', label: 'Render plan' },
  { key: 'media-composition.edit-decision', label: 'Edit' },
  { key: 'media-composition.marker', label: 'Marker' },
] as const;

export const LANE_TONE_DESCRIPTORS: readonly DescriptorLabel[] = [
  { key: 'source', label: 'source' },
  { key: 'media', label: 'source' },
  { key: 'video', label: 'source' },
  { key: 'clip', label: 'source' },
  { key: 'file', label: 'source' },
  { key: 'audio', label: 'audio' },
  { key: 'transcript', label: 'audio' },
  { key: 'voice', label: 'audio' },
  { key: 'speech', label: 'audio' },
  { key: 'motion', label: 'motion' },
  { key: 'match', label: 'motion' },
  { key: 'analysis', label: 'analysis' },
  { key: 'chapter', label: 'analysis' },
  { key: 'finding', label: 'analysis' },
  { key: 'identity', label: 'identity' },
  { key: 'people', label: 'identity' },
  { key: 'output', label: 'output' },
  { key: 'render', label: 'output' },
  { key: 'plan', label: 'output' },
  { key: 'edit', label: 'output' },
] as const;

export const TONE_PALETTE = ['source', 'audio', 'motion', 'analysis', 'identity', 'output'] as const;

export const MEDIA_COMPOSITION_ACTIONS: readonly MediaCompositionActionDescriptor[] = [
  { id: 'media-composition.action.split', label: 'Split', kind: 'edit-decision', action: 'split' },
  { id: 'media-composition.action.trim', label: 'Trim', kind: 'edit-decision', action: 'trim' },
  { id: 'media-composition.action.move', label: 'Move', kind: 'edit-decision', action: 'move' },
  { id: 'media-composition.action.delete', label: 'Delete', kind: 'edit-decision', action: 'delete' },
  { id: 'media-composition.action.set-transform', label: 'Set transform', kind: 'edit-decision', action: 'set-transform' },
  { id: 'media-composition.action.editor.layers.adjustment', label: 'Add adjustment layer', kind: 'edit-decision', action: 'editor.layers.adjustment' },
  {
    id: 'media-composition.action.render',
    label: 'Render',
    kind: 'workflow-process',
    workflowDefinitionId: 'action:video-compose',
  },
  {
    id: 'media-composition.action.write-record',
    label: 'Save',
    kind: 'record-write',
    workflowDefinitionId: 'action:write-media-composition-record',
  },
] as const;

export const MEDIA_COMPOSITION_SURFACES = [
  { surface: 'choose-media', containerId: 'media-editor-source', groupId: 'media-editor-source-group', tabId: 'media-editor-source-tab', title: 'Choose media', icon: 'Plus', order: 0 },
  { surface: 'preview-media', containerId: 'media-editor-preview', groupId: 'media-editor-preview-group', tabId: 'media-editor-preview-tab', title: 'Preview media', icon: 'Play', order: 1 },
  { surface: 'edit-timeline', containerId: 'media-editor-timeline', groupId: 'media-editor-timeline-group', tabId: 'media-editor-timeline-tab', title: 'Edit timeline', icon: 'PanelBottom', order: 2 },
  { surface: 'change-media', containerId: 'media-editor-details', groupId: 'media-editor-details-group', tabId: 'media-editor-details-tab', title: 'Change media', icon: 'SlidersHorizontal', order: 3 },
  { surface: 'choose-tool', containerId: 'media-editor-tools', groupId: 'media-editor-tools-group', tabId: 'media-editor-tools-tab', title: 'Choose tool', icon: 'MousePointer2', order: 4 },
] as const;

export function labelLookup(descriptors: readonly DescriptorLabel[]): ReadonlyMap<string, string> {
  return new Map(descriptors.map((descriptor) => [descriptor.key, descriptor.label]));
}

function mediaSurfaceTab(surface: (typeof MEDIA_COMPOSITION_SURFACES)[number]) {
  return {
    id: surface.tabId,
    title: surface.title,
    target: null,
    packageEntry: { packageName: 'media-composition', entryName: 'media-composition' },
    materialTarget: 'media-composition',
    icon: surface.icon,
    closable: true,
    metadata: {
      placeable_surface_id: `media-composition.${surface.surface}`,
      placeable_surface_material_target: 'media-composition',
      surfaceInput: { media_surface: surface.surface },
    },
  };
}

export function mediaCompositionLayoutState(): LayoutState {
  const root = {
    kind: 'split',
    dir: 'row',
    children: [
      { kind: 'leaf', containerId: 'media-editor-source' },
      {
        kind: 'split',
        dir: 'column',
        children: [
          { kind: 'leaf', containerId: 'media-editor-preview' },
          { kind: 'leaf', containerId: 'media-editor-timeline' },
        ],
        sizes: [0.65, 0.35],
      },
      {
        kind: 'split',
        dir: 'column',
        children: [
          { kind: 'leaf', containerId: 'media-editor-tools' },
          { kind: 'leaf', containerId: 'media-editor-details' },
        ],
        sizes: [0.35, 0.65],
      },
    ],
    sizes: [0.24, 0.5, 0.26],
  } satisfies SplitTreeNode;

  return {
    containers: Object.fromEntries(
      MEDIA_COMPOSITION_SURFACES.map((surface) => [
        surface.containerId,
        { id: surface.containerId, groupId: surface.groupId },
      ]),
    ),
    tabGroups: Object.fromEntries(
      MEDIA_COMPOSITION_SURFACES.map((surface) => [
        surface.groupId,
        { tabIds: [surface.tabId], activeTabId: surface.tabId },
      ]),
    ),
    tabs: Object.fromEntries(
      MEDIA_COMPOSITION_SURFACES.map((surface) => [surface.tabId, mediaSurfaceTab(surface)]),
    ),
    layouts: [
      { type: 'tiled', root },
      {
        type: 'floating',
        containers: [
          { containerId: 'media-editor-source', x: 40, y: 64, w: 360, h: 620, z: 1 },
          { containerId: 'media-editor-preview', x: 420, y: 64, w: 760, h: 500, z: 3 },
          { containerId: 'media-editor-timeline', x: 420, y: 584, w: 760, h: 260, z: 4 },
          { containerId: 'media-editor-tools', x: 1200, y: 64, w: 360, h: 280, z: 2 },
          { containerId: 'media-editor-details', x: 1200, y: 364, w: 360, h: 480, z: 5 },
        ],
        camera: { scale: 1, tx: 0, ty: 0, min: 0.55, max: 1.75 },
      },
      { type: 'overlay', containers: [] },
    ],
    surface: 'grid',
    focusedContainerId: 'media-editor-preview',
    maximizedContainerId: null,
  };
}
