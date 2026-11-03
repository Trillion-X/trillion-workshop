// tools/draw-a-change-as-a-diagram/do-work/layer-diagram.d.mts
// Types for layer-diagram.mjs, for TypeScript callers such as LayerDiagram.tsx.

export interface LayerDiagramPlacedMark { image: string | null; letters: string | null }
export interface LayerDiagramPlacedNode { id: string; label: string; detail: string | null; mark: LayerDiagramPlacedMark | null; tone: string | null; delta: string | null; min_height?: number; x: number; y: number; w: number; h: number }
export interface LayerDiagramPlacedEdge { from: string; to: string; tone: string | null; delta: string | null; label: string | null; d: string; label_x: number; label_y: number; label_w: number }
export interface LayerDiagramHead { id: string; label: string; x: number; y: number; w: number }
export interface LayerDiagramLayout {
  id: string; label: string; caption: string | null; orientation: 'across' | 'down'; width: number; height: number;
  heads: LayerDiagramHead[]; nodes: LayerDiagramPlacedNode[]; edges: LayerDiagramPlacedEdge[];
}
export interface LayerDiagramSpot { x: number; y: number; anchor: 'start' | 'middle'; lines: string[]; line_height: number }
export interface LayerDiagramNodeParts { mark: { size: number; x: number; y: number } | null; label: LayerDiagramSpot; detail: LayerDiagramSpot | null }
export interface LayerDiagramSpotBox { left: number; top: number; width: number; line_height: number; align: 'left' | 'center' }
export interface LayerDiagramAtlas {
  id: string; orientation: 'across' | 'down'; width: number; height: number;
  boxes: { id: string; role: 'heading' | 'node'; x: number; y: number; w: number; h: number }[];
  edges: { from: string; to: string; d: string; label_x: number; label_y: number }[];
}
export const NODE_TEXT: { across: { label: number; detail: number }; down: { label: number; detail: number } };
export function layerDiagramSpotBox(spot: LayerDiagramSpot, size: number, nodeW: number): LayerDiagramSpotBox;
export const HEAD_BOX: { above: number; height: number; pad_x: number };
export function diagramImageSrc(value: unknown): string | null;
export function layerDiagramParts(diagram: unknown): unknown;
export function layerDiagramAtlas(layout: LayerDiagramLayout): LayerDiagramAtlas;
export function layerDiagramLayout(diagram: unknown, orientation?: 'across' | 'down'): LayerDiagramLayout;
export function layerDiagramNodeParts(node: { w: number; h: number; label: string; mark: unknown; detail: string | null }, orientation: 'across' | 'down'): LayerDiagramNodeParts;
export function layerDiagramClass(base: string, tone: string | null): string;
export function layerDiagramHtml(diagram: unknown): string;
export const LAYER_DIAGRAM_CSS: string;
