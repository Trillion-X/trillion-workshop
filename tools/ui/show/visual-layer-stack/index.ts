// packages/ui/show/visual-layer-stack/index.ts
//
// Public surface of the Region Visual Layer Stack primitive.

export { VisualLayerStack } from './VisualLayerStack';
export type { VisualLayerStackProps } from './VisualLayerStack';
export {
  LayerStackEditor,
  addLayer,
  removeLayer,
  reorderLayers,
  patchLayerInput,
  setLayerOpacity,
  setLayerEnabled,
  setLayerClip,
  patchLayerClipInput,
  addOptionsFromCapabilities,
  geometryOperatorIds,
  nextLayerId,
} from './LayerStackEditor';
export type { LayerStackEditorProps, FrameDef } from './LayerStackEditor';
export { readFrameBorder } from './frame-border';
export type { FrameBorder, FrameBorderSpec } from './frame-border';
export { composeStackTextStyle } from './compose-text-style';
export { createCapabilityMap } from './visual-layer-registry';
export type {
  VisualLayerCapability,
  VisualLayerCapabilityMap,
  VisualLayerRenderContext,
} from './visual-layer-registry';
export { builtinVisualLayerCapabilities } from './capabilities/builtin';
export {
  isVisualLayerStackRecord,
} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/visual-layer-types.ts';
export type {
  AddressRef,
  CapabilityRef,
  CapabilityInvocation,
  VisualLayerDescriptor,
  VisualLayerStackRecord,
  VisualLayerOrder,
  VisualLayerFrame,
  VisualLayerComposite,
} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/visual-layer-types.ts';
